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
  // Why it is asked again, for a request inside a thread: 已到 5 轮上限.
  reason?: string;
  scope: string; // 问答 · 5 轮 · $5.00 / 动手 · 5 轮
}

// The dialog's icon tells 问答 (a blue question bubble) from 动手 (an orange
// wrench) at a glance; the same pictures as on the web page.
function modeIcon(mode: ThreadMode): string | null {
  const file = join(import.meta.dirname, "..", "..", "web", "icons", mode === "do" ? "do.png" : "ask.png");
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

// "稍后" is the default button, so pressing Return while typing elsewhere
// never approves anything. A dialog takes an icon of its own; an alert, used
// when the icon is missing, shows the title larger.
function macAlert(p: ApprovalPrompt): Asking {
  const buttons = `buttons {"稍后", "拒绝", "同意"} default button "稍后" cancel button "稍后" giving up after ${WAIT_SECONDS}`;
  const icon = modeIcon(p.mode);
  const show = icon
    ? `display dialog ((item 1 of argv) & return & return & (item 2 of argv)) with title "Achat" ${buttons} with icon (POSIX file (item 3 of argv))`
    : `display alert (item 1 of argv) message (item 2 of argv) ${buttons}`;
  const script = ["on run argv", "activate", show, "return button returned of result", "end run"];
  let child!: ChildProcess;
  const answer = new Promise<Answer>((resolve) => {
    child = execFile("osascript", [...script.flatMap((line) => ["-e", line]), p.title, message(p), ...(icon ? [icon] : [])], (err, stdout) => {
      const button = String(stdout).trim();
      resolve(err ? "later" : button === "同意" ? "approve" : button === "拒绝" ? "decline" : "later");
    });
  });
  return { answer, close: () => child.kill() };
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
    const script = ["on run argv", "activate", `display alert (item 1 of argv) message (item 2 of argv) buttons {"好"} default button "好" giving up after ${WAIT_SECONDS}`, "end run"];
    execFile("osascript", [...script.flatMap((line) => ["-e", line]), title, message], () => {});
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
