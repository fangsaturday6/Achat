import type { Alerter } from "./dialog.js";
import type { LoginExpiredError } from "./runners.js";

// How long a question waits for the person to log in again before giving up.
export const LOGIN_WAIT_MS = 24 * 60 * 60 * 1000;
export const CLIENT_NAME = { claude: "Claude", codex: "Codex" } as const;

// Waiting out what is not the question's fault, the same for a thread and
// for a group: an AI whose login ran out is tried again every minute for a
// day, its person told once; a slow answer is tried once more.
export class LoginWait {
  private waiting = new Map<string, number>();
  private alerted = new Set<string>();
  private retried = new Set<string>();

  constructor(
    private opts: {
      alert?: Alerter;
      retryMs?: number;
      // Timers it starts, which stopping the sidecar clears.
      timers: Set<ReturnType<typeof setTimeout>>;
      log: (line: string) => void;
      advice: (err: LoginExpiredError) => string;
      now?: () => number;
    },
  ) {}

  // The login ran out while answering `key`. The first time the other side is
  // told why, and the person once per client; after a day it gives up; until
  // then `again` runs every minute.
  async loginExpired(
    key: string,
    err: LoginExpiredError,
    hooks: { tell(note: string): Promise<unknown>; giveUp(note: string): Promise<unknown>; again(): void },
  ): Promise<void> {
    const name = CLIENT_NAME[err.client];
    const now = this.opts.now?.() ?? Date.now();
    const since = this.waiting.get(key);
    if (since === undefined) {
      this.waiting.set(key, now);
      await hooks.tell(`回答的 ${name} 需要重新登录，登录后会自动接着回答`).catch(() => {});
      if (!this.alerted.has(err.client)) {
        this.alerted.add(err.client);
        this.opts.alert?.(`你的 ${name} 需要重新登录`, this.opts.advice(err));
      }
    } else if (now - since > LOGIN_WAIT_MS) {
      this.waiting.delete(key);
      await hooks.giveUp(`${name} 一天都没有重新登录，这次没有回答`).catch(() => {});
      return;
    }
    this.opts.log(`${key} 等 ${name} 重新登录：${err.message}`);
    const timer = setTimeout(() => {
      this.opts.timers.delete(timer);
      hooks.again();
    }, this.opts.retryMs ?? 60_000);
    this.opts.timers.add(timer);
  }

  // A slow answer: true the first time, when it is to be tried once more.
  timedOut(key: string): boolean {
    if (this.retried.delete(key)) return false;
    this.retried.add(key);
    return true;
  }

  // `key` was answered: nothing waits for it, and its client is logged in again.
  answered(key: string, client: string): void {
    this.waiting.delete(key);
    this.retried.delete(key);
    this.alerted.delete(client);
  }

  // `key` failed for another reason.
  failed(key: string): void {
    this.retried.delete(key);
  }
}
