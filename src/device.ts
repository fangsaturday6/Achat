import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { achatHome, type AgentClient } from "./config.js";

// Each computer has its own Ed25519 key, like an SSH key. The cloud stores the
// public half when the person adds the computer to their account; every
// request from the computer is signed with the private half.

export interface DeviceKey {
  deviceId: string;
  // SPKI DER, base64.
  publicKey: string;
  privateKey: KeyObject;
}

export function deviceIdFor(publicKey: string): string {
  return "d_" + createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("base64url").slice(0, 16);
}

// An AI's id on the cloud is fixed by the computer it runs on, so the
// computer can work out its own AIs' ids from its key.
export function agentIdFor(deviceId: string, client: AgentClient): string {
  return `${deviceId}/${client}`;
}

// Shown on the computer and on the confirmation page, so the person can tell
// that the computer they are adding is the one in front of them.
export function pairingCode(deviceId: string): string {
  const n = createHash("sha256").update(deviceId).digest().readUInt32BE(0) % 1_000_000;
  const digits = String(n).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

function fromPkcs8(pkcs8: string): DeviceKey {
  const privateKey = createPrivateKey({ key: Buffer.from(pkcs8, "base64"), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
  return { deviceId: deviceIdFor(publicKey), publicKey, privateKey };
}

export interface KeyStore {
  // The private key as PKCS#8 DER, base64; null when there is none.
  load(): string | null;
  save(pkcs8: string): void;
  remove(): void;
}

// The login keychain on macOS. Only this system user can read it. Reading
// starts a process, so the key is kept in memory after the first read.
export class KeychainStore implements KeyStore {
  private args = ["-s", "Achat", "-a", "device-key"];
  private loaded: string | null | undefined;

  load(): string | null {
    if (this.loaded !== undefined) return this.loaded;
    try {
      this.loaded = execFileSync("security", ["find-generic-password", ...this.args, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // Not cached: the key may be created later by another process.
      return null;
    }
    return this.loaded;
  }

  save(pkcs8: string): void {
    execFileSync("security", ["add-generic-password", "-U", ...this.args, "-w", pkcs8], { stdio: "ignore" });
    this.loaded = pkcs8;
  }

  remove(): void {
    this.loaded = undefined;
    try {
      execFileSync("security", ["delete-generic-password", ...this.args], { stdio: "ignore" });
    } catch {
      // nothing to remove
    }
  }
}

// A file readable only by this system user, for systems without a keychain.
// Without a path it lives in ACHAT_HOME as it is when used.
export class FileKeyStore implements KeyStore {
  constructor(private fixedPath?: string) {}

  private get path(): string {
    return this.fixedPath ?? join(achatHome(), "device.key");
  }

  load(): string | null {
    return existsSync(this.path) ? readFileSync(this.path, "utf8").trim() : null;
  }

  save(pkcs8: string): void {
    mkdirSync(achatHome(), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, pkcs8 + "\n", { mode: 0o600 });
  }

  remove(): void {
    rmSync(this.path, { force: true });
  }
}

let defaultStore: KeyStore | null = null;

export function defaultKeyStore(): KeyStore {
  defaultStore ??=
    platform() === "darwin" && process.env.ACHAT_KEYSTORE !== "file" ? new KeychainStore() : new FileKeyStore();
  return defaultStore;
}

const parsed = new Map<string, DeviceKey>();

export function loadDeviceKey(store: KeyStore = defaultKeyStore()): DeviceKey | null {
  const pkcs8 = store.load();
  if (!pkcs8) return null;
  let key = parsed.get(pkcs8);
  if (!key) {
    key = fromPkcs8(pkcs8);
    parsed.set(pkcs8, key);
  }
  return key;
}

export function ensureDeviceKey(store: KeyStore = defaultKeyStore()): DeviceKey {
  const existing = loadDeviceKey(store);
  if (existing) return existing;
  const { privateKey } = generateKeyPairSync("ed25519");
  store.save(privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
  return loadDeviceKey(store)!;
}

export function forgetDeviceKey(store: KeyStore = defaultKeyStore()): void {
  store.remove();
}

// What a signature covers: the request line, the time and the body, so a
// signed request cannot be replayed later or with another body.
function canonical(method: string, pathAndQuery: string, time: string, body: string): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return ["achat-v1", method.toUpperCase(), pathAndQuery, time, digest].join("\n");
}

export function signRequest(
  key: DeviceKey,
  method: string,
  pathAndQuery: string,
  body = "",
  now = Date.now(),
): Record<string, string> {
  const time = String(now);
  const signature = sign(null, Buffer.from(canonical(method, pathAndQuery, time, body)), key.privateKey);
  return {
    "x-achat-device": key.deviceId,
    "x-achat-time": time,
    "x-achat-signature": signature.toString("base64"),
  };
}

export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

// Checks a request signed by the key `publicKey`. Returns null when it is
// valid, otherwise the reason.
export function checkSignature(
  publicKey: string,
  headers: { time?: string; signature?: string },
  method: string,
  pathAndQuery: string,
  body: string,
  now = Date.now(),
): string | null {
  if (!headers.time || !headers.signature) return "缺少签名";
  const time = Number(headers.time);
  if (!Number.isFinite(time) || Math.abs(now - time) > SIGNATURE_WINDOW_MS) return "签名已过期，检查这台电脑的时间是否准确";
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    const ok = verify(
      null,
      Buffer.from(canonical(method, pathAndQuery, headers.time, body)),
      key,
      Buffer.from(headers.signature, "base64"),
    );
    return ok ? null : "签名不对";
  } catch {
    return "签名不对";
  }
}
