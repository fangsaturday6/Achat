import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

export interface ApprovalPrompt {
  title: string; // 老王的 Codex 想问你的 Claude
  topic: string;
  body: string;
  scope: string; // 只读 · 5 轮 · $5.00
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
  return [p.topic, "", body, "", p.scope].join("\n");
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
// never approves anything.
function macAlert(p: ApprovalPrompt): Asking {
  const script = [
    "on run argv",
    "activate",
    `display alert (item 1 of argv) message (item 2 of argv) buttons {"稍后", "拒绝", "同意"} default button "稍后" cancel button "稍后" giving up after ${WAIT_SECONDS}`,
    "return button returned of result",
    "end run",
  ];
  let child!: ChildProcess;
  const answer = new Promise<Answer>((resolve) => {
    child = execFile("osascript", [...script.flatMap((line) => ["-e", line]), p.title, message(p)], (err, stdout) => {
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

// A dialog in the middle of the screen, on macOS and on Linux desktops with
// zenity; elsewhere the caller falls back to a notification.
export const desktopAsk: Asker = (p) => {
  const os = platform();
  if (os === "darwin") return macAlert(p);
  if (os === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && onPath("zenity")) return zenity(p);
  return null;
};
