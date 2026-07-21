// Auth-readiness preflight: verify the active harness(es) can ACTUALLY authenticate — not merely that a
// credential file exists. This closes the machine-wide-signout failure mode: a signed-out (or server-side
// revoked) harness is otherwise invisible until its next real spawn fails with "Not logged in". A file/keychain
// check is INSUFFICIENT here — in the signout incident the credential was present on disk but the token was
// REVOKED, so `claude auth status` / `codex login status` (both fast but LOCAL — they decode the cached cred,
// they don't call the server) report logged-in while calls actually 401. So the probe makes a real minimal call
// (a tiny `claude -p` / `codex exec`, a few seconds) that either succeeds or returns the not-signed-in signal.

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../exec.ts";

// The canonical Harness — see the note in checkup.ts. A local copy here meant a widened union produced
// no auth probe and no warning for the new member.
export type { Harness } from "../harness.ts";
import { HARNESSES, harnessDescriptor, type Harness } from "../harness.ts";

/** Normalized outcome of one harness's auth probe.
 *  - `live`         — a real call SUCCEEDED (auth verified end-to-end).
 *  - `signed-out`   — the call returned a clear not-signed-in / 401 / expired signal.
 *  - `unavailable`  — the harness binary isn't installed (capability-detected → skipped, not a failure).
 *  - `inconclusive` — the call errored in a way we can't attribute to auth (network / timeout). */
export type AuthSignal = "live" | "signed-out" | "unavailable" | "inconclusive";

export interface AuthOutcome {
  harness: Harness;
  /** true = live, false = signed-out/inconclusive (a preflight failure), null = not installed (skipped). */
  ok: boolean | null;
  detail: string;
  fix?: string;
}

// Partial by TYPE, because it is partial in FACT: only harnesses declaring `supportsAuth` have a probe,
// a display name, and a relogin hint. A total Record would have to invent entries for harnesses convoy
// cannot probe, and the invented value is what would then be reported to an operator as truth.
const HARNESS_NAME: Partial<Record<Harness, string>> = { claude: "Claude", codex: "Codex" };
const RELOGIN: Partial<Record<Harness, string>> = { claude: "run `claude` then `/login`", codex: "run `codex login`" };
/** Display name for a harness, falling back to its own id (never a wrong harness's name). */
function harnessName(h: Harness): string {
  return HARNESS_NAME[h] ?? h;
}

/** PURE classifier: map a probe signal to a preflight outcome. This is the unit-tested core — it needs no real
 *  auth, so a test can inject any signal and assert the outcome (live → pass, signed-out → fail + actionable).
 *  `required` = does THIS setup actually use the harness (the network's harnesses, or claude when fresh)? A
 *  readiness check must not FALSE-FAIL: an INSTALLED-but-unused harness that's signed-out is a WARN (ok:null),
 *  not a hard failure — so a claude-only setup that merely has codex installed still passes --quick green. */
export function classifyAuthSignal(harness: Harness, signal: AuthSignal, required = true): AuthOutcome {
  const name = HARNESS_NAME[harness];
  switch (signal) {
    case "live":
      return { harness, ok: true, detail: `${name} is signed in — verified with a live probe (not just a cred on disk)` };
    case "signed-out":
      if (!required) {
        return { harness, ok: null, detail: `${name} is installed but not signed in — not used by this setup, so it's fine; ${RELOGIN[harness]} if you plan to run ${name} agents` };
      }
      return {
        harness,
        ok: false,
        detail: `${name} is NOT signed in — a credential may be present on disk but the session is expired or was revoked, so real calls will fail`,
        fix: `${RELOGIN[harness]}, then re-run \`convoy doctor --quick\``,
      };
    case "unavailable":
      return { harness, ok: null, detail: `${name} not installed — skipped (capability-detected)` };
    case "inconclusive":
      if (!required) {
        return { harness, ok: null, detail: `${name} is installed but its auth couldn't be verified (probe errored) — not used by this setup, so it's not blocking` };
      }
      return {
        harness,
        ok: false,
        detail: `could not verify ${name} auth — the probe errored (network / timeout?), so readiness is unconfirmed`,
        fix: `ensure you're online and signed in (${RELOGIN[harness]}), then re-run \`convoy doctor --quick\``,
      };
  }
}

/** CLEAR not-signed-in signals only — deliberately TIGHT. This regex is the sole thing that maps a probe to
 *  `signed-out`, so it must match ONLY unambiguous auth failures (Nathan's bar: the doctor must not say untrue
 *  things). The old pattern matched loose words — `api key`, `credential`, `please run`, even `logged in` /
 *  `authenticat` (which appear in SUCCESS and non-auth output) — so a SIGNED-IN user whose probe failed for a
 *  non-auth reason (a sandbox restriction, a wrong claude path, partial timeout output) was mislabeled
 *  "signed-out". Anything not matched here is NOT called signed-out: it falls through to `live` (rc 0) or
 *  `inconclusive` (couldn't verify). Each alternative is a phrase a harness emits ONLY when auth genuinely fails:
 *    • "Not logged in" / "not signed in"        (claude -p prints this yet EXITS 0 — why we classify on output)
 *    • "Please run /login" / "…`codex login`"   (the re-login prompt; requires the word "login" nearby)
 *    • "Invalid API key" · 401 · Unauthorized · authentication_error
 *    • an EXPIRED token / credential / session. */
