import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// A release is the built package people's computers run. Its manifest lists
// every file with its SHA-256 and is signed with the release key, which stays
// on the computer that deploys. Computers update only to a release whose
// signature checks out against the public key below, so whoever controls the
// server cannot push code to them.
export const RELEASE_FILES = ["package.json", "package-lock.json", "dist", "web"];
export const MANIFEST = "release.json";
export const SIGNATURE = "release.sig";

// The public half of the release key (Ed25519, SPKI DER in base64).
const RELEASE_KEY = "MCowBQYDK2VwAyEAUV3IU/oXc+5ZU2nOG7gMX7u4WSPxSEeDUsRUmukfNqk=";

export interface Release {
  // Short hash of the files; the same files give the same version.
  version: string;
  // When it was signed. Computers never go back to an older release.
  builtAt: string;
  // Path → SHA-256 in hex.
  files: Record<string, string>;
}

export function releaseKey(): KeyObject {
  return createPublicKey({ key: Buffer.from(RELEASE_KEY, "base64"), format: "der", type: "spki" });
}

export function releaseKeyPath(): string {
  return process.env.ACHAT_RELEASE_KEY ?? join(homedir(), ".config", "achat", "release-key.pem");
}

// Every file under `entries` of root, path → SHA-256. Links are refused, so a
// download cannot reach outside the folder it is unpacked in.
export function hashFiles(root: string, entries: string[]): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (path: string): void => {
    const stat = lstatSync(join(root, path));
    if (stat.isDirectory()) {
      for (const name of readdirSync(join(root, path)).sort()) walk(`${path}/${name}`);
    } else if (stat.isFile()) {
      files[path] = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
    } else {
      throw new Error(`安装包里不该有这个文件：${path}`);
    }
  };
  for (const entry of entries) walk(entry);
  return files;
}

// Writes release.json and release.sig next to the built package.
export function signRelease(root: string, key: KeyObject, now = new Date()): Release {
  const files = hashFiles(root, RELEASE_FILES);
  const version = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 12);
  const release: Release = { version, builtAt: now.toISOString(), files };
  const manifest = JSON.stringify(release, null, 2) + "\n";
  writeFileSync(join(root, MANIFEST), manifest);
  writeFileSync(join(root, SIGNATURE), sign(null, Buffer.from(manifest), key).toString("base64") + "\n");
  return release;
}

// `achat release`: signs the package with the key kept on this computer.
export function signPackage(root: string): string {
  const path = releaseKeyPath();
  if (!existsSync(path)) {
    throw new Error(`找不到发布私钥 ${path}。电脑只会自动更新到签过名的版本，私钥只存在负责部署的电脑上。`);
  }
  const key = createPrivateKey(readFileSync(path));
  const matches = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64") === RELEASE_KEY;
  if (!matches) throw new Error(`${path} 和代码里的发布公钥（src/release.ts）对不上，签了名电脑也不会装。`);
  const release = signRelease(root, key);
  return `已签名：版本 ${release.version}，${Object.keys(release.files).length} 个文件`;
}

// The manifest, once its signature checks out.
export function openRelease(manifest: string, signature: string, key = releaseKey()): Release {
  if (!verify(null, Buffer.from(manifest), key, Buffer.from(signature.trim(), "base64"))) {
    throw new Error("新版本的签名不对，没有安装");
  }
  return JSON.parse(manifest) as Release;
}

// Throws unless the unpacked folder holds exactly the files the release lists.
export function checkFiles(root: string, release: Release): void {
  const entries = readdirSync(root).filter((name) => name !== MANIFEST && name !== SIGNATURE);
  const found = hashFiles(root, entries);
  for (const path of new Set([...Object.keys(found), ...Object.keys(release.files)])) {
    if (found[path] !== release.files[path]) throw new Error(`新版本的文件和签名对不上：${path}`);
  }
}

// The release a package folder was installed from, as written there; null for
// copies installed before releases were signed.
export function installedRelease(root: string): Release | null {
  try {
    return JSON.parse(readFileSync(join(root, MANIFEST), "utf8")) as Release;
  } catch {
    return null;
  }
}
