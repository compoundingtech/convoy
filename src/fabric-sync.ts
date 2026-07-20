// convoy DECLARES its catalog to fabric's `fabric sync` primitive — the cross-machine transport that makes the
// declarative arc real: a `host=B` agent file dropped on machine A propagates to B, and B's `convoy up`
// reconcile sees host==B + launches it. fabric OWNS the sync (a config-driven, fs-watched, ALWAYS-ON daemon —
// never a convoy-up child); convoy just writes a `[[sync]]` entry into fabric's `syncs.toml` declaring its
// catalog dir + policy. convoy does NOT sync anything itself. Policy = "catalog" (union / newer-wins /
// NO-delete-on-peer / no-sweep / no-tombstones), which is exactly convoy's decommission model: a `retired=true`
// EDIT is a newer version that wins everywhere, and a catalog file is NEVER removed (a local delete is restored).

import { resolve } from "node:path";
import { run } from "./exec.ts";
import { networkNameFromDir } from "./network-config.ts";
import { catalogDir } from "./agent-file.ts";

/** The shared fabric-sync NAME for a network's catalog: `convoy-catalog-<network-name>`. The SAME name on every
 *  machine ties their local catalog folders into one sync (fabric keys a sync by name); DISTINCT per network so
 *  a box hosting multiple networks (e.g. `default` + `staging`) declares one entry each, no collision. Pure. */
export function catalogSyncName(networkDir: string): string {
  return `convoy-catalog-${networkNameFromDir(networkDir)}`;
}

/** The `fabric sync add` argv convoy runs to declare a network's catalog: folder = the ABSOLUTE catalog dir,
 *  the shared per-network `--name`, `--peers *` (follows peers.toml — a newly-trusted machine like hetz is
 *  auto-included, entry never changes), `--policy catalog`, `--include *.toml` (only agent files sync — guards
 *  against a stray non-agent file in the dir). Pure → unit-testable without running fabric. */
export function fabricSyncAddArgv(networkDir: string): string[] {
  return ["sync", "add", resolve(catalogDir(networkDir)), "--name", catalogSyncName(networkDir), "--peers", "*", "--policy", "catalog", "--include", "*.toml"];
}

/** Is `fabric sync` available here? A capability probe (best-effort): `fabric sync --help` exits 0 when the
 *  subcommand exists, non-zero ("unrecognized subcommand") on an old fabric, and run() resolves non-ok when
 *  `fabric` isn't installed — all → false. Never throws. Injectable exec for tests. */
export async function fabricSyncAvailable(exec: typeof run = run): Promise<boolean> {
  try {
    return (await exec("fabric", ["sync", "--help"])).ok;
  } catch {
    return false;
  }
}

export interface DeclareResult { declared: boolean; name: string; reason?: string }

/** DECLARE a network's catalog to `fabric sync` (idempotent add-or-update; writes fabric's syncs.toml + reloads
 *  a running daemon). Best-effort + VERSION-GATED: if `fabric sync` isn't available (fabric absent or pre-sync)
 *  it returns declared:false with a reason and NEVER fails the caller — convoy still works single-machine, just
 *  without cross-machine catalog propagation. Returns whether the entry was declared + the shared name. fabric
 *  OWNS the transport; this only writes the declaration. Injectable exec for tests. */
export async function declareCatalogSync(networkDir: string, exec: typeof run = run): Promise<DeclareResult> {
  const name = catalogSyncName(networkDir);
  if (!(await fabricSyncAvailable(exec))) {
    return { declared: false, name, reason: "`fabric sync` unavailable (fabric missing or pre-sync) — the catalog won't propagate cross-machine; install/update fabric to enable it" };
  }
  const r = await exec("fabric", fabricSyncAddArgv(networkDir));
  if (!r.ok) return { declared: false, name, reason: `fabric sync add failed: ${(r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.status}`}` };
  return { declared: true, name };
}
