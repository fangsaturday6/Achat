import { execFile, execFileSync } from "node:child_process";
import { platform } from "node:os";

export type Notifier = (title: string, body: string, url: string) => void;

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

let terminalNotifier: boolean | undefined;

// terminal-notifier (brew install terminal-notifier) can open a URL when the
// notification is clicked; osascript cannot.
function hasTerminalNotifier(): boolean {
  if (terminalNotifier === undefined) {
    try {
      execFileSync("which", ["terminal-notifier"], { stdio: "ignore" });
      terminalNotifier = true;
    } catch {
      terminalNotifier = false;
    }
  }
  return terminalNotifier;
}

// Shows a desktop notification. The URL also goes to the log, for systems
// where clicking the notification does not open it.
export const desktopNotify: Notifier = (title, body, url) => {
  console.log(`[achat] ${title} · ${body} → ${url}`);
  const os = platform();
  if (os === "darwin" && hasTerminalNotifier()) {
    execFile("terminal-notifier", ["-title", title, "-message", body, "-open", url, "-group", "achat"], () => {});
  } else if (os === "darwin") {
    const script = `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`;
    execFile("osascript", ["-e", script], () => {});
  } else if (os === "linux") {
    execFile("notify-send", [title, body], () => {});
  }
};
