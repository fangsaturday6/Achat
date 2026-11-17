import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

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
