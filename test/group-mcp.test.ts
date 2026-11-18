import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RelayClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Sidecar } from "../src/sidecar/sidecar.js";
import { addComputer, type Browser, logIn, ScriptedRunner, startTestCloud, until } from "./helpers.js";

async function mcp(client: RelayClient, agentId: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ connection: () => ({ client, agentId, webUrl: "https://achat.test", mode: "cloud" }), waitSeconds: 10 }).connect(serverSide);
  const c = new Client({ name: "test", version: "1" });
  await c.connect(clientSide);
  return c;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

async function befriend(a: Browser, b: Browser, bEmail: string): Promise<void> {
  await a.call("POST", "/api/invites", { email: bEmail });
  const request = (await b.call("GET", "/api/invites")).find((f: any) => f.direction === "in" && f.status === "pending");
  await b.call("POST", `/api/invites/${request.id}/accept`, {});
}

test("an AI makes a group, talks in it, reads it, sets its 每天次数 and 叫停, with the tools", async () => {
  const { cloud, mailer } = await startTestCloud();
  const fang = await logIn(cloud, mailer, "fang@example.com", "老方");
  const wang = await logIn(cloud, mailer, "wang@example.com", "老王");
  await befriend(fang, wang, "wang@example.com");
  const fangMac = await addComputer(cloud, fang, "MacBook", ["claude", "codex"]);
  const wangLaptop = await addComputer(cloud, wang, "ThinkPad", ["codex"]);
  const wangCodex = wangLaptop.agent("codex");
  // 老王's computer is on and answers; 老方's Codex is not.
  let connected = false;
  const stayOn = wangLaptop.client.subscribe(undefined, () => {}, () => (connected = true));
  const sidecar = new Sidecar({
    client: wangLaptop.client,
    agents: [],
    runners: { [wangCodex]: new ScriptedRunner(["订单和回调在我这边", "微信还没商户号"]) },
    notify: () => {},
    webUrl: cloud.url,
    log: () => {},
  });
  sidecar.start();
  try {
    await until(async () => connected);
    const ai = await mcp(fangMac.client, fangMac.agent("claude"));

    const creating = ai.callTool({ name: "create_group", arguments: { name: "支付对接", members: ["老王", "我的 Codex"], message: "@所有人 说说现状" } });
    const invited = await until(async () => (await wang.call("GET", "/api/groups")).find((g: any) => g.role === "invited"));
    await wang.call("POST", `/api/groups/${invited.id}/invites/${invited.myInvite.id}/accept`, { agents: [wangCodex] });
    const created = textOf(await creating);
    assert.match(created, /已建群「支付对接」/);
    assert.match(created, /老王的 Codex：\n订单和回调在我这边/);
    assert.match(created, /我的 Codex 不在线/);

    const said = textOf(await ai.callTool({ name: "send_group_message", arguments: { group: "支付对接", message: "@老王的 Codex 微信呢", mentions: ["老王的 Codex"] } }));
    assert.match(said, /微信还没商户号/);

    assert.match(textOf(await ai.callTool({ name: "check_group", arguments: { group: "支付对接" } })), /微信还没商户号/);
    assert.match(textOf(await ai.callTool({ name: "check_group", arguments: {} })), /支付对接/);
    assert.match(textOf(await ai.callTool({ name: "list_contacts", arguments: {} })), /支付对接/);
    assert.match(textOf(await ai.callTool({ name: "set_group_quota", arguments: { group: "支付对接", per_day: 50, agent: "我的 Codex" } })), /每天最多被叫醒 50 次/);
    assert.match(textOf(await ai.callTool({ name: "stop_group", arguments: { group: "支付对接" } })), /已叫停/);
    assert.match(textOf(await ai.callTool({ name: "stop_group", arguments: { group: "支付对接", resume: true } })), /接着聊/);
  } finally {
    sidecar.stop();
    stayOn();
    await cloud.close();
  }
});

test("an AI that is not in the group is told to pull itself in with invite_to_group, and can", async () => {
  const { cloud, mailer } = await startTestCloud();
  const fang = await logIn(cloud, mailer, "fang@example.com", "老方");
  const wang = await logIn(cloud, mailer, "wang@example.com", "老王");
  await befriend(fang, wang, "wang@example.com");
  const fangMac = await addComputer(cloud, fang, "MacBook", ["claude", "codex"]);
  const wangId = (await wang.call("GET", "/api/me")).account.id;
  try {
    // Only 老方's Codex is in the group; his Claude is not.
    await fangMac.client.createGroup({ from: fangMac.agent("codex"), name: "只有 Codex", members: [{ account: wangId }] });
    const ai = await mcp(fangMac.client, fangMac.agent("claude"));
    const refused = await ai.callTool({ name: "send_group_message", arguments: { group: "只有 Codex", message: "我来了" } });
    assert.equal(refused.isError, true);
    assert.equal(textOf(refused), "你不在「只有 Codex」里，先用 invite_to_group 把自己拉进来（members 填「我的 Claude」）");
    const pulled = await ai.callTool({ name: "invite_to_group", arguments: { group: "只有 Codex", members: ["我的 Claude"] } });
    assert.notEqual(pulled.isError, true);
    assert.match(textOf(await ai.callTool({ name: "send_group_message", arguments: { group: "只有 Codex", message: "我来了" } })), /已发到群「只有 Codex」/);
  } finally {
    await cloud.close();
  }
});
