// Shared path helpers. Kept dependency-light so both the CLI handlers (commands.ts) and the supervisor
// (up.ts) can import it without a heavy/circular dependency.

import { homedir } from "node:os";
import { join } from "node:path";

/** The per-workspace overlay directory convoy writes into a composed repo: `<workspace>/.convoy/`
 *  holds PERSONA.md, DING-BUS.md, and pty.toml — everything moved OUT of the repo root so the product
 *  repo stays pristine. The whole dir is git-excluded (`.git/info/exclude`). Shared so launch.ts (write),
 *  host.ts (read the manifest + derive the workspace from the ptyfile tag), and commands.ts (clobber
 *  guard / reload) all agree on the location. */
export const CONVOY_DIR = ".convoy";

/** convoy's OWN default network location: `($XDG_STATE_HOME | ~/.local/state)/convoy`.
 *
 *  This is EXACTLY where the live network already sits, so adopting it as the default is
 *  backward-compatible. It gives convoy a default of its own instead of falling through to st/pty's
 *  `~/.local/state/smalltalk` when `ST_ROOT` is unset — the mismatch behind the fleet
 *  15-dings-on-the-wrong-root incident, and the reason a newcomer had to know a dir/env to get started.
 *
 *  It is ONLY the last-resort fallback: an explicit network arg, `--network`, or ambient `ST_ROOT` all
 *  still win. Standalone `st` keeps its OWN default (`~/.local/state/smalltalk`) — this changes only how
 *  CONVOY resolves its default. Named / multi-network homes are a separate future thread (this stays flat:
 *  the default IS `<state>/convoy`, never a `<state>/convoy/default` subdir). */
export function defaultConvoyNetwork(): string {
  return join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "convoy");
}
