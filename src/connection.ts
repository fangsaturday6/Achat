import { RelayClient } from "./client.js";
import { loadConfig, relayUrl, type AchatConfig } from "./config.js";
import { agentIdFor, defaultKeyStore, loadDeviceKey, type KeyStore } from "./device.js";

// Where this computer's AI tools, hook and sidecar talk to: the local relay,
// or, once the computer has joined an account, the cloud.
export interface Connection {
  mode: "local" | "cloud";
  client: RelayClient;
  // The page where people see and approve threads.
  webUrl: string;
  deviceId: string | null;
  // Maps an AI listed in config.json (claude@local) to its id on the relay.
  agentId(localId: string): string;
}

export function connect(cfg: AchatConfig = loadConfig(), keys: KeyStore = defaultKeyStore()): Connection {
  const key = cfg.cloud?.linked ? loadDeviceKey(keys) : null;
  if (cfg.cloud?.linked && key) {
    return {
      mode: "cloud",
      client: new RelayClient(cfg.cloud.url, key),
      webUrl: cfg.cloud.url,
      deviceId: key.deviceId,
      agentId: (localId) => {
        const agent = cfg.agents.find((a) => a.id === localId);
        return agent ? agentIdFor(key.deviceId, agent.client) : localId;
      },
    };
  }
  return {
    mode: "local",
    client: new RelayClient(relayUrl(cfg), cfg.token),
    webUrl: relayUrl(cfg),
    deviceId: null,
    agentId: (localId) => localId,
  };
}
