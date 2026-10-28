import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { achatHome } from "./config.js";

const LABEL = "local.achat";

export interface AutostartPlan {
  // The launchd or systemd file that starts `achat start --wait` at login.
  path: string;
  content: string;
  // Where the service's output goes.
  log: string;
  // Stops and unloads the service; fails harmlessly when it is not loaded.
  stop: string[][];
  // Loads and starts the service from `path`.
  start: string[][];
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

// The service keeps the PATH of the terminal that ran setup, so it finds
// claude, codex and node the same way that terminal does.
export function autostartPlan(
  cliPath: string,
  opts: { node?: string; os?: NodeJS.Platform; home?: string; path?: string; uid?: number } = {},
): AutostartPlan | null {
  const node = opts.node ?? process.execPath;
  const os = opts.os ?? platform();
  const home = opts.home ?? homedir();
  const path = opts.path ?? process.env.PATH ?? "";
  const command = [node, cliPath, "start", "--wait"];

  if (os === "darwin") {
    const uid = opts.uid ?? userInfo().uid;
    const log = join(achatHome(), "achat.log");
    const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((c) => `    <string>${xml(c)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
    return {
      path: plist,
      content,
      log,
      stop: [["launchctl", "bootout", `gui/${uid}/${LABEL}`]],
      start: [["launchctl", "bootstrap", `gui/${uid}`, plist]],
    };
  }

  if (os === "linux") {
    const unit = join(home, ".config", "systemd", "user", "achat.service");
    const content = `[Unit]
Description=Achat

[Service]
ExecStart=${command.map(systemdQuote).join(" ")}
Environment=${systemdQuote(`PATH=${path}`)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    return {
      path: unit,
      content,
      log: "journalctl --user -u achat",
      stop: [["systemctl", "--user", "disable", "--now", "achat.service"]],
      start: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "achat.service"],
      ],
    };
  }

  return null;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(commands: string[][], ignoreFailures: boolean): void {
  for (const [cmd, ...args] of commands) {
    // launchctl bootstrap fails for a moment while a bootout is finishing.
    for (let attempt = 1; ; attempt++) {
      try {
        execFileSync(cmd, args, { stdio: "ignore" });
        break;
      } catch (err) {
        if (ignoreFailures) break;
        if (attempt === 3) throw err;
        sleep(1000);
      }
    }
  }
}

export function enableAutostart(cliPath: string): string {
  const plan = autostartPlan(cliPath);
  if (!plan) return "这台电脑还不支持开机自启，需要时在终端运行 achat start。";
  run(plan.stop, true);
  mkdirSync(dirname(plan.path), { recursive: true });
  mkdirSync(achatHome(), { recursive: true, mode: 0o700 });
  writeFileSync(plan.path, plan.content);
  run(plan.start, false);
  return `Achat 已在后台运行，开机后会自动启动（日志：${plan.log}）。`;
}

export function disableAutostart(cliPath: string): string {
  const plan = autostartPlan(cliPath);
  if (!plan || !existsSync(plan.path)) return "没有设置开机自启。";
  run(plan.stop, true);
  rmSync(plan.path);
  return "已关闭开机自启，后台的 Achat 也停止了。需要时在终端运行 achat start。";
}
