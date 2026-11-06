import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { KeyObject } from "node:crypto";
import { achatHome } from "./config.js";
import { checkFiles, installedRelease, MANIFEST, openRelease, SIGNATURE, type Release } from "./release.js";

const run = promisify(execFile);
// A step that hangs, for example on a network that drops npm, gives up after
// this, and the next check tries again.
const NPM_TIMEOUT_MS = 10 * 60 * 1000;
const STEP_TIMEOUT_MS = 2 * 60 * 1000;

// Where deploy/client-install.sh puts Achat. Only this copy updates itself;
// a copy run from a checkout of the code is updated with git.
export function appDir(): string {
  return join(achatHome(), "app");
}

export function isInstalledCopy(packageRoot: string): boolean {
  try {
    return realpathSync(packageRoot) === realpathSync(appDir());
  } catch {
    return false;
  }
}

export interface UpdateOptions {
  // The Achat service this computer belongs to.
  url: string;
  app?: string;
  key?: KeyObject;
  // Installs the packages of the folder; npm ci by default.
  installDeps?: (dir: string) => Promise<void>;
  // Throws if the folder's code does not load; by default it imports the
  // background service and the MCP server from it.
  check?: (dir: string) => Promise<void>;
}

export interface Staged {
  dir: string;
  release: Release;
}

async function npmCi(dir: string): Promise<void> {
  // npm is next to the node running Achat, also when launchd started it.
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` };
  const args = ["ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"];
  const registry = process.env.ACHAT_NPM_REGISTRY ?? "https://registry.npmmirror.com";
  try {
    await run("npm", [...args, `--registry=${registry}`], { cwd: dir, env, timeout: NPM_TIMEOUT_MS });
  } catch {
    await run("npm", args, { cwd: dir, env, timeout: NPM_TIMEOUT_MS });
  }
}

async function loads(dir: string): Promise<void> {
  const modules = ["daemon.js", "mcp/server.js"].map((m) => JSON.stringify(pathToFileURL(join(dir, "dist", m)).href));
  await run(process.execPath, ["--no-warnings", "--input-type=module", "-e", modules.map((m) => `await import(${m});`).join(" ")], {
    timeout: STEP_TIMEOUT_MS,
  });
}

function untar(archive: Buffer, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-xzf", "-", "-C", dir], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    tar.stderr.on("data", (d) => (err += d));
    tar.on("error", reject);
    tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`解压新版本失败：${err.trim()}`))));
    tar.stdin.end(archive);
  });
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok && res.status !== 404) throw new Error(`下载 ${url} 失败：${res.status}`);
  return res;
}

// Downloads the service's release when it is newer than the installed one,
// checks its signature and every file, and installs its packages in a folder
// beside the running copy, which keeps working meanwhile. Null when there is
// nothing newer, or the service has no signed release.
export async function stageUpdate(opts: UpdateOptions): Promise<Staged | null> {
  const app = opts.app ?? appDir();
  const offer = await get(`${opts.url}/download/release`);
  if (offer.status === 404) return null;
  const { manifest, signature } = (await offer.json()) as { manifest: string; signature: string };
  const release = openRelease(manifest, signature, opts.key);
  const current = installedRelease(app);
  if (current && (current.version === release.version || current.builtAt >= release.builtAt)) return null;

  const dir = `${app}.new`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const archive = await get(`${opts.url}/download/achat.tgz`);
    await untar(Buffer.from(await archive.arrayBuffer()), dir);
    checkFiles(dir, release);
    // The copies in the download are not trusted; these are the checked ones.
    writeFileSync(join(dir, MANIFEST), manifest);
    writeFileSync(join(dir, SIGNATURE), signature);
    await (opts.installDeps ?? npmCi)(dir);
    await (opts.check ?? loads)(dir);
    return { dir, release };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

// Puts a staged copy where the installed one was.
export function switchTo(staged: Staged, app = appDir()): void {
  const old = `${app}.old`;
  rmSync(old, { recursive: true, force: true });
  if (existsSync(app)) renameSync(app, old);
  try {
    renameSync(staged.dir, app);
  } catch (err) {
    if (existsSync(old)) renameSync(old, app);
    throw err;
  }
  rmSync(old, { recursive: true, force: true });
}

// The new code writes its MCP config, reminder hook and Achat skill, so the
// AIs get its tools and rules; `autostart` also restarts the background service.
export async function setupWith(app: string, autostart: boolean): Promise<string> {
  const args = [join(app, "dist", "cli.js"), "setup", ...(autostart ? [] : ["--no-autostart"])];
  const { stdout } = await run(process.execPath, args, { timeout: STEP_TIMEOUT_MS });
  return stdout.trim();
}
