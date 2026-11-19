import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { withFileNames } from "../asking.js";
import type { NewFile } from "../attachments.js";
import type { AgentConfig } from "../config.js";
import { beijingDay, nameFrom } from "../groups.js";
import { isEffort, type Effort } from "../models.js";
import { cjk } from "../text.js";
import {
  ALL,
  GROUP_ACT_ROUNDS,
  type Group,
  type GroupAct,
  type GroupDetail,
  type GroupEvent,
  type GroupInvite,
  type GroupMember,
  type GroupMessage,
  type GroupSummary,
  type GroupTarget,
  type GroupWork,
  quotaLowAt,
  type ReceiptState,
  todayTotal,
  type UnseenGroup,
} from "../types.js";
import { GroupStore, type InviteRow, type MemberRow, type StoredReceipt } from "./group-store.js";
import { checkAttachments, RelayError } from "./service.js";
import type { Store } from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// The numbers of 8n, in one place.
export const GROUP_LIMITS = {
  maxMembers: 100,
  // 每天次数: each wake uses one, answered or not.
  quota: 30,
  maxQuota: 500,
  // What a member sees from before it joined, and what a new background session reads.
  seeBefore: 20,
  // The most a session that goes on is given at once.
  readCap: 50,
  // The most messages a page or tool is given at once.
  detailCap: 200,
  inviteTtlMs: 7 * DAY_MS,
  // An @ missed while the computer was off, or kept for 每天次数, is taken up within this.
  catchUpMs: DAY_MS,
};

export const GROUPS_NEED_ACCOUNT = "登录 Achat 账号后才能用群。先调用 link_account，让主人登录并确认添加这台电脑";

// What 叫停 and 解散 stop: what is being read, what waits for a computer or
// for 每天次数, and 动手 waiting for its person or under way.
const STOPPABLE: ReceiptState[] = ["reading", "offline", "quota", "asking", "acting"];

// Who is who, for groups: the accounts database in the cloud.
export interface GroupDirectory {
  // An AI, or a person's seat, that can take part now, named from `viewer`'s
  // side; undefined once removed.
  agent(id: string, viewer?: string): AgentConfig | undefined;
  // Any AI or seat there ever was, for the names of old messages.
  name(id: string, viewer?: string): string;
  friends(account: string, other: string): boolean;
  // Its computer has its event stream open.
  online(agent: string): boolean;
  // The person's seat: what they write as on the web page.
  seat(account: string): string;
  // "我" for the viewer themself, the person's name otherwise.
  person(account: string, viewer: string): string;
}

// Who calls, from the API's Viewer.
export interface Caller {
  account: string;
  // The person on the web page: their seat. Null for computers and AIs.
  person: string | null;
  actsAs(agent: string): boolean;
  // Not an AI's pasted credential.
  approves: boolean;
}

export interface GroupPostInput {
  from: string;
  body: string;
  mentions?: string[];
  files?: NewFile[];
  // A background answer: the message whose @ woke it, the 叫停 count then,
  // its session and how far it read.
  replyTo?: number;
  epoch?: number;
  sessionId?: string;
  readTo?: number;
  costUsd?: number;
  redactions?: number;
  model?: string;
  effort?: Effort;
}

// Owns the group rules, as RelayService owns the thread ones: the API, the
// computers and the AI tools all go through here.
export class GroupService {
  readonly store: GroupStore;
  private events = new EventEmitter();
  // AIs a wake just brought near today's 每天次数, told of by the emit after
  // its change; dropped when the change is undone (transaction).
  private low: { groupId: string; agent: string }[] = [];

  constructor(
    store: Store,
    private dir: GroupDirectory,
    private now: () => Date = () => new Date(),
    private limits = GROUP_LIMITS,
  ) {
    this.store = new GroupStore(store);
    this.events.setMaxListeners(0);
  }

