// The HARNESS TABLE — one record per supported harness, and the single place convoy encodes an opinion
// about a harness's CLI.
//
// Before this table, `harness` was a two-member union read by a scatter of `if (harness === "codex")`
// branches, each with the claude form as its `else`. That shape has a specific failure mode: adding a
// member is silent. Only ONE site (`HARNESS_SESSION_KEY`) was keyed on the union tightly enough to fail
// the build; every other branch would have quietly treated a new harness as claude — deriving claude's
// flags for a binary that does not accept them.
//
// The table inverts that. A harness is a RECORD of what convoy needs to know, so adding one is a data
// change with a type error at every field that must be decided, and the capability fields make a
// partial citizen say so in its own declaration rather than in a comment somewhere else.
//
// On decision 0005 ("`bin` replaces the harness binary, keeping the derived flags"). That decision
// rejected widening the union, reasoning that an unlisted harness could set `harness` to "the nearest
// CLI-compatible flavor" and point `bin` at itself. It records the cost honestly: "A wrapper must accept
// the harness's flags." For a wrapper around a Claude-compatible harness that holds, and `bin` remains
// the right tool. It does NOT hold for opencode or pi, and not by a margin a wrapper script can close:
//
//   - opencode's positional argument is a PROJECT PATH, not a prompt. `exec opencode '<boot prompt>'`
//     does not pass a prompt that opencode ignores — it asks opencode to cd into a directory named
//     after the entire boot ritual. The prompt must ride `--prompt`.
//   - Neither opencode nor pi accepts `--permission-mode` or `--dangerously-bypass-approvals-and-sandbox`.
//   - `--model` is not portable: opencode wants `provider/model`, pi wants a pattern plus `--provider`.
//
// So "nearest compatible flavor" has no referent for these two. 0005's escape hatch is not weakened by
// this table — it is still how a WRAPPED claude or codex runs, which is what dev3's cos agent does today.
// What the table adds is the case 0005 could not serve: a harness whose CLI is a different shape.

import type { PermissionMode } from "./role.ts";

/** Every harness convoy can launch. A const array (not a bare union) so the CLI's `--harness`
 *  completions can enumerate it at runtime — a type alone is not iterable. */
export const HARNESSES = ["claude", "codex", "opencode", "pi"] as const;
export type Harness = (typeof HARNESSES)[number];

/** What convoy knows about one harness. Every field is something convoy must decide before it can launch
 *  the thing; a `null` is a DECLARED absence, not an oversight, and each one is surfaced to the operator
 *  rather than silently papered over with the claude behavior. */
export interface HarnessDescriptor {
  /** The pty.toml session key — `[sessions.<key>]`. */
  readonly sessionKey: string;
  /** The env var that relocates this harness's whole configuration, and therefore SELECTS ITS ACCOUNT
   *  (decision 0004: an account IS a config dir). `null` = this harness has no such variable, so convoy
   *  cannot select an account for it and must say so instead of accepting a `--config-dir` that would
   *  do nothing. */
  readonly configEnv: string | null;
  /** Does this harness support the MCP transport? When false, convoy coerces to the ding sidecar. */
  readonly supportsMcp: boolean;
  /** Can `convoy doctor` check this harness (version + distill probe)? See src/doctor/checkup.ts. */
  readonly supportsDoctor: boolean;
  /** Can `convoy doctor` probe this harness's auth state? See src/doctor/auth.ts. */
  readonly supportsAuth: boolean;
  /** Build the argument tail after the binary name. `bin` never reaches here — it replaces the binary,
   *  and the tail is derived (0005). The prompt is passed as a single already-quoted `sh -c` argument. */
  readonly argv: (a: { permissionMode: PermissionMode; model: string | null; prompt: string }) => string;
}

