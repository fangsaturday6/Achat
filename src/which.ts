import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function onPath(command: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Where the ChatGPT and Codex desktop apps on macOS keep the Codex CLI they
// run. It is updated with the app, while one installed with npm is often far
// behind and cannot use the model the person's settings pick.
const BUNDLED_CODEX = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
];

// The codex command to run: ACHAT_CODEX_BIN if set, else the one a desktop
// app brings, else `codex` on the PATH.
export function codexCommand(env: NodeJS.ProcessEnv = process.env, bundled = BUNDLED_CODEX): string {
  if (env.ACHAT_CODEX_BIN) return env.ACHAT_CODEX_BIN;
  return bundled.find((path) => existsSync(path)) ?? "codex";
}

// Where the Claude desktop app on macOS keeps the Claude Code it runs, one
// folder per version: <version>/<build>/claude.app/Contents/MacOS/claude.
// It is updated with the app, while one installed with Homebrew or npm is
// often far behind: an old one starts on an older model, and its "opus" is
// an older Opus (2.1.205 starts on Opus 4.8; 2.1.326 on Opus 5.5).
export function bundledClaude(root = join(homedir(), "Library", "Application Support", "Claude", "claude-code")): string | null {
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const parts = (v: string) => v.split(".").map(Number);
  const newest = list(root)
    .filter((v) => /^\d+(\.\d+)*$/.test(v))
    .sort((a, b) => {
      const [x, y] = [parts(a), parts(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
      return 0;
    });
  for (const version of newest) {
    for (const build of list(join(root, version))) {
      const bin = join(root, version, build, "claude.app", "Contents", "MacOS", "claude");
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

// The claude command to run: ACHAT_CLAUDE_BIN if set, else the newest one the
// desktop app brings, else `claude` on the PATH.
export function claudeCommand(env: NodeJS.ProcessEnv = process.env, bundled: () => string | null = bundledClaude): string {
  if (env.ACHAT_CLAUDE_BIN) return env.ACHAT_CLAUDE_BIN;
  return bundled() ?? "claude";
}
