// The per-network config artifact — `<net>/convoy.toml`. Records what `convoy init` set up (the network
// NAME, and a megarepo location if the network uses one) so `add`/`up`/`doctor` stay consistent and a
// first-time user has a single reviewable record of their network. It lives at the network-dir root
// (a sibling of smalltalk/ + pty/ + worktrees/), is machine-local (NOT under the synced smalltalk/ root),
// and is best-effort to read (a missing/invalid file just means "no recorded config").

import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";

/** Which ding sidecar a network runs — "node" (smalltalk's `st ding`, the default for everyone) or
 *  "rust" (compoundingtech/ding: full `st ding` parity, ~0% CPU). Both take identical args, so the
 *  choice swaps ONLY the binary. Unset → "node". */
export type DingService = "node" | "rust";

/** The two `DingService` spellings, for validation + completions (a runtime tuple, not just the type). */
export const DING_SERVICES: readonly DingService[] = ["node", "rust"];

export interface NetworkConfig {
  /** The network's name (defaults to the dir basename). */
  name: string;
  /** Absolute path to the megarepo agents cut worktrees off, if the network uses one (else workspaces
   *  are symlinked into worktrees/). Optional — added by the megarepo model. */
  megarepo?: string;
  /** The ding sidecar this network runs (see `DingService`). A per-NETWORK choice, not per-agent: the
   *  ding binary is a runtime dependency of the box hosting the net. Unset → "node" (`st ding`). */
  ding?: DingService;
}

/** True iff `v` is a valid `DingService` spelling. */
export function isDingService(v: unknown): v is DingService {
  return v === "node" || v === "rust";
}

/** The config file location for a network dir: `<dir>/convoy.toml`. */
export function networkConfigPath(dir: string): string {
  return join(dir, "convoy.toml");
}

/** The default network name for a dir — its basename (e.g. `<home>/default` → `default`). */
export function networkNameFromDir(dir: string): string {
  return basename(dir);
}

/** Read `<dir>/convoy.toml`, or null if it's missing/unreadable/nameless. */
export function readNetworkConfig(dir: string): NetworkConfig | null {
  try {
    const doc = tomlParse(readFileSync(networkConfigPath(dir), "utf8")) as Partial<NetworkConfig>;
    if (typeof doc.name !== "string" || doc.name === "") return null;
    return {
      name: doc.name,
      ...(typeof doc.megarepo === "string" && doc.megarepo ? { megarepo: doc.megarepo } : {}),
      ...(isDingService(doc.ding) ? { ding: doc.ding } : {}),
    };
  } catch {
    return null;
  }
}

/** Write `<dir>/convoy.toml` (only the set fields — keeps it minimal + human-readable). */
export function writeNetworkConfig(dir: string, config: NetworkConfig): void {
  const doc: Record<string, unknown> = { name: config.name };
  if (config.megarepo) doc["megarepo"] = config.megarepo;
  if (config.ding) doc["ding"] = config.ding;
  writeFileSync(networkConfigPath(dir), tomlStringify(doc));
}
