import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import type { ThreadMode } from "../types.js";
import { desktopNotify } from "./notify.js";

export interface ApprovalPrompt {
  mode: ThreadMode;
  title: string; // 老王的 Codex 想问你的 Claude / 老王的 Codex 请你的 Claude 动手
  topic: string;
  body: string;
  // Why it is asked again, for a request inside a thread: 已到 10 轮上限.
  reason?: string;
  scope: string; // 问答 · 10 轮 · $10.00 / 动手 · 10 轮
}

// A dialog's icon is the Achat icon. A request's has 问答 (a blue question
// bubble) or 动手 (an orange wrench) in its corner, the same pictures as on
// the web page; web/icons/*.svg are what the PNGs are drawn from.
export function dialogIcon(kind: ThreadMode | "app"): string | null {
  const web = join(import.meta.dirname, "..", "..", "web");
  const file = kind === "app" ? join(web, "brand", "achat-icon-512.png") : join(web, "icons", kind === "do" ? "do.png" : "ask.png");
  return existsSync(file) ? file : null;
}

export type Answer = "approve" | "decline" | "later";

// A question on screen. close() takes it away, for example when the request
// was handled on the web; the answer is then "later".
export interface Asking {
  answer: Promise<Answer>;
  close(): void;
}

// Shows the question, or returns null where this computer cannot.
export type Asker = (prompt: ApprovalPrompt) => Asking | null;

// Unanswered questions go away after this; the request stays.
const WAIT_SECONDS = 600;

function message(p: ApprovalPrompt): string {
  const body = p.body.length > 400 ? p.body.slice(0, 400) + "……" : p.body;
  return [p.topic, "", body, "", ...(p.reason ? [p.reason] : []), p.scope].join("\n");
}

function onPath(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A dialog with these buttons, left to right; the first is both the default
// and the way out, so pressing Return never does anything for the person.
// Resolves to the button pressed, or null when it went away.
function macDialog(title: string, text: string, icon: string | null, buttons: string[]): { answer: Promise<string | null>; close(): void } {
  const first = JSON.stringify(buttons[0]);
  const options = `buttons {${buttons.map((b) => JSON.stringify(b)).join(", ")}} default button ${first} cancel button ${first} giving up after ${WAIT_SECONDS}`;
  const show = icon
    ? `display dialog ((item 1 of argv) & return & return & (item 2 of argv)) with title "Achat" ${options} with icon (POSIX file (item 3 of argv))`
    : `display alert (item 1 of argv) message (item 2 of argv) ${options}`;
  const script = ["on run argv", "activate", show, "return button returned of result", "end run"];
  let child!: ChildProcess;
  const answer = new Promise<string | null>((resolve) => {
    child = execFile("osascript", [...script.flatMap((line) => ["-e", line]), title, text, ...(icon ? [icon] : [])], (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
  return { answer, close: () => child.kill() };
}

// "稍后" is the default button, so pressing Return while typing elsewhere
// never approves anything. A dialog takes an icon of its own; an alert, used
// when the icon is missing, shows the title larger.
function macAlert(p: ApprovalPrompt): Asking {
  const shown = macDialog(p.title, message(p), dialogIcon(p.mode), ["稍后", "拒绝", "同意"]);
  return { answer: shown.answer.then((b) => (b === "同意" ? "approve" : b === "拒绝" ? "decline" : "later")), close: shown.close };
}

function zenity(p: ApprovalPrompt): Asking {
  let child!: ChildProcess;
  const answer = new Promise<Answer>((resolve) => {
    child = execFile(
      "zenity",
      [
        "--question",
        "--no-markup",
        "--title",
        p.title,
        "--text",
        `${p.title}\n\n${message(p)}`,
        "--ok-label",
        "同意",
        "--cancel-label",
        "稍后",
        "--extra-button",
        "拒绝",
        "--timeout",
        String(WAIT_SECONDS),
      ],
      (err, stdout) => {
        if (!err) return resolve("approve");
        resolve(String(stdout).trim() === "拒绝" ? "decline" : "later");
      },
    );
  });
  return { answer, close: () => child.kill() };
}

// Something the person has to do on this computer, with one button.
export type Alerter = (title: string, message: string) => void;

export const desktopAlert: Alerter = (title, message) => {
  const os = platform();
  if (os === "darwin") {
    macDialog(title, message, dialogIcon("app"), ["好"]);
  } else if (os === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && onPath("zenity")) {
    execFile("zenity", ["--info", "--no-markup", "--title", title, "--text", `${title}\n\n${message}`], () => {});
  } else {
    desktopNotify(title, message, "");
  }
};

// A dialog in the middle of the screen, on macOS and on Linux desktops with
// zenity; elsewhere the caller falls back to a notification.
export const desktopAsk: Asker = (p) => {
  const os = platform();
  if (os === "darwin") return macAlert(p);
  if (os === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && onPath("zenity")) return zenity(p);
  return null;
};

// Two ways to go for something the person decides here, such as giving a
// conversation more rounds when its last one opens: `more` goes on, `stop`
// lets it run out and is the default, so Return never spends anything.
export interface ChoicePrompt {
  icon: ThreadMode;
  title: string; // 老王的 Codex 和你的 Claude 到最后 1 轮了
  body: string;
  more: string; // 加 10 轮
  stop: string; // 用完就停
}

export type Choice = "more" | "stop";

export interface Choosing {
  answer: Promise<Choice>;
  close(): void;
}

// Shows the choice, or returns null where this computer cannot.
export type Chooser = (prompt: ChoicePrompt) => Choosing | null;

function zenityChoose(p: ChoicePrompt): Choosing {
  let child!: ChildProcess;
  const answer = new Promise<Choice>((resolve) => {
    child = execFile(
      "zenity",
      ["--question", "--no-markup", "--default-cancel", "--title", p.title, "--text", `${p.title}\n\n${p.body}`, "--ok-label", p.more, "--cancel-label", p.stop, "--timeout", String(WAIT_SECONDS)],
      (err) => resolve(err ? "stop" : "more"),
    );
  });
  return { answer, close: () => child.kill() };
}

export const desktopChoose: Chooser = (p) => {
  const os = platform();
  if (os === "darwin") {
    const shown = macDialog(p.title, p.body, dialogIcon(p.icon), [p.stop, p.more]);
    return { answer: shown.answer.then((b) => (b === p.more ? "more" : "stop")), close: shown.close };
  }
  if (os === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && onPath("zenity")) return zenityChoose(p);
  return null;
};
