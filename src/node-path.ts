import { existsSync } from "node:fs";

// Homebrew runs node from a versioned keg (.../Cellar/node@22/22.22.3/bin/node)
// that disappears on `brew upgrade`. The .../opt/node@22 link always points at
// the installed version, so configs written with it survive upgrades.
export function stableNodePath(execPath = process.execPath, exists: (p: string) => boolean = existsSync): string {
  const keg = execPath.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.+)$/);
  if (!keg) return execPath;
  const linked = `${keg[1]}/opt/${keg[2]}/${keg[3]}`;
  return exists(linked) ? linked : execPath;
}