const AUTH_FAIL = new RegExp(
  [
    "\\bnot (?:logged|signed)[ -]?in\\b",
    "please run\\b[^\\n]{0,40}\\blogin\\b",
    "\\binvalid api key\\b",
    "\\b401\\b",
    "\\bunauthorized\\b",
    "\\b(?:oauth |access |api |auth )?token (?:has )?expired\\b",
    "\\b(?:credential|credentials|session|login) (?:has |have )?expired\\b",
    "\\bauthentication[_ ]error\\b",
  ].join("|"),
  "i",
);

export interface ProbeExec { code: number | null; stdout: string; stderr: string; timedOut: boolean; }

/** PURE: classify a raw probe result into an AuthSignal. Unit-tested so the false-negative fix is provable
 *  without real auth. ORDER is load-bearing:
 *    1. a TIMEOUT is never an auth verdict → `inconclusive` (couldn't verify), FIRST — a hung network call
 *       must never be read as "signed out";
 *    2. only then, a CLEAR signed-out signal in the output → `signed-out` (checked before the rc-0 case because
 *       `claude -p` prints "Not logged in" yet EXITS 0 — an rc check alone would false-PASS a signed-out claude);
 *    3. rc 0 with no auth-failure signal → `live` (the call really went through);
 *    4. any other error (rc≠0, no auth signal — a sandbox block, a bad path, a crash) → `inconclusive`, NOT
 *       `signed-out`: we could not verify, and saying "not signed in" about a signed-in user is the bug we fix. */
export function classifyProbe(res: ProbeExec): AuthSignal {
  if (res.timedOut) return "inconclusive";
  if (AUTH_FAIL.test(`${res.stdout}\n${res.stderr}`)) return "signed-out";
  if (res.code === 0) return "live";
  return "inconclusive";
}

/** Run a real minimal call for a harness in a throwaway cwd (so no CLAUDE.md / project hooks / MCP load), close
 *  stdin (so `-p`/`exec` don't wait on piped input), and normalize to an AuthSignal. NOT unit-tested — it needs
 *  real auth; `classifyAuthSignal` is the tested part and this is injected in tests. */
export async function probeHarness(harness: Harness): Promise<AuthSignal> {
  const dir = mkdtempSync(join(tmpdir(), "cvd-auth-"));
  try {
    const spec: Partial<Record<Harness, string[]>> = {
      claude: ["-p", "Reply with exactly: ok", "--model", "claude-haiku-4-5-20251001", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
      codex: ["exec", "--skip-git-repo-check", "Reply with exactly: ok"],
    };
    const argv = spec[harness];
    // A harness with no probe argv declares `supportsAuth: false`, so authReadiness never reaches here for
    // one. Guarding anyway: an unprobeable harness must read as "unknown", never as another harness's result.
    if (!argv) return "inconclusive";
    const res = await execProbe(harness, argv, dir);
    return classifyProbe(res); // pure + unit-tested; timeout → inconclusive, only a clear signal → signed-out
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function execProbe(cmd: string, args: string[], cwd: string): Promise<ProbeExec> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, env: childEnv({ ...process.env }), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { killed?: boolean; signal?: string; code?: unknown }) | null;
      const timedOut = e?.killed === true && e.signal === "SIGTERM";
      const code = e && typeof e.code === "number" ? e.code : e ? 1 : 0;
      resolve({ code: timedOut ? null : code, stdout: stdout ?? "", stderr: stderr ?? "", timedOut });
    });
    child.stdin?.end(); // don't block on stdin
  });
}

/** Injectable for tests: given a present harness, return its probe signal. */
export type Prober = (harness: Harness) => Promise<AuthSignal>;
/** Injectable for tests: is this harness's binary on PATH? */
export type Detector = (harness: Harness) => Promise<boolean>;

function onPath(harness: Harness): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/env", ["sh", "-c", `command -v ${harness}`], (err, stdout) => resolve(!err && Boolean(stdout.trim())));
  });
}

/** Capability-detect the installed harnesses and probe each — IN PARALLEL so total latency is the slowest single
 *  probe, not the sum. A harness that isn't installed is skipped (ok:null), never a failure. Returns one outcome
 *  per harness (installed or not). Both `prober` + `detector` are injectable for tests. */
export async function authReadiness(
  prober: Prober = probeHarness,
  detector: Detector = onPath,
  isRequired: (h: Harness) => boolean = () => true,
): Promise<AuthOutcome[]> {
  // Derived from the harness table: probe only harnesses that declare an auth probe. A harness without
  // one is absent from this list rather than reported as healthy on another harness's probe.
  const harnesses: Harness[] = HARNESSES.filter((h) => harnessDescriptor(h).supportsAuth);
  return Promise.all(
    harnesses.map(async (h) =>
      (await detector(h)) ? classifyAuthSignal(h, await prober(h), isRequired(h)) : classifyAuthSignal(h, "unavailable", isRequired(h)),
    ),
  );
}