/** A single-quoted `sh -c` argument. The prompt is convoy-authored (the boot ritual) and the model id is
 *  charset-validated upstream, so neither can contain a quote today; this keeps that from being load-bearing. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const HARNESS_TABLE: Record<Harness, HarnessDescriptor> = {
  claude: {
    sessionKey: "claude",
    configEnv: "CLAUDE_CONFIG_DIR",
    supportsMcp: true,
    supportsDoctor: true,
    supportsAuth: true,
    argv: ({ permissionMode, model, prompt }) =>
      ` --permission-mode ${permissionMode}${model ? ` --model ${q(model)}` : ""} ${q(prompt)}`,
  },
  codex: {
    sessionKey: "codex",
    configEnv: "CODEX_HOME",
    supportsMcp: false,
    supportsDoctor: true,
    supportsAuth: true,
    argv: ({ model, prompt }) =>
      ` --dangerously-bypass-approvals-and-sandbox${model ? ` --model ${q(model)}` : ""} ${q(prompt)}`,
  },
  // opencode — verified against opencode 1.18.3 --help.
  //
  // The prompt rides `--prompt` because opencode's positional is `[project]`, a path to start in. This is
  // the one place where getting the harness wrong is not a degraded session but a nonsense one.
  //
  // `--auto` ("auto-approve permissions that are not explicitly denied") is the closest analog to the
  // bypass posture every convoy agent runs under, and it is deliberately NOT gated on `permissionMode`:
  // convoy's posture is currently the constant `bypassPermissions` for every agent (agent-spec.ts
  // specPermissionMode), so honoring a mode here would imply a per-agent control that does not exist.
  // opencode has no equivalent of claude's finer modes, so a future non-bypass posture must NOT silently
  // map to `--auto` — see the caveat in the PR body.
  opencode: {
    sessionKey: "opencode",
    // opencode has no config-relocation variable, so convoy cannot select an account for it. Declared
    // null so `--config-dir` is REFUSED rather than injected somewhere it does nothing.
    configEnv: null,
    supportsMcp: false,
    supportsDoctor: false,
    supportsAuth: false,
    argv: ({ model, prompt }) => ` --auto${model ? ` --model ${q(model)}` : ""} --prompt ${q(prompt)}`,
  },
  // pi — verified against pi 0.80.10 --help. The prompt IS positional here ("pi [options] [messages...]").
  //
  // `--approve` is pi's nearest posture flag, but it is NOT a tool-permission bypass: it trusts
  // project-local files for the run. pi may still gate individual tool calls, so a pi agent can stall in
  // a way a claude/codex agent under bypass does not. That is a real limitation, recorded here and in the
  // PR body rather than hidden behind a flag that looks equivalent.
  pi: {
    sessionKey: "pi",
    configEnv: null,
    supportsMcp: false,
    supportsDoctor: false,
    supportsAuth: false,
    argv: ({ model, prompt }) => ` --approve${model ? ` --model ${q(model)}` : ""} ${q(prompt)}`,
  },
};

export function harnessDescriptor(h: Harness): HarnessDescriptor {
  return HARNESS_TABLE[h];
}

/** Is `s` a harness convoy supports? The one predicate every `--harness` validator and the agent-file
 *  parser share, so the accepted set cannot drift between the CLI and the catalog. */
export function isHarness(s: unknown): s is Harness {
  return typeof s === "string" && (HARNESSES as readonly string[]).includes(s);
}

/** The `want: …` fragment for an invalid-harness error, derived from the table so a new member shows up
 *  in every message without anyone remembering to update it. */
export const HARNESS_LIST = HARNESSES.join(" | ");

/** Harnesses convoy can run but NOT fully support — the partial citizens. Derived, so this list cannot
 *  disagree with the table it describes. */
export function harnessLimitations(h: Harness): string[] {
  const d = HARNESS_TABLE[h];
  const out: string[] = [];
  if (d.configEnv === null) out.push("no account selection (the harness has no config-relocation env var)");
  if (!d.supportsDoctor) out.push("no `convoy doctor` checkup (no version floor, no distill probe)");
  if (!d.supportsAuth) out.push("no auth probe (`convoy doctor` cannot tell you if it is logged in)");
  if (!d.supportsMcp) out.push("no MCP transport (coerced to the ding sidecar)");
  return out;
}
