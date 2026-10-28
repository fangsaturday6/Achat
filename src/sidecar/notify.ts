import { execFile } from "node:child_process";
import { platform } from "node:os";

export type Notifier = (title: string, body: string, url: string) => void;

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Shows a desktop notification. Clicking through is not wired up yet, so the
// URL also goes to the terminal running the sidecar.
export const desktopNotify: Notifier = (title, body, url) => {
  console.log(`[achat] ${title} · ${body} → ${url}`);
  const os = platform();
  if (os === "darwin") {
    const script = `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`;
    execFile("osascript", ["-e", script], () => {});
  } else if (os === "linux") {
    execFile("notify-send", [title, body], () => {});
  }
};