  onEvent(listener: (e: GroupEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  // An event for everyone in the group and those invited. `also`: AIs or
  // seats that just left its audience, who hear this one too. The AIs a wake
  // before it brought near today's 每天次数 are told of after it.
  private emit(type: GroupEvent["type"], groupId: string, extra: { seq?: number; wake?: string[] } = {}, also: string[] = []): void {
    const members = new Set([
      ...this.store.members(groupId).map((m) => m.agent),
      ...this.store.openInvites(groupId, this.stamp()).map((i) => this.dir.seat(i.account)),
      ...also,
    ]);
    this.tell(type, groupId, [...members], extra);
    for (const low of this.low.splice(0)) this.tell("group.quotaLow", low.groupId, [low.agent]);
  }

  // An event for `members` alone, such as the one AI near its 每天次数 or the
  // person their AI @ed.
  private tell(type: GroupEvent["type"], groupId: string, members: string[], extra: { seq?: number; wake?: string[] } = {}): void {
    const event: GroupEvent = { type, groupId, members, ...(extra.seq !== undefined ? { seq: extra.seq } : {}), ...(extra.wake?.length ? { wake: extra.wake } : {}) };
    this.events.emit("event", event);
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  // A change to a group, all or nothing. Undone, the AIs it brought near
  // their 每天次数 are not told of: marking them told was undone with it.
  private transaction<T>(fn: () => T): T {
    const low = this.low.length;
    try {
      return this.store.transaction(fn);
    } catch (err) {
      this.low.length = low;
      throw err;
    }
  }

  // An AI or a person's seat, named from `viewer`'s side (from nobody's by default).
  private nameFor(id: string, viewer = ""): string {
    return this.dir.agent(id, viewer)?.name ?? this.dir.name(id, viewer);
  }

  private requireGroup(id: string): Group {
    const group = this.store.group(id);
    if (!group) throw new RelayError(404, "找不到这个群");
    return group;
  }

  // The caller's AIs in the group now.
  private mine(caller: Caller, groupId: string): MemberRow[] {
    return this.store.members(groupId).filter((m) => m.owner === caller.account);
  }

  // A group the caller has an AI in; any other looks like one that does not exist.
  private requireMine(caller: Caller, id: string): Group {
    const group = this.requireGroup(id);
    if (!this.mine(caller, id).length) throw new RelayError(404, "找不到这个群");
    return group;
  }

  private requireOpen(group: Group): void {
    if (group.status === "dissolved") throw new RelayError(409, "群已经解散了，只能看不能发");
  }

  // Who speaks: one of the caller's AIs, or the person on the web page.
  private requireSpeaker(caller: Caller, from: string): AgentConfig {
    const agent = this.dir.agent(from);
    if (!agent || (!caller.actsAs(from) && from !== caller.person)) throw new RelayError(403, "只能以自己的 AI 或本人的身份说话");
    return agent;
  }

  private checkQuota(perDay: number | undefined): number {
    const quota = perDay === undefined ? this.limits.quota : Math.round(perDay);
    if (!Number.isFinite(quota) || quota < 1 || quota > this.limits.maxQuota) throw new RelayError(400, `每天次数需要在 1 到 ${this.limits.maxQuota} 之间`);
    return quota;
  }

  private requireFriend(caller: Caller, account: string): void {
    if (!this.dir.friends(caller.account, account)) {
      throw new RelayError(403, `${this.dir.person(account, caller.account)}还不是你的朋友。先用 create_invite 加对方为朋友`);
    }
  }

  // The caller's own AIs join at once; a friend's AI, or a friend who picks
  // their AIs, is invited.
  private sort(caller: Caller, targets: GroupTarget[]): { join: string[]; invite: { account: string; agent: string | null }[] } {
    const join: string[] = [];
    const invite: { account: string; agent: string | null }[] = [];
    for (const t of targets) {
      if ("agent" in t) {
        const a = this.dir.agent(t.agent);
        if (!a || a.client === "person" || !a.owner) throw new RelayError(404, "找不到这个 AI，可能对方已经移除了它");
        if (a.owner === caller.account) {
          if (!join.includes(a.id)) join.push(a.id);
          continue;
        }
        this.requireFriend(caller, a.owner);
        invite.push({ account: a.owner, agent: a.id });
      } else {
        if (t.account === caller.account) throw new RelayError(400, "拉自己的 AI 进群，直接选那个 AI");
        this.requireFriend(caller, t.account);
        invite.push({ account: t.account, agent: null });
      }
    }
    return { join, invite };
  }

  // An invite to a person, or one waiting already, made new for another 7
  // days. A person has one invite card: one that lets them pick covers any of
  // their AIs, and asking them to pick while an AI of theirs is asked for by
  // name waits on that one. Another AI by name is its own invite, on the
  // same card until they are in (see card), a tile in 群设置 after. True
  // for a new invite, false for one made new again.
  private offer(groupId: string, t: { account: string; agent: string | null }, by: string, now: string): boolean {
    const expiresAt = new Date(this.now().getTime() + this.limits.inviteTtlMs).toISOString();
    const theirs = this.store.openInvites(groupId, now).filter((i) => i.account === t.account);
    const open = theirs.find((i) => i.agent === null || i.agent === t.agent) ?? (t.agent === null ? theirs[0] : undefined);
    if (open) {
      this.store.renewInvite(open.id, expiresAt);
      return false;
    }
    this.store.addInvite({ id: `gi_${randomBytes(6).toString("hex")}`, groupId, account: t.account, agent: t.agent, invitedBy: by, expiresAt }, now);
    return true;
  }

  // Each person not yet in with a new invite hears of it alone, on the page,
  // their computer and by email, once however many of their AIs it asks for.
  private tellInvited(groupId: string, accounts: string[]): void {
    for (const account of new Set(accounts)) this.tell("group.invited", groupId, [this.dir.seat(account)]);
  }

  // What becomes of an AI a message calls on: not woken while 叫停, nor one
  // that cannot answer in the background, nor past its 每天次数, nor while
  // its computer is off.
  private stateFor(group: Group, member: MemberRow, day: string): ReceiptState {
    // 叫停, or dissolved: nobody is woken.
    if (group.status !== "open") return "stopped";
    const agent = this.dir.agent(member.agent);
    if (!agent || agent.canReceive === false) return "cannot";
    const { used, extra } = this.store.usage(group.id, member.agent, day);
    if (used >= todayTotal({ quota: member.quota, extraToday: extra })) return "quota";
    if (!this.dir.online(member.agent)) return "offline";
    return "reading";
  }

  // Records what became of each of `agents` for message `seq`; a wake uses
  // one of its 每天次数. One that leaves it 5 or fewer (1 when it is under
  // 10 a day) has its person told, once a day (see emit). Returns the AIs woken.
  private wakeAgents(group: Group, seq: number, agents: string[], now: string): string[] {
    const day = beijingDay(this.now());
    const woken: string[] = [];
    for (const agent of agents) {
      const member = this.store.member(group.id, agent);
      if (!member || member.leftAt) continue;
      const state = this.stateFor(group, member, day);
      this.store.setReceipt(group.id, seq, agent, state, null, group.epoch, now);
      if (state !== "reading") continue;
      this.store.use(group.id, agent, day);
      woken.push(agent);
      const { used, extra } = this.store.usage(group.id, agent, day);
      const left = todayTotal({ quota: member.quota, extraToday: extra }) - used;
      if (left > 0 && left <= quotaLowAt(member.quota) && this.store.warn(group.id, agent, day)) this.low.push({ groupId: group.id, agent });
    }
    return woken;
  }

  // Whom a message calls on: everyone but the sender for @所有人, else the
  // AIs named. A person's seat is told in plan 4, never woken.
  private wake(group: Group, msg: GroupMessage, sender: string): string[] {
    const members = this.store.members(group.id);
    const targets = msg.mentions.includes(ALL)
      ? members.map((m) => m.agent).filter((a) => a !== sender)
      : msg.mentions.filter((a) => members.some((m) => m.agent === a));
    return this.wakeAgents(group, msg.seq, targets, this.stamp());
  }

  // Mentions as sent: AIs in the group, ALL, and for an AI, its own person's seat.
  // `answering`: a background answer written while the group changed, so an AI
  // that left meanwhile is dropped, not an error nobody can act on.
  private checkMentions(groupId: string, from: AgentConfig, raw: string[], answering = false): string[] {
    const members = this.store.members(groupId);
    const out: string[] = [];
    for (const m of raw) {
      if (out.includes(m)) continue;
      if (m === ALL || members.some((x) => x.agent === m && x.agent !== from.id)) {
        out.push(m);
        continue;
      }
      if (m === from.id) throw new RelayError(400, "不能 @ 自己");
      if (from.client !== "person" && from.owner && m === this.dir.seat(from.owner)) {
        out.push(m);
        continue;
      }
      if (answering) continue;
      // Named from the sender's owner's side, never by id: an AI not in the group, or someone who is not an AI.
      const other = this.dir.agent(m, from.owner ?? "");
      if (other && other.client !== "person") throw new RelayError(400, cjk(other.name, "不在群里，只能 @ 群里的 AI"));
      throw new RelayError(400, `只能 @ 群里的 AI${from.client === "person" ? "" : "，或者自己的主人"}`);
    }
    return out;
  }

  // A background answer to what woke it, or 动手's result for a request under
  // way; refused once the group was 叫停 since.
  private requireReading(group: Group, agent: string, seq: number, epoch: number | undefined): void {
    const r = this.store.receipt(group.id, seq, agent);
    const waiting = r?.state === "reading" || r?.state === "acting";
    if (r?.state === "stopped" || (waiting && (group.status !== "open" || epoch !== group.epoch))) {
      throw new RelayError(409, "群里已经叫停了，这次回答不再发出");
    }
    if (!waiting) throw new RelayError(409, "这条已经不用回了");
  }

  // What a message with reply_to may answer: a background answer, which says
  // its session, what woke it; one from the front (MCP's send_group_message),
  // only 动手 under way, whose result it sends back. Otherwise the front
  // would settle what the background is reading, and that answer would be
  // refused.
  private requireAnswering(group: Group, agent: string, input: GroupPostInput): void {
    const r = this.store.receipt(group.id, input.replyTo!, agent);
    const waiting = !r || (["reading", "offline", "quota", "asking"] as ReceiptState[]).includes(r.state);
    if (input.sessionId === undefined && waiting) throw new RelayError(400, "reply_to 只用来发回动手的结果");
    this.requireReading(group, agent, input.replyTo!, input.epoch);
  }

  // The AI is done with what woke it, up to `seq`: every @ still waiting on
  // it there ends the same way, those it had to leave while its computer was
  // off or its 每天次数 ran out too (within a day), since this answer read
  // them, the reason only under the one it answers; and its
  // session goes on from what it read. 动手's result, for a request under
  // way, answers the requests of that act up to it instead: an @ the
  // background is reading is still to be answered, and the background
  // session read none of the work.
  private settle(groupId: string, agent: string, seq: number, state: ReceiptState, reason: string | null, input: { sessionId?: string; readTo?: number }, now: string): void {
    const since = this.now().getTime() - this.limits.catchUpMs;
    const result = this.store.receipt(groupId, seq, agent)?.state === "acting";
    const waiting = result
      ? this.askedBy(groupId, agent, this.store.message(groupId, seq)?.sender, "acting")
      : this.store.receiptsOf(groupId, agent, ["reading", "offline", "quota"]);
    for (const r of waiting) {
      // What was left over a day ago was never going to be taken up (更早的不补): still 不在线.
      if (r.seq > seq || ((r.state === "offline" || r.state === "quota") && Date.parse(r.updatedAt) < since)) continue;
      this.store.setReceipt(groupId, r.seq, agent, state, r.seq === seq ? reason : null, r.epoch, now);
    }
    if (!result) this.store.setRead(groupId, agent, input.readTo ?? seq, input.sessionId ?? null);
  }

  // The newest @ an AI had to leave for `states` (its computer off, its 每天次数
  // used up), after what it already finished and within a day: woken for it
  // now, if it can be. Not when it was woken since for a newer one: answering
  // that answers this too (settle), so it is neither woken nor charged twice.
  // Returns the AIs woken.
  private takeUp(group: Group, agent: string, states: ReceiptState[], now: string): string[] {
    const done = this.store.doneSeq(group.id, agent);
    const since = this.now().getTime() - this.limits.catchUpMs;
    const latest = this.store.receiptsOf(group.id, agent, states).find((r) => r.seq > done && Date.parse(r.updatedAt) >= since);
    const reading = this.store.receiptsOf(group.id, agent, ["reading"])[0];
    if (!latest || (reading && reading.seq > latest.seq)) return [];
    return this.wakeAgents(group, latest.seq, [agent], now);
  }

  // AIs join from where the group is now; a note says so, and an opening
  // message from within a day wakes them.
  private admit(group: Group, agents: string[], owner: string, quota: number, now: string): string[] {
    if (!agents.length) return [];
    const joinedSeq = this.store.lastSeq(group.id);
    for (const agent of agents) this.store.addMember({ groupId: group.id, agent, owner, quota, joinedSeq }, now);
    this.store.addMessage(group.id, { sender: null, kind: "system", body: cjk(agents.map((a) => this.nameFor(a)).join("、"), "加入了群聊") }, now);
    const opener = group.openerSeq ? this.store.message(group.id, group.openerSeq) : null;
    if (!opener || this.now().getTime() - Date.parse(opener.createdAt) > this.limits.catchUpMs) return [];
    return this.wakeAgents(this.store.group(group.id)!, opener.seq, agents.filter((a) => a !== opener.sender), now);
  }

  // A member leaves: when 群主's AIs are all gone, the AI that joined first
  // passes 群主 to its person; when nobody is left, the group ends.
  private drop(group: Group, agent: string, note: string): void {
    const now = this.stamp();
    let invited: string[] = [];
    this.transaction(() => {
      this.store.leaveMember(group.id, agent, now);
      // What it was still reading, or asked to 动手 for, stays unanswered, and
      // the line under it says why; what was asked of it ends with it. What
      // it asked others to 动手 for ends too: nobody is left to do it for.
      for (const r of this.store.receiptsOf(group.id, agent, ["reading", "asking", "acting"])) this.store.setReceipt(group.id, r.seq, agent, "failed", "不在群里了", r.epoch, now);
      this.store.endActs(group.id, "stopped", now, { doer: agent });
      for (const r of this.store.requests(group.id, agent, ["asking", "acting"])) this.store.setReceipt(group.id, r.seq, r.agent, "passed", "对方不在群里了", r.epoch, now);
      this.store.endActs(group.id, "stopped", now, { asker: agent });
      // A dissolved group is only read now: leaving it changes nothing in it.
      if (group.status === "dissolved") return;
      this.store.addMessage(group.id, { sender: null, kind: "system", body: note }, now);
      const left = this.store.members(group.id);
      if (!left.length) {
        // Those still invited hear of it once more; their invites end with the group.
        invited = this.store.openInvites(group.id, now).map((i) => this.dir.seat(i.account));
        this.store.updateGroup(group.id, { status: "dissolved" }, now);
      } else if (!left.some((m) => m.owner === group.owner)) this.store.updateGroup(group.id, { owner: left[0].owner }, now);
    });
    this.emit("group.updated", group.id, {}, [agent, ...invited]);
  }

  // The person, or their AI when it acted on the person's word.
  private who(caller: Caller, by?: string): string {
    if (by && caller.actsAs(by)) return this.nameFor(by);
    return this.dir.person(caller.account, "");
  }

  // --- making a group and bringing people in

  createGroup(caller: Caller, input: { from: string; name?: string; members: GroupTarget[]; message?: string; files?: NewFile[] }): GroupDetail {
    const from = this.requireSpeaker(caller, input.from);
    // "@所有人" with nothing to discuss is no opening message: it would wake every AI for nothing.
    const said = input.message?.trim() ?? "";
    const text = said.replaceAll("@所有人", "").trim() ? said : "";
    const files = checkAttachments(input.files);
    if (text.length > 20000) throw new RelayError(400, "消息需要在 1 到 20000 个字之间");
    const name = input.name?.trim() || nameFrom(text) || "群聊";
    if (name.length > 30) throw new RelayError(400, "群名需要在 1 到 30 个字之间");
    const { join, invite } = this.sort(caller, input.members);
    if (from.client !== "person" && !join.includes(from.id)) join.unshift(from.id);
    if (!join.length) throw new RelayError(400, "群里至少要有你自己的一个 AI");
    if (join.length > this.limits.maxMembers) throw new RelayError(409, `群里最多 ${this.limits.maxMembers} 个 AI`);
    const now = this.stamp();
    const id = `g_${randomBytes(5).toString("hex")}`;
    const asked: string[] = [];
    const opened = this.transaction(() => {
      this.store.createGroup({ id, name, owner: caller.account }, now);
      for (const agent of join) this.store.addMember({ groupId: id, agent, owner: caller.account, quota: this.limits.quota, joinedSeq: 0 }, now);
      for (const t of invite) if (this.offer(id, t, from.id, now)) asked.push(t.account);
      if (!text && !files.length) return null;
      // The opening message calls on everyone, those who join later too.
      const opener = this.store.addMessage(id, { sender: from.id, kind: "message", body: text, mentions: [ALL], byPerson: from.client === "person", files }, now);
      const group = this.store.updateGroup(id, { openerSeq: opener.seq }, now);
      return { seq: opener.seq, wake: this.wake(group, opener, from.id) };
    });
    this.emit("group.updated", id);
    if (opened) this.emit("group.message", id, opened);
    this.tellInvited(id, asked);
    return this.detail(caller, id);
  }

  invite(caller: Caller, groupId: string, input: { from: string; members: GroupTarget[] }): GroupDetail {
    const group = this.requireMine(caller, groupId);
    this.requireOpen(group);
    const from = this.requireSpeaker(caller, input.from);
    const { join, invite } = this.sort(caller, input.members);
    const members = this.store.members(groupId);
    // Someone already in picks no more AIs: each is asked for by name.
    const inside = invite.find((t) => !t.agent && members.some((m) => m.owner === t.account));
    if (inside) throw new RelayError(400, cjk(this.dir.person(inside.account, caller.account), "已经在群里了，邀请他的 AI 吧"));
    const newcomers = join.filter((a) => !members.some((m) => m.agent === a));
    const fresh = invite.filter((t) => !t.agent || !members.some((m) => m.agent === t.agent));
    if (!newcomers.length && !fresh.length) throw new RelayError(409, "他们已经在群里了");
    if (members.length + newcomers.length > this.limits.maxMembers) throw new RelayError(409, `群里最多 ${this.limits.maxMembers} 个 AI`);
    const now = this.stamp();
    // Someone already in is not told: their AI asked for waits on a tile in 群设置.
    const asked: string[] = [];
    const wake = this.transaction(() => {
      for (const t of fresh) if (this.offer(groupId, t, from.id, now) && !members.some((m) => m.owner === t.account)) asked.push(t.account);
      return this.admit(group, newcomers, caller.account, this.limits.quota, now);
    });
    this.emit("group.updated", groupId, { wake });
    this.tellInvited(groupId, asked);
    return this.detail(caller, groupId);
  }

  // Only the person invited answers, on the web page.
  private requireInvite(caller: Caller, groupId: string, inviteId: string): InviteRow {
    if (!caller.person) throw new RelayError(403, "进群要主人在网页上点“加入”");
    const invite = this.store.invite(inviteId);
    if (!invite || invite.groupId !== groupId || invite.account !== caller.account) throw new RelayError(404, "找不到这个邀请");
    if (invite.answered) throw new RelayError(409, "这个邀请已经处理过了");
    if (this.requireGroup(groupId).status === "dissolved") throw new RelayError(409, "群已经解散了");
    if (invite.expiresAt <= this.stamp()) throw new RelayError(410, "这个邀请已经过期了，请对方重新拉你进群");
    return invite;
  }

  // What an answer to `invite` answers. Someone not yet in has one invite
  // card however many of their AIs were asked for by name: answering it
  // answers them all. Once in, each AI asked for is a tile in 群设置,
  // answered on its own.
  private card(caller: Caller, groupId: string, invite: InviteRow): InviteRow[] {
    if (this.mine(caller, groupId).length) return [invite];
    return this.store.openInvites(groupId, this.stamp()).filter((i) => i.account === caller.account);
  }

  // The person picks which of their AIs join, or those asked for by name
  // join (leaving out any since removed), and how many times a day each may
  // be woken here. A dissolved group's invite is refused by requireInvite.
  acceptInvite(caller: Caller, groupId: string, inviteId: string, input: { agents?: string[]; quota?: number }): GroupDetail {
    const invite = this.requireInvite(caller, groupId, inviteId);
    const group = this.requireGroup(groupId);
    const card = this.card(caller, groupId, invite);
    const named = card.every((i) => i.agent) ? card.map((i) => i.agent!) : null;
    const agents = named ? named.filter((a) => this.dir.agent(a)) : [...new Set(input.agents ?? [])];
    if (named && !agents.length) throw new RelayError(409, "邀请的 AI 已经移除了");
    if (!agents.length) throw new RelayError(400, "选至少一个 AI 进群");
    for (const a of agents) {
      const agent = this.dir.agent(a);
      if (!agent || agent.owner !== caller.account || agent.client === "person") throw new RelayError(400, "只能让自己的 AI 进群");
    }
    const quota = this.checkQuota(input.quota);
    const members = this.store.members(groupId);
    const newcomers = agents.filter((a) => !members.some((m) => m.agent === a));
    if (members.length + newcomers.length > this.limits.maxMembers) throw new RelayError(409, `群里最多 ${this.limits.maxMembers} 个 AI`);
    const now = this.stamp();
    const wake = this.transaction(() => {
      for (const i of card) this.store.answerInvite(i.id, "accepted");
      return this.admit(group, newcomers, caller.account, quota, now);
    });
    this.emit("group.updated", groupId, { wake });
    return this.detail(caller, groupId);
  }

  declineInvite(caller: Caller, groupId: string, inviteId: string): { ok: true } {
    const invite = this.requireInvite(caller, groupId, inviteId);
    this.transaction(() => {
      for (const i of this.card(caller, groupId, invite)) this.store.answerInvite(i.id, "declined");
    });
    this.emit("group.updated", groupId, {}, [this.dir.seat(caller.account)]);
    return { ok: true };
  }

  // --- talking

  postMessage(caller: Caller, groupId: string, input: GroupPostInput): GroupDetail {
    const group = this.requireGroup(groupId);
    const from = this.requireSpeaker(caller, input.from);
    const person = from.client === "person";
    const member = person ? null : this.store.member(groupId, from.id);
    if (person ? !this.mine(caller, groupId).length : !member || member.leftAt !== null) throw new RelayError(404, "找不到这个群");
    this.requireOpen(group);
    const body = input.body.trim();
    const files = checkAttachments(input.files);
    if ((!body && !files.length) || body.length > 20000) throw new RelayError(400, "消息需要在 1 到 20000 个字之间");
    const answering = input.replyTo !== undefined;
    const mentions = this.checkMentions(groupId, from, input.mentions ?? [], answering && !person);
    if (answering && person) throw new RelayError(400, "只有被叫醒的 AI 会这样回");
    if (answering) this.requireAnswering(group, from.id, input);
    // 动手's result, sent back for a request under way.
    const acting = answering && this.store.receipt(groupId, input.replyTo!, from.id)?.state === "acting";
    const now = this.stamp();
    const posted = this.transaction(() => {
      const msg = this.store.addMessage(
        groupId,
        {
          sender: from.id,
          kind: "message",
          body,
          mentions,
          replyTo: input.replyTo ?? null,
          byPerson: person,
          redactions: input.redactions ?? 0,
          costUsd: input.costUsd ?? 0,
          files,
          model: typeof input.model === "string" && input.model.trim() ? input.model.trim().slice(0, 80) : null,
          effort: isEffort(input.effort) ? input.effort : null,
        },
        now,
      );
      if (answering) this.settle(groupId, from.id, input.replyTo!, "replied", null, input, now);
      if (acting) this.resultBack(groupId, from.id, input.replyTo!, now);
      return { seq: msg.seq, wake: this.wake(this.store.group(groupId)!, msg, from.id) };
    });
    this.emit("group.message", groupId, posted);
    // An AI calling its own person (@老方): they alone are told, on the page and their computer.
    for (const seat of mentions.filter((m) => this.dir.agent(m)?.client === "person")) this.tell("group.mention", groupId, [seat], { seq: posted.seq });
    // 动手's result for a friend who asked in person: an AI cannot @ them, so
    // they are told as when their own AI calls them, on their page and computer.
    const asker = acting ? this.store.message(groupId, input.replyTo!)?.sender : null;
    if (asker && this.dir.agent(asker)?.client === "person" && !mentions.includes(asker)) this.tell("group.mention", groupId, [asker], { seq: posted.seq });
    return this.detail(caller, groupId);
  }

  // The AI woken read it and need not reply: its half sentence of why.
  pass(caller: Caller, groupId: string, input: { agent: string; seq: number; epoch?: number; reason?: string; sessionId?: string; readTo?: number }): GroupDetail {
    const group = this.requireGroup(groupId);
    if (!caller.actsAs(input.agent)) throw new RelayError(403, "只有被叫醒的 AI 可以这样回");
    this.requireReading(group, input.agent, input.seq, input.epoch);
    const reason = (input.reason ?? "").trim().split("\n")[0].slice(0, 60) || null;
    this.transaction(() => this.settle(groupId, input.agent, input.seq, "passed", reason, input, this.stamp()));
    this.emit("group.updated", groupId, { seq: input.seq });
    return this.detail(caller, groupId);
  }

  // Answering went wrong for a reason that is not waiting.
  fail(caller: Caller, groupId: string, input: { agent: string; seq: number; reason: string }): GroupDetail {
    return this.mark(caller, groupId, input, "failed");
  }

  // Still on it, with why it takes long, such as its login running out.
  hold(caller: Caller, groupId: string, input: { agent: string; seq: number; reason: string }): GroupDetail {
    return this.mark(caller, groupId, input, "reading");
  }

  private mark(caller: Caller, groupId: string, input: { agent: string; seq: number; reason: string }, state: ReceiptState): GroupDetail {
    this.requireGroup(groupId);
    if (!caller.actsAs(input.agent)) throw new RelayError(403, "只有被叫醒的 AI 可以这样报");
    const r = this.store.receipt(groupId, input.seq, input.agent);
    const reason = input.reason.trim().slice(0, 120) || null;
    // A round of 动手 that could not start fails the same way, with every
    // request it was for, as its result would answer them (settle); it is
    // never held.
    if (r?.state === "acting" && state === "failed") {
      this.transaction(() => this.settle(groupId, input.agent, input.seq, state, reason, {}, this.stamp()));
      this.emit("group.updated", groupId, { seq: input.seq });
    } else if (r?.state === "reading") {
      this.store.setReceipt(groupId, input.seq, input.agent, state, reason, r.epoch, this.stamp());
      this.emit("group.updated", groupId, { seq: input.seq });
    }
    return this.detail(caller, groupId);
  }

  // --- 动手（8n）: an AI asked in a group to do something on its computer

  // The AI asked, and only its own computer: its person decides there, in a dialog.
  private requireDoer(caller: Caller, groupId: string, doer: string): MemberRow {
    if (!caller.actsAs(doer)) throw new RelayError(403, "只有被请动手的 AI 的电脑可以这样做");
    const group = this.requireGroup(groupId);
    const member = this.store.member(groupId, doer);
    if (!member || member.leftAt) throw new RelayError(404, "找不到这个群");
    if (group.status !== "open") throw new RelayError(409, "群里已经叫停了，这次不再动手");
    return member;
  }

  // An act still waiting for its person; a credential pasted into another app cannot answer for them.
  private requireAsking(caller: Caller, groupId: string, actId: string): GroupAct {
    const act = this.store.act(actId);
    if (!act || act.groupId !== groupId) throw new RelayError(404, "找不到这次动手");
    this.requireDoer(caller, groupId, act.doer);
    if (!caller.approves) throw new RelayError(403, "动手要主人在电脑的弹框里同意");
    if (act.status !== "asking") throw new RelayError(409, "这次动手已经处理过了");
    return act;
  }

  // An AI's receipts in one state for what `asker` said: the requests of one act.
  private askedBy(groupId: string, agent: string, asker: string | null | undefined, state: ReceiptState): StoredReceipt[] {
    return asker ? this.store.requests(groupId, asker, [state], agent) : [];
  }

  // The rounds start, the first being what asked: its person said yes, or
  // asked themself (own). Every request of it still waiting is under way now.
  private startAct(act: GroupAct, now: string): GroupAct {
    for (const r of this.askedBy(act.groupId, act.doer, act.asker, "asking")) this.store.setReceipt(act.groupId, r.seq, act.doer, "acting", null, r.epoch, now);
    this.store.addMessage(act.groupId, { sender: null, kind: "system", body: cjk(this.nameFor(act.doer), `开始动手 · ${act.maxRounds} 轮`) }, now);
    return this.store.updateAct(act.id, { status: "active", roundsUsed: 1 }, now);
  }

  // Whether `act` takes a request as one more of its rounds: it has rounds
  // left, and what its person started themself (own) goes on only with
  // their own asking, never with words that may be someone else's.
  private covers(act: GroupAct, ownAsk: boolean): boolean {
    return act.roundsUsed < act.maxRounds && (!act.own || ownAsk);
  }

  // Rounds of `act` still to be done here: requests under way, their result not back.
  private due(act: GroupAct): boolean {
    return this.askedBy(act.groupId, act.doer, act.asker, "acting").length > 0;
  }

  // An act is over, with nothing of it left to do: its rounds used (the
  // group is told), or its person's own act now asked for by words that
  // may not be theirs. What its asker asked past it waits for a yes.
  private end(act: GroupAct, now: string): void {
    this.store.updateAct(act.id, { status: "done" }, now);
    if (act.roundsUsed >= act.maxRounds) {
      this.store.addMessage(act.groupId, { sender: null, kind: "system", body: cjk(this.nameFor(act.doer), `动手 ${act.maxRounds} 轮用完了`) }, now);
    }
  }

  // 动手's result for `seq` came back. Once nothing of its act is left to
  // do, an act whose rounds are used, or that a request it does not cover
  // waits on (requestAct), ends; its computer, looking again at the
  // group's event, then puts that request to its person.
  private resultBack(groupId: string, doer: string, seq: number, now: string): void {
    const asker = this.store.message(groupId, seq)?.sender;
    const act = asker ? this.store.openAct(groupId, asker, doer) : null;
    if (act?.status !== "active" || this.due(act)) return;
    if (act.roundsUsed < act.maxRounds && !this.askedBy(groupId, doer, asker, "asking").length) return;
    this.end(act, now);
  }

  // Its person's own asking, which needs no dialog: their words in person,
  // or another of their AIs speaking from the front. Not that AI's
  // background answer, nor 动手's result: what someone else said may be
  // echoed in it.
  private ownAsk(msg: GroupMessage, owner: string): boolean {
    if (msg.sender === this.dir.seat(owner)) return true;
    const asker = msg.sender ? this.dir.agent(msg.sender) : undefined;
    return !!asker && asker.client !== "person" && asker.owner === owner && msg.replyTo === null;
  }

  // The computer of the AI woken for `seq` judged it is asked to 动手 (8k).
  // Asked by its own person in person, or by another of their AIs from the
  // front, it starts at once (ownAsk); within an act's rounds the same
  // asker's next request goes on with it (covers); otherwise the person
  // decides in a dialog on that computer (approveAct, declineAct). A request
  // the act under way does not cover, such as an 11th, waits for what that
  // act has still to do (its rounds were approved), then for a yes: asked
  // again once that is back (resultBack), it starts a new act. `run`: the
  // computer starts the work, or goes on with it, now.
  requestAct(caller: Caller, groupId: string, input: { doer: string; seq: number }): { act: GroupAct; run: boolean } {
    const member = this.requireDoer(caller, groupId, input.doer);
    const r = this.store.receipt(groupId, input.seq, input.doer);
    if (!r || !(["reading", "asking", "acting"] as ReceiptState[]).includes(r.state)) throw new RelayError(409, "这条已经不用回了");
    const msg = this.store.message(groupId, input.seq)!;
    const asker = msg.sender!;
    const open = this.store.openAct(groupId, asker, input.doer);
    // Asked for already, such as a retry or after a restart: nothing changes.
    if (r.state === "acting" && open?.status === "active") return { act: open, run: true };
    if (r.state === "acting") throw new RelayError(409, "这条已经不用回了");
    if (r.state === "asking" && open?.status === "asking") return { act: open, run: false };
    // Still waiting for what the act under way has to do: nothing changes,
    // and nobody is told, however often its computer looks.
    if (r.state === "asking" && open?.status === "active" && this.due(open)) return { act: open, run: false };
    const now = this.stamp();
    const result = this.transaction((): { act: GroupAct; run: boolean } => {
      if (open?.status === "active" && r.state === "reading" && this.covers(open, this.ownAsk(msg, member.owner))) {
        this.store.setReceipt(groupId, input.seq, input.doer, "acting", null, r.epoch, now);
        // askSeq is the latest request: two that came together may be judged newest first.
        return { act: this.store.updateAct(open.id, { roundsUsed: open.roundsUsed + 1, askSeq: Math.max(open.askSeq, input.seq) }, now), run: true };
      }
      this.store.setReceipt(groupId, input.seq, input.doer, "asking", null, r.epoch, now);
      // Past what the act under way covers: what it has still to do comes first.
      if (open?.status === "active") {
        if (this.due(open)) return { act: open, run: false };
        this.end(open, now);
      }
      if (open?.status === "asking") return { act: this.store.updateAct(open.id, { askSeq: Math.max(open.askSeq, input.seq) }, now), run: false };
      // A new act answers the latest of what waits: several may have waited for the one before to end.
      const askSeq = Math.max(input.seq, ...this.askedBy(groupId, input.doer, asker, "asking").map((x) => x.seq));
      const own = this.ownAsk(this.store.message(groupId, askSeq)!, member.owner);
      const act = this.store.addAct(
        { id: `ga_${randomBytes(6).toString("hex")}`, groupId, asker, doer: input.doer, status: "asking", own, maxRounds: GROUP_ACT_ROUNDS, roundsUsed: 0, askSeq },
        now,
      );
      return own ? { act: this.startAct(act, now), run: true } : { act, run: false };
    });
    this.emit("group.updated", groupId, { seq: input.seq });
    return result;
  }

  // Its person said yes in the dialog on its computer.
  approveAct(caller: Caller, groupId: string, actId: string): GroupAct {
    const act = this.requireAsking(caller, groupId, actId);
    const started = this.transaction(() => this.startAct(act, this.stamp()));
    this.emit("group.updated", groupId, { seq: act.askSeq });
    return started;
  }

  // Its person said no: what asked need not be answered, and the line under it says why.
  declineAct(caller: Caller, groupId: string, actId: string): GroupAct {
    const act = this.requireAsking(caller, groupId, actId);
    const now = this.stamp();
    const declined = this.transaction(() => {
      for (const r of this.askedBy(groupId, act.doer, act.asker, "asking")) this.store.setReceipt(groupId, r.seq, act.doer, "passed", "主人没同意动手", r.epoch, now);
      return this.store.updateAct(act.id, { status: "declined" }, now);
    });
    this.emit("group.updated", groupId, { seq: act.askSeq });
    return declined;
  }

  // --- 叫停 and 每天次数

  stop(caller: Caller, groupId: string, by?: string): GroupDetail {
    const group = this.requireMine(caller, groupId);
    this.requireOpen(group);
    if (group.status === "stopped") return this.detail(caller, groupId);
    const now = this.stamp();
    this.transaction(() => {
      this.store.updateGroup(groupId, { status: "stopped", epoch: group.epoch + 1 }, now);
      // Everything still waiting stops: what is being read, what was left
      // for a computer that was off or a 每天次数 used up, so “继续” or a
      // reconnect never takes up what was @ed before, and 动手 waiting for its
      // person or under way, whose acts end: after “继续” it is asked for anew.
      for (const from of STOPPABLE) this.store.moveAll(groupId, from, "stopped", now);
      this.store.endActs(groupId, "stopped", now);
      this.store.addMessage(groupId, { sender: null, kind: "system", body: cjk(this.who(caller, by), "叫停了群里沟通") }, now);
    });
    this.emit("group.updated", groupId);
    return this.detail(caller, groupId);
  }

  // What was @ed while 叫停 stays unanswered.
  resume(caller: Caller, groupId: string, by?: string): GroupDetail {
    const group = this.requireMine(caller, groupId);
    this.requireOpen(group);
    if (group.status !== "stopped") return this.detail(caller, groupId);
    const now = this.stamp();
    this.transaction(() => {
      this.store.updateGroup(groupId, { status: "open" }, now);
      this.store.addMessage(groupId, { sender: null, kind: "system", body: cjk(this.who(caller, by), "让群里接着聊") }, now);
    });
    this.emit("group.updated", groupId);
    return this.detail(caller, groupId);
  }

  // One of the caller's AIs in a group still open, whose times here its
  // person, or that AI on their word, may change.
  private requireOwnMember(caller: Caller, groupId: string, agent: string): MemberRow {
    this.requireOpen(this.requireMine(caller, groupId));
    const member = this.store.member(groupId, agent);
    if (!member || member.leftAt || member.owner !== caller.account) throw new RelayError(404, "只能改自己的 AI 在这个群里的次数");
    if (!caller.approves && !caller.actsAs(agent)) throw new RelayError(403, "只能改自己的次数");
    return member;
  }

  // Its person, or their AI on their word, changes how many times a day one
  // of their AIs may be woken here. Raised past what it used, it takes up the
  // latest @ it had to leave, without being @ed again.
  setQuota(caller: Caller, groupId: string, input: { agent: string; perDay: number }): GroupDetail {
    this.requireOwnMember(caller, groupId, input.agent);
    const perDay = this.checkQuota(input.perDay);
    const now = this.stamp();
    const wake = this.transaction(() => {
      this.store.setQuota(groupId, input.agent, perDay);
      return this.takeUp(this.store.group(groupId)!, input.agent, ["quota"], now);
    });
    this.emit("group.updated", groupId, { wake });
    return this.detail(caller, groupId);
  }

  // 加一份: its person, asked on their computer as it was nearly used up,
  // lets one of their AIs be woken another day's 每天次数 today only, once a
  // day however often it is asked, so a request tried again adds nothing.
  // Like raising them, it takes up the latest @ it had to leave; nothing is
  // written in the group.
  addToday(caller: Caller, groupId: string, input: { agent: string }): GroupDetail {
    const member = this.requireOwnMember(caller, groupId, input.agent);
    const now = this.stamp();
    const wake = this.transaction(() => {
      this.store.addShare(groupId, input.agent, beijingDay(this.now()), member.quota);
      return this.takeUp(this.store.group(groupId)!, input.agent, ["quota"], now);
    });
    this.emit("group.updated", groupId, { wake });
    return this.detail(caller, groupId);
  }

  // What waits on an AI in a group, the newest of the first kind there is
  // among `states`: an @ to read; else a request to 动手 still waiting for
  // its person, put to them again; else 动手 under way.
  private waitingOn(groupId: string, agent: string, states: ReceiptState[] = ["reading", "asking", "acting"]): StoredReceipt | undefined {
    for (const state of states) {
      const r = this.store.receiptsOf(groupId, agent, [state])[0];
      if (r) return r;
    }
    return undefined;
  }

  // 动手 under way for each asker, whose next round the AI's computer may
  // still have to start: the newest request of each act. One round at a
  // time, so a request that came while the round before was being done
  // waits for that result, also over a restart, whatever else waits.
  private roundsOf(groupId: string, agent: string): StoredReceipt[] {
    return this.store
      .actsOf(groupId, agent, "active")
      .map((act) => this.askedBy(groupId, agent, act.asker, "acting")[0])
      .filter((r): r is StoredReceipt => r !== undefined);
  }

  // 动手 its person left unanswered (稍后) for a day since it was last asked
  // for ends, as an @ read for a day is 不在线: what asked need not be
  // answered, and the line under it says why. Asked for again, it is put to
  // them anew. True when one ended.
  private expireAsking(groupId: string, agent: string, since: number, now: string): boolean {
    const old = this.store.actsOf(groupId, agent, "asking").filter((a) => Date.parse(a.updatedAt) < since);
    for (const act of old) {
      for (const r of this.askedBy(groupId, agent, act.asker, "asking")) this.store.setReceipt(groupId, r.seq, agent, "passed", "主人一天没处理", r.epoch, now);
      this.store.updateAct(act.id, { status: "stopped" }, now);
    }
    return old.length > 0;
  }

  // What the caller's AIs (`agents`, on its computer) have to answer now. The
  // latest @ missed while the computer was off is taken up first, within a
  // day; one left for 每天次数 waits until its person raises them (setQuota)
  // or adds a day's more (addToday), so a computer coming back does not
  // spend today's on yesterday's. What it
  // was woken for over a day ago and never answered is too late: 不在线;
  // 动手 left a day for its person ends (expireAsking).
  work(caller: Caller, agents: string[]): { groupId: string; agent: string; seq: number }[] {
    const now = this.stamp();
    const since = this.now().getTime() - this.limits.catchUpMs;
    const out: { groupId: string; agent: string; seq: number }[] = [];
    for (const agent of agents.filter((a) => caller.actsAs(a))) {
      for (const group of this.store.groupsWith([agent])) {
        if (group.status !== "open") continue;
        // Keeps the time it was woken, so takeUp below sees it is over a day old.
        for (const r of this.store.receiptsOf(group.id, agent, ["reading"])) {
          if (Date.parse(r.updatedAt) < since) this.store.setReceipt(group.id, r.seq, agent, "offline", null, r.epoch, r.updatedAt);
        }
        const { wake, expired } = this.transaction(() => ({ expired: this.expireAsking(group.id, agent, since, now), wake: this.takeUp(group, agent, ["offline"], now) }));
        if (wake.length || expired) this.emit("group.updated", group.id, { wake });
        const waiting = this.waitingOn(group.id, agent, ["reading", "asking"]);
        for (const r of [...(waiting ? [waiting] : []), ...this.roundsOf(group.id, agent)]) out.push({ groupId: group.id, agent, seq: r.seq });
      }
    }
    return out;
  }

  // What an AI woken here reads: what waits on it (waitingOn), or with `seq`
  // that message, if it still waits on it, such as a round of 动手 (work
  // lists them); and from where its background session left off (the 20
  // before it joined, the first time or with `fresh`). `act`: what the one
  // who wrote it asked of this AI; `requests`: what an act under way has
  // still to answer. Null when nothing waits on it.
  workFor(caller: Caller, groupId: string, agent: string, fresh = false, seq?: number): GroupWork | null {
    const group = this.requireGroup(groupId);
    if (!caller.actsAs(agent)) throw new RelayError(403, "只能取自己的 AI 要回的消息");
    const member = this.store.member(groupId, agent);
    if (!member || member.leftAt) throw new RelayError(404, "找不到这个群");
    const asked = seq === undefined ? null : this.store.receipt(groupId, seq, agent);
    const waiting = seq === undefined ? this.waitingOn(groupId, agent) : asked && (["reading", "asking", "acting"] as ReceiptState[]).includes(asked.state) ? asked : null;
    if (!waiting) return null;
    const from = Math.max(0, member.joinedSeq - this.limits.seeBefore);
    const goesOn = member.session !== null && !fresh;
    const messages = goesOn
      ? this.store.messages(groupId, Math.max(member.readSeq, from), this.limits.readCap)
      : this.store.messages(groupId, from, this.limits.seeBefore);
    const owner = member.owner;
    const members = this.store.members(groupId);
    // Named from nobody's side ("老方的 Claude", never "我的 Claude"): what the
    // AI writes is read by everyone in the group, and "@我的 Codex" would look
    // like each reader's own. The prompt marks its own line "（你）".
    const plain = "";
    const wake = this.store.message(groupId, waiting.seq)!;
    return {
      group,
      wake,
      messages,
      session: goesOn ? member.session : null,
      members: members.map((m) => ({ agent: m.agent, name: this.nameFor(m.agent, plain) })),
      names: this.names(messages, members, plain),
      owner: { seat: this.dir.seat(owner), name: this.dir.person(owner, "") },
      act: wake.sender ? this.store.openAct(groupId, wake.sender, agent) : null,
      requests: this.askedBy(groupId, agent, wake.sender, "acting")
        .reverse()
        .map((r) => this.store.message(groupId, r.seq)!),
    };
  }

  // --- leaving and ending

  leave(caller: Caller, groupId: string, agent: string): { ok: true } {
    const group = this.requireMine(caller, groupId);
    const member = this.store.member(groupId, agent);
    if (!member || member.leftAt || member.owner !== caller.account) throw new RelayError(404, "这个 AI 不在群里");
    if (!caller.approves && !caller.actsAs(agent)) throw new RelayError(403, "只能让自己的 AI 退群");
    this.drop(group, agent, cjk(this.nameFor(agent), "退出了群聊"));
    return { ok: true };
  }

  remove(caller: Caller, groupId: string, agent: string): { ok: true } {
    const group = this.requireMine(caller, groupId);
    this.requireOpen(group);
    if (group.owner !== caller.account || !caller.approves) throw new RelayError(403, "只有群主可以移出 AI");
    const member = this.store.member(groupId, agent);
    if (!member || member.leftAt) throw new RelayError(404, "这个 AI 不在群里");
    this.drop(group, agent, cjk(this.nameFor(agent), "被移出了群聊"));
    return { ok: true };
  }

  dissolve(caller: Caller, groupId: string): GroupDetail {
    const group = this.requireMine(caller, groupId);
    if (group.owner !== caller.account || !caller.approves) throw new RelayError(403, "只有群主可以解散群");
    if (group.status === "dissolved") return this.detail(caller, groupId);
    const now = this.stamp();
    // Those still invited hear of it once more.
    const invited = this.store.openInvites(groupId, now).map((i) => this.dir.seat(i.account));
    this.transaction(() => {
      this.store.updateGroup(groupId, { status: "dissolved" }, now);
      for (const from of STOPPABLE) this.store.moveAll(groupId, from, "stopped", now);
      this.store.endActs(groupId, "stopped", now);
      this.store.addMessage(groupId, { sender: null, kind: "system", body: "群主解散了群聊" }, now);
    });
    this.emit("group.updated", groupId, {}, invited);
    return this.detail(caller, groupId);
  }

  rename(caller: Caller, groupId: string, name: string): GroupDetail {
    const group = this.requireMine(caller, groupId);
    this.requireOpen(group);
    if (group.owner !== caller.account || !caller.approves) throw new RelayError(403, "只有群主可以改群名");
    const clean = name.trim();
    if (!clean || clean.length > 30) throw new RelayError(400, "群名需要在 1 到 30 个字之间");
    // The same name again: nothing to tell the group.
    if (clean === group.name) return this.detail(caller, groupId);
    const now = this.stamp();
    this.transaction(() => {
      this.store.updateGroup(groupId, { name: clean }, now);
      this.store.addMessage(groupId, { sender: null, kind: "system", body: `群名改成「${clean}」` }, now);
    });
    this.emit("group.updated", groupId);
    return this.detail(caller, groupId);
  }

  // --- reading

  private names(messages: GroupMessage[], members: MemberRow[], viewer: string): Record<string, string> {
    const ids = new Set<string>(members.map((m) => m.agent));
    for (const m of messages) if (m.sender) ids.add(m.sender);
    return Object.fromEntries([...ids].map((id) => [id, this.nameFor(id, viewer)]));
  }

  private inviteView(i: InviteRow, viewer: string): GroupInvite {
    return {
      id: i.id,
      account: i.account,
      name: this.dir.person(i.account, viewer),
      agent: i.agent,
      agentName: i.agent ? this.dir.name(i.agent, viewer) : null,
      invitedBy: i.invitedBy,
      invitedByName: this.dir.name(i.invitedBy, viewer),
      expiresAt: i.expiresAt,
    };
  }

  // The group as the caller sees it: a member everything since 20 before
  // their first AI joined; someone invited, the opening message alone.
  detail(caller: Caller, groupId: string, limit = this.limits.detailCap): GroupDetail {
    const group = this.requireGroup(groupId);
    const now = this.stamp();
    const viewer = caller.account;
    const mine = this.mine(caller, groupId);
    const myInvite = mine.length ? null : this.latestInvite(viewer, groupId);
    if (!mine.length && !myInvite) throw new RelayError(404, "找不到这个群");
    const day = beijingDay(this.now());
    const rows = this.store.members(groupId);
    const members: GroupMember[] = rows.map((m) => {
      const agent = this.dir.agent(m.agent, viewer);
      const today = m.owner === viewer ? this.store.usage(groupId, m.agent, day) : null;
      return {
        agent: m.agent,
        name: agent?.name ?? this.dir.name(m.agent, viewer),
        owner: m.owner,
        canReceive: !!agent && agent.canReceive !== false,
        online: this.dir.online(m.agent),
        joinedAt: m.joinedAt,
        ...(today ? { quota: m.quota, usedToday: today.used, extraToday: today.extra } : {}),
      };
    });
    const messages = mine.length
      ? this.store.messages(groupId, Math.max(0, Math.min(...mine.map((m) => m.joinedSeq)) - this.limits.seeBefore), limit)
      : group.openerSeq
        ? [this.store.message(groupId, group.openerSeq)!]
        : [];
    return {
      ...group,
      role: mine.length ? "member" : "invited",
      members,
      invites: this.store.openInvites(groupId, now).map((i) => this.inviteView(i, viewer)),
      myInvite: myInvite ? this.inviteView(myInvite, viewer) : null,
      messages,
      names: this.names(messages, rows, viewer),
    };
  }

  // Of someone's open invites to a group, the latest: the one their card,
  // the list and the email name the inviter of.
  private latestInvite(account: string, groupId: string): InviteRow | null {
    return this.store.invitesFor(account, this.stamp()).filter((i) => i.groupId === groupId).at(-1) ?? null;
  }

  // The groups an account has an AI in (`agents`: all its AIs), and those it
  // is invited to, the latest first; for each invite, its latest (latestInvite).
  list(caller: Caller, agents: string[]): GroupSummary[] {
    const now = this.stamp();
    const member = this.store.groupsWith(agents).filter((g) => this.mine(caller, g.id).length);
    const invites = this.store.invitesFor(caller.account, now).filter((i) => !member.some((g) => g.id === i.groupId));
    const invited = invites.filter((i, n) => invites.findLastIndex((j) => j.groupId === i.groupId) === n);
    return [
      ...member.map((g) => this.summary(caller, g, null)),
      ...invited.map((i) => this.summary(caller, this.store.group(i.groupId)!, i)),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private summary(caller: Caller, g: Group, invite: InviteRow | null): GroupSummary {
    const viewer = caller.account;
    const last = invite ? null : (this.store.messages(g.id, 0, 1)[0] ?? null);
    const rows = this.store.members(g.id);
    return {
      ...g,
      // Someone invited sees nothing of the group but its invite: the invite's time.
      ...(invite ? { updatedAt: invite.createdAt } : {}),
      role: invite ? "invited" : "member",
      memberCount: rows.length,
      lastMessage: last,
      lastSender: last?.sender ? this.nameFor(last.sender, viewer) : null,
      faces: this.faces(rows, viewer),
      unread: invite ? true : this.unread(caller, g.id),
      myInvite: invite ? this.inviteView(invite, viewer) : null,
    };
  }

  // The 四宫格: one AI per person first, in the order they joined, then the
  // rest, four at most.
  private faces(rows: MemberRow[], viewer: string): string[] {
    const first = rows.filter((m, i) => rows.findIndex((x) => x.owner === m.owner) === i);
    return [...first, ...rows.filter((m) => !first.includes(m))].slice(0, 4).map((m) => this.nameFor(m.agent, viewer));
  }

  // Someone else's words since the person last opened it.
  private unread(caller: Caller, groupId: string): boolean {
    const seen = this.store.readSeq(caller.account, groupId);
    return this.store.sendersAfter(groupId, seen).some((s) => s !== null && this.dir.agent(s)?.owner !== caller.account);
  }

  markRead(caller: Caller, groupId: string): void {
    this.requireMine(caller, groupId);
    if (!caller.approves) throw new RelayError(403, "只有人可以标记已读");
    const last = this.store.lastSeq(groupId);
    if (last) this.store.markRead(caller.account, groupId, last);
  }

  // --- what an AI's front session saw

  // The session its person talks to read the group up to `seq` (what
  // send_group_message and check_group show it): answers to it before that
  // are no news.
  markSeen(caller: Caller, groupId: string, input: { agent: string; seq: number }): { ok: true } {
    if (!caller.actsAs(input.agent)) throw new RelayError(403, "只能记自己的 AI 在群里看到哪了");
    const member = this.store.member(groupId, input.agent);
    if (!member || member.leftAt) throw new RelayError(404, "找不到这个群");
    this.store.markSeen(groupId, input.agent, Math.min(Math.max(0, Math.floor(input.seq)), this.store.lastSeq(groupId)));
    return { ok: true };
  }

  // The groups where someone answered what the AI said in front since its
  // front session last looked: its person's next words to it bring them up
  // (8e). Answers to what it said in the background are not its session's news.
  unseen(caller: Caller, agent: string): UnseenGroup[] {
    if (!caller.actsAs(agent)) throw new RelayError(403, "只能查自己的 AI 有没有人回");
    return this.store.unseenReplies(agent).map((r) => ({ id: r.groupId, name: this.store.group(r.groupId)!.name, seq: r.seq }));
  }

  // What the email to someone newly invited says: who asked them last, named
  // from their side (`invitedBy`: an AI or a person's seat), the group's name
  // and its opening words with the names of its files. The latest invite, so
  // of two people asking for two of their AIs the second is named, and the
  // emails a day count against them. Null once they have an AI in the group:
  // they are not invited to it then (see invite).
  inviteNotice(account: string, groupId: string): { invitedBy: string; inviterName: string; groupName: string; opener: string | null } | null {
    const group = this.store.group(groupId);
    if (!group || this.store.members(groupId).some((m) => m.owner === account)) return null;
    const invite = this.latestInvite(account, groupId);
    if (!invite) return null;
    const opener = group.openerSeq ? this.store.message(groupId, group.openerSeq) : null;
    return { invitedBy: invite.invitedBy, inviterName: this.dir.name(invite.invitedBy, account), groupName: group.name, opener: opener ? withFileNames(opener) : null };
  }

  // Whether an account may read a group's files: a member all of them; someone
  // invited, while the invite is open, those of the opening message, which
  // the invite card shows.
  readable(account: string, groupId: string, messageId: number): boolean {
    const group = this.store.group(groupId);
    if (!group) return false;
    if (this.store.members(groupId).some((m) => m.owner === account)) return true;
    if (!group.openerSeq) return false;
    const invited = this.store.invitesFor(account, this.stamp()).some((i) => i.groupId === groupId);
    return invited && this.store.message(groupId, group.openerSeq)?.id === messageId;
  }

  // Resolves at the group's next change, or after the timeout (at most a minute).
  waitFor(groupId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, Math.min(timeoutMs, 60_000)));
      const off = this.onEvent((e) => {
        if (e.groupId === groupId) done();
      });
    });
  }
}
