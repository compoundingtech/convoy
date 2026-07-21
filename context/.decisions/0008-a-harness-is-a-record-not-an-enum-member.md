# 0008 — A harness is a record of capabilities, not an enum member

Status: accepted

Supersedes the "widen the union" option rejected in
[0005](0005-bin-replaces-the-harness-binary.md), and narrows that decision's scope
rather than reversing it.

## Context

`Harness` was `"claude" | "codex"`. Two things were blocked on it.

**Codex account selection.** Reported as "a codex agent has no way to select an
account". This turned out to be mostly wrong: decision 0004 put credential
selection in the spec's `env` block, and `env` is spread verbatim into the
derived harness session, so `CODEX_HOME` already reached a codex agent. The
missing half was that convoy did not *know* the config had moved. `configDir` —
the projection of `env` that the imperative CLI and pre-trust both read — was
hardcoded to `CLAUDE_CONFIG_DIR`. Three consequences, all silent:

- `--config-dir` on a codex session set `CLAUDE_CONFIG_DIR`, which codex does not
  read. The flag reported success and selected nothing; the agent ran as whatever
  account was ambient.
- A codex spec's `CODEX_HOME` never became `configDir`, so pre-trust seeded
  `~/.codex/config.toml` while the agent read `$CODEX_HOME/config.toml`. codex's
  `--dangerously-bypass-approvals-and-sandbox` does *not* skip the directory-trust
  prompt, so the agent stalls on a dialog rather than failing.
- `convoy pretrust` refused `--config-dir` for codex on the grounds that it
  "applies only to claude". That was true of the implementation, not of codex.

**opencode and pi could not be declared.** 0005 anticipated this and offered an
escape hatch: set `bin` to the wrapper and `harness` to "the nearest
CLI-compatible flavor", accepting that "a wrapper must accept the harness's
flags."

## Options

**Keep the union closed; rely on `bin` (0005's answer).** Checked against the
real binaries, "nearest compatible flavor" has no referent for these two:

- opencode's positional argument is a **project path**. `exec opencode '<boot
  prompt>'` does not pass a prompt opencode ignores — it asks opencode to start
  in a directory named after the entire boot ritual. The prompt must ride
  `--prompt`.
- Neither opencode nor pi accepts `--permission-mode` or
  `--dangerously-bypass-approvals-and-sandbox`.
- `--model` is not portable: opencode wants `provider/model`, pi wants a pattern
  plus `--provider`.

A wrapper script could swallow the flags, but it cannot rescue a prompt that has
already been consumed as a path. The escape hatch works for a wrapped *claude* or
*codex* — which is what it was built for, and what dev3's CoS uses today — and
not for a harness whose CLI is a different shape.

**Add members to the union.** Adding a member was silent: exactly one site
(`HARNESS_SESSION_KEY`) was typed tightly enough to fail the build. Every other
branch was `if (harness === "codex") … else <the claude form>`, so a new harness
would have been treated as claude everywhere — and `doctor`/`auth` kept their own
*shadow* copies of the union, so they would not even have failed to compile.
Verified on main: rendering an unlisted harness emits `[sessions.undefined]`.

**Make a harness a record.**

## Decision

A harness is a `HarnessDescriptor` in one table (`src/harness.ts`): its pty
session key, its config-relocation env var (`null` = it has none), whether it
supports MCP, whether convoy can run a doctor checkup or an auth probe for it,
and a function deriving its argument tail. `HARNESSES` is widened to
`claude | codex | opencode | pi`.

Every consumer reads the table. `doctor` and `auth` import the canonical type
instead of shadowing it, and their per-harness records are `Partial` — because
they *are* partial — so an unsupported harness is absent rather than defaulted
into another harness's entry.

`configDir` becomes "the harness's own config dir": `CLAUDE_CONFIG_DIR` for
claude, `CODEX_HOME` for codex, and refused for a harness whose `configEnv` is
`null`. `env` remains the general seam of 0004; `configDir` is the projection of
it convoy needs as a single value.

0005 is otherwise unchanged: `bin` still replaces only the binary name, and every
flag is still derived. `bin` is additionally exposed on `convoy run`, which
replaces the ad-hoc launcher aliases — those aliases *were* wrappers, so the path
replacing them must be able to point at one.

## Consequences

- opencode and pi are **partial citizens, by declaration**. They launch with
  correct flags. They get no account selection (neither has a config-relocation
  variable, so convoy cannot select one and says so instead of accepting a
  `--config-dir` that would do nothing), no doctor checkup, no auth probe, and no
  MCP transport. `harnessLimitations()` derives this list from the table, so the
  documentation of a limitation cannot drift from the limitation.
- A green `convoy doctor` does **not** cover opencode or pi. This is a real
  reduction in what a clean doctor run means, and is reported by name rather than
  inferred.
- pi's `--approve` trusts project-local files; it is **not** a tool-permission
  bypass. A pi agent may still stall on a tool prompt where a claude or codex
  agent under bypass would not.
- Convoy now encodes flag opinions for harnesses it cannot test in CI — the cost
  0005 named. It is bounded to one reviewable table, and the alternative was
  encoding a *wrong* opinion (the claude branch) for them silently.
- `permissionMode` does not reach opencode or pi. Convoy's posture is currently
  the constant `bypassPermissions` for every agent, so nothing is lost today; a
  future per-agent posture must not silently map onto `--auto` / `--approve`.
- Adding the next harness is a data change that fails to typecheck until every
  capability is decided.

## Evidence

- Flag surfaces read from `opencode 1.18.3 --help` and `pi 0.80.10 --help`, not
  from documentation.
- `src/harness.test.ts`. Tests marked `LOCK` pass on main and pin behavior that
  was reported missing but was already present; every other test fails on main.
  The six current defects were each reproduced against a clean `origin/main`
  checkout before being fixed.
