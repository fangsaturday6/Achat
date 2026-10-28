import { execFileSync } from "node:child_process";
import { hostname, platform } from "node:os";
import { RelayClient, RelayClientError, type DeviceLinkTicket } from "./client.js";
import { DEFAULT_CLOUD_URL, loadConfig, updateConfig, type AchatConfig } from "./config.js";
import { defaultKeyStore, ensureDeviceKey, forgetDeviceKey, loadDeviceKey, type KeyStore } from "./device.js";
import { onPath } from "./which.js";

function computerName(): string {
  if (platform() === "darwin") {
    try {
      return execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim();
    } catch {
      // fall back to the host name
    }
  }
  return hostname().replace(/\.local$/, "");
}

export function cloudUrlFor(cfg: AchatConfig, given?: string): string {
  const url = (given ?? cfg.cloud?.url ?? DEFAULT_CLOUD_URL).trim().replace(/\/+$/, "");
  if (!url) throw new Error("还不知道 Achat 服务的地址。运行 achat link <地址>，例如 achat link https://achat.example.com");
  if (!/^https?:\/\//.test(url)) throw new Error(`Achat 服务的地址要以 https:// 开头：${url}`);
  return url;
}

// Asks the cloud to add this computer to an account. The person opens the
// returned link, logs in and confirms; until then nothing changes locally
// except that config.json remembers the pending link.
export async function startLink(url?: string, keys: KeyStore = defaultKeyStore()): Promise<DeviceLinkTicket> {
  const cfg = loadConfig();
  if (cfg.cloud?.linked) throw new Error(`这台电脑已经加入了 Achat 账号（${cfg.cloud.url}）。要换账号，先运行 achat unlink`);
  const server = cloudUrlFor(cfg, url);
  const clients = [...new Set(cfg.agents.map((a) => a.client))].filter((c) => onPath(c));
  if (!clients.length) throw new Error("这台电脑上没有找到 Claude Code 或 Codex");
  const key = ensureDeviceKey(keys);
  const ticket = await new RelayClient(server, key).createDeviceLink({
    publicKey: key.publicKey,
    name: computerName(),
    clients,
  });
  updateConfig({ cloud: { url: server, linked: false } });
  return ticket;
}

// Checks whether the person has confirmed a pending link, and records it.
export async function checkLink(keys: KeyStore = defaultKeyStore()): Promise<string | null> {
  const cfg = loadConfig();
  const key = loadDeviceKey(keys);
  if (!cfg.cloud || !key) return null;
  try {
    const me = await new RelayClient(cfg.cloud.url, key).me();
    if (!cfg.cloud.linked) updateConfig({ cloud: { url: cfg.cloud.url, linked: true } });
    return me.account.name;
  } catch (err) {
    if (err instanceof RelayClientError && err.status === 401) return null;
    throw err;
  }
}

// Takes this computer off its account and throws its key away, so the
// computer can be handed to someone else.
export async function unlink(keys: KeyStore = defaultKeyStore()): Promise<string> {
  const cfg = loadConfig();
  const key = loadDeviceKey(keys);
  let note = "";
  if (cfg.cloud?.linked && key) {
    try {
      await new RelayClient(cfg.cloud.url, key).removeDevice(key.deviceId);
    } catch {
      note = "没能连上 Achat 服务，这台电脑可能还显示在账号里，可以在网页的“我”里移除。";
    }
  }
  forgetDeviceKey(keys);
  updateConfig({ cloud: undefined });
  return `这台电脑已经退出 Achat 账号，本机钥匙已删除。${note}`;
}
