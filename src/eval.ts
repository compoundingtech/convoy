// `convoy eval <cell>` — the THIN ORCHESTRATOR for a batch/eval run. It closes the loop that today needs a
// human watching the bus: launch a cell's agents, WAIT for the deterministic completion event (with a
// timeout fallback), run the cell's grader, and emit a machine VERDICT JSON. This is Phase 1 of convoy eval
// (the BATCH side of convoy): it keeps a cell's existing spin.sh/grade.sh and only replaces the human-watch
// with `convoy job done` (src/job.ts) + this orchestrator.
//
// The cell contract (matches myobie/evals' cells/<name>/{fixture/spin.sh,fixture/grade.sh}):
//   spin.sh  <sandbox>   sets up an ISOLATED convoy network (using $CONVOY_NETWORK), launches the agents,
//                        seeds the kick, and RETURNS (agents run as detached pty daemons). Its job's
//                        supervisor calls `convoy job done --status ok|fail` when the task is verified done.
//   grade.sh <sandbox>   inspects the post-run state and prints `[PASS]`/`[FAIL]`/`[WARN]` rows + a
//                        `SCORE: N PASS / M FAIL / K WARN` line + a `==> <cell>: PASS|FAIL …` headline,
//                        exiting 0 iff the cell passed. (This is exactly the grader shape evals already emits.)
// The orchestrator OWNS the network: it hands the cell $CONVOY_NETWORK (+ ST_ROOT/PTY_ROOT/EVAL_SANDBOX +
// CONVOY_BIN), polls `<net>/jobs/<job>.done.json`, then always tears the net down (`convoy down --force`).

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as tomlParse } from "smol-toml";
import { run } from "./exec.ts";
import { hasFlag, optValue, positionals, resolveNetworkRoot, unknownFlag } from "./commands.ts";
import { flagAllowList } from "./command-table.ts";
import { networkLayout } from "./paths.ts";
import { DEFAULT_JOB_ID, isValidJobId, waitForCompletion, type CompletionEvent, type JobStatus } from "./job.ts";

// ---------- verdict shape ----------

/** The per-job verdict — the completion signal (the job's self-report) + the grader's mechanical result. */
export interface JobVerdict {
  id: string;
  /** The machine verdict for THIS job: pass iff the grader exited 0; error if the grader couldn't run. */
  outcome: "pass" | "fail" | "error";
  completion: {
    /** Did the job explicitly signal done (vs the orchestrator timing out)? */
    signalled: boolean;
    via: "explicit" | "timeout";
    /** The agent's SELF-reported status (`ok`/`fail`) — advisory; the grader is authoritative. Null on timeout. */
    status: JobStatus | null;
    by: string | null;
    message: string | null;
    waitedMs: number;
  };
  grade: GradeResult | null;
}

/** The parsed result of a grade.sh run — counts + rows + headline + exit code. */
export interface GradeResult {
  ran: boolean;
  exitCode: number | null;
  pass: number;
  fail: number;
  warn: number;
  headline: string | null;
  score: string | null;
  rows: { level: "PASS" | "FAIL" | "WARN"; text: string }[];
}

/** The overall eval verdict — the machine-readable output of `convoy eval`. */
export interface EvalVerdict {
  schema: "convoy.eval.verdict/v1";
  cell: string;
  cellDir: string;
  network: string;
  sandbox: string;
  /** The OVERALL outcome: error if any job errored (or spin failed), else fail if any job failed, else pass. */
  outcome: "pass" | "fail" | "error";
  jobs: JobVerdict[];
  spin: { ran: boolean; exitCode: number };
  axes?: string[];
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  convoyVersion: string;
  /** Present only when outcome=error: what went wrong before/instead of a clean grade. */
  error?: string;
}

// ---------- pure helpers (unit-tested) ----------

/** Parse grade.sh output into a structured result. Recognizes `[PASS]`/`[FAIL]`/`[WARN]` rows (leading
 *  whitespace allowed), the `SCORE …: …` line, and the `==> …` headline — the shape evals' graders print.
 *  Pure: the exit code is authoritative for pass/fail; the counts are for triage/telemetry. */
export function parseGradeOutput(text: string, exitCode: number | null): GradeResult {
  const rows: { level: "PASS" | "FAIL" | "WARN"; text: string }[] = [];
  let headline: string | null = null;
  let score: string | null = null;
  for (const line of text.split("\n")) {
    const row = /^\s*\[(PASS|FAIL|WARN)\]\s*(.*)$/.exec(line);
    if (row) {
      rows.push({ level: row[1] as "PASS" | "FAIL" | "WARN", text: (row[2] ?? "").trim() });
      continue;
    }
    const sc = /^\s*SCORE\b[^:]*:\s*(.+)$/.exec(line);
    if (sc) score = (sc[1] ?? "").trim();
    const hd = /^\s*==>\s*(.+)$/.exec(line);
    if (hd) headline = (hd[1] ?? "").trim();
  }
  return {
    ran: true,
    exitCode,
    pass: rows.filter((r) => r.level === "PASS").length,
    fail: rows.filter((r) => r.level === "FAIL").length,
    warn: rows.filter((r) => r.level === "WARN").length,
    headline,
    score,
    rows,
  };
}

/** The overall outcome across jobs: error > fail > pass (worst wins). Empty → error (nothing graded). */
export function overallOutcome(jobs: JobVerdict[]): "pass" | "fail" | "error" {
  if (jobs.length === 0) return "error";
  if (jobs.some((j) => j.outcome === "error")) return "error";
  if (jobs.some((j) => j.outcome === "fail")) return "fail";
  return "pass";
}

/** The machine verdict for one graded job: the grader's exit code is authoritative (pass iff 0). A grader
 *  that never ran (missing/crashed before producing a result) is an error, not a fail. */
export function jobOutcomeFromGrade(grade: GradeResult | null): "pass" | "fail" | "error" {
  if (!grade || !grade.ran || grade.exitCode === null) return "error";
  return grade.exitCode === 0 ? "pass" : "fail";
}

/** First existing of `<cellDir>/fixture/<name>` then `<cellDir>/<name>` (evals put scripts under fixture/). */
export function locateCellScript(cellDir: string, name: string): string | null {
  for (const p of [join(cellDir, "fixture", name), join(cellDir, name)]) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Read `axes` from a cell's task.toml (best-effort, forward-compat) — never throws. */
function readCellAxes(cellDir: string): string[] | undefined {
  const p = join(cellDir, "task.toml");
  try {
    const doc = tomlParse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const axes = doc["axes"];
    if (Array.isArray(axes) && axes.every((a) => typeof a === "string")) return axes as string[];
  } catch {
    // no task.toml / unparseable / no axes — omit
  }
  return undefined;
}

/** convoy's reported version — package.json semver + best-effort git short-sha (matches cli.ts formatting). */
async function convoyVersion(repoRoot: string): Promise<string> {
  let semver = "0.0.0";
  try {
    semver = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version as string | undefined) ?? semver;
  } catch {
    // keep the fallback
  }
  try {
    const r = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot });
    if (r.ok && r.stdout.trim()) return `${semver}+${r.stdout.trim()}`;
  } catch {
    // not a git checkout — omit the sha
  }
  return semver;
}

// ---------- the orchestrator ----------

const HELP = `convoy eval <cell> — run a batch/eval cell end-to-end and emit a machine verdict.

  <cell>                 path to a cell dir (expects fixture/spin.sh + fixture/grade.sh, or spin.sh/grade.sh)
  --sandbox <dir>        scratch dir for the run (default: a fresh isolated dir under convoy's home)
  --network <net>        isolated network dir to use (default: <sandbox>/net)
  --job <id>             the completion-event job id to wait on (default: "${DEFAULT_JOB_ID}")
  --timeout <ms>         how long to wait for the completion event before falling back to grade (default: 900000)
  --poll <ms>            completion-event poll cadence (default: 1000)
  --keep                 don't tear the network down / delete the sandbox (inspect the run)
  --json                 print ONLY the verdict JSON (for scripts); default prints a human summary
  --network resolves via convoy's usual rules; the cell gets $CONVOY_NETWORK/$ST_ROOT/$PTY_ROOT/$EVAL_SANDBOX/$CONVOY_BIN.
rc: 0 = pass · 1 = fail · 2 = error (bad usage / spin failed / grader couldn't run).`;

export async function cmdEval(args: string[]): Promise<number> {
  if (hasFlag(args, "--help", "-h")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const bad = unknownFlag(args, ...flagAllowList("eval"));
  if (bad) {
    process.stderr.write(`convoy: unrecognized flag "${bad}" for \`convoy eval\`. See \`convoy eval --help\`.\n`);
    return 2;
  }
  const cellArg = positionals(args)[0];
  if (!cellArg) {
    process.stderr.write("convoy: missing cell. Usage: convoy eval <cell-dir> [--sandbox <dir>] [--timeout <ms>]\n");
    return 2;
  }
  const cellDir = resolve(cellArg);
  if (!existsSync(cellDir)) {
    process.stderr.write(`convoy: cell not found: ${cellDir}\n`);
    return 2;
  }
  const cell = cellDir.replace(/\/+$/, "").split("/").pop() || cellArg;
  const spin = locateCellScript(cellDir, "spin.sh");
  const grade = locateCellScript(cellDir, "grade.sh");
  if (!spin) {
    process.stderr.write(`convoy: no spin.sh in ${cellDir} (looked in fixture/ and the cell root)\n`);
    return 2;
  }
  if (!grade) {
    process.stderr.write(`convoy: no grade.sh in ${cellDir} — a cell needs a grader to produce a verdict\n`);
    return 2;
  }

  const job = optValue(args, "--job") ?? DEFAULT_JOB_ID;
  if (!isValidJobId(job)) {
    process.stderr.write(`convoy: invalid --job "${job}"\n`);
    return 2;
  }
  const timeoutMs = Number(optValue(args, "--timeout") ?? 15 * 60_000);
  const pollArg = Number(optValue(args, "--poll") ?? 1000);
  const pollMs = Number.isFinite(pollArg) && pollArg > 0 ? pollArg : 1000; // a non-finite --poll would busy-loop
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write("convoy: --timeout must be a positive number of ms\n");
    return 2;
  }
  const keep = hasFlag(args, "--keep");
  const asJson = hasFlag(args, "--json");

  // Sandbox: an explicit --sandbox, else a fresh isolated dir under convoy's home. We only auto-delete the
  // dir on teardown when WE created the default one (never rm a user-provided --sandbox).
  const sandboxArg = optValue(args, "--sandbox");
  const networkArg = optValue(args, "--network");
  const runid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
  const sandboxIsOurs = !sandboxArg;
  const sandbox = sandboxArg ? resolve(sandboxArg) : join(process.env["XDG_STATE_HOME"] ?? join(process.env["HOME"] ?? "", ".local", "state"), "convoy", "eval", `${cell}-${runid}`);
  // Network: an explicit --network, else <sandbox>/net. resolveNetworkRoot lets --network be a name or path.
  // A user-provided --network is NOT ours to destroy: teardown only `convoy down`s a net the orchestrator
  // created (else `convoy eval <cell> --network default` would nuke the operator's live network at the end).
  const network = networkArg ? resolveNetworkRoot(networkArg) : join(sandbox, "net");
  const networkIsOurs = !networkArg;
  // The unix socket the pty daemon binds is <net>/… — guard the length like evals' stev_convoy_init does,
  // so a too-deep sandbox fails LOUD with guidance instead of an opaque socket-bind error mid-run.
  if (network.length > 70) {
    process.stderr.write(`convoy: network path too long for the pty socket limit (${network.length} > 70): ${network}\n  pass a shorter --sandbox (or --network).\n`);
    return 2;
  }

  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url))); // src/eval.ts → src → repo root
  const convoyBin = join(repoRoot, "bin", "convoy"); // executable via its shebang — cells call `$CONVOY_BIN job done`
  const layout = networkLayout(network);
  mkdirSync(sandbox, { recursive: true });

  // The env every cell script inherits — an ISOLATED network + a reliable convoy binary. PATH is enriched by
  // childEnv() (so a bare `convoy`/`st`/`pty` resolves too); we set CONVOY_BIN as the belt-and-suspenders abs path.
  const cellEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CONVOY_NETWORK: network,
    ST_ROOT: layout.stRoot,
    PTY_ROOT: layout.ptyRoot,
    EVAL_SANDBOX: sandbox,
    CONVOY_BIN: convoyBin,
    CONVOY_EVAL_JOB: job,
  };

  const startedAt = new Date();
  const started = startedAt.getTime();
  const version = await convoyVersion(repoRoot);
  const axes = readCellAxes(cellDir);
  const log = (s: string): void => { if (!asJson) process.stderr.write(`${s}\n`); };

  const finish = async (v: Omit<EvalVerdict, "durationMs" | "finishedAt">): Promise<number> => {
    if (keep) {
      log(`• --keep: left network ${network} + sandbox ${sandbox} up for inspection (tear down: convoy down ${network} --force)`);
    } else {
      if (networkIsOurs) {
        // Tear down the net WE created (the ONLY path that kills the sessions), then drop our scratch dir.
        const r = await run(convoyBin, ["down", network, "--force"], { env: cellEnv });
        if (!r.ok) log(`• convoy down ${network} exited ${r.status} (already down?)`);
      } else {
        log(`• left your --network ${network} up (not ours to tear down) — stop it with: convoy down ${network} --force`);
      }
      if (sandboxIsOurs) { try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
    const finishedAt = new Date();
    const verdict: EvalVerdict = { ...v, durationMs: finishedAt.getTime() - started, finishedAt: finishedAt.toISOString() };
    if (asJson) process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    else printSummary(verdict);
    return verdict.outcome === "pass" ? 0 : verdict.outcome === "fail" ? 1 : 2;
  };

  const base = {
    schema: "convoy.eval.verdict/v1" as const,
    cell, cellDir, network, sandbox,
    startedAt: startedAt.toISOString(),
    convoyVersion: version,
    ...(axes ? { axes } : {}),
  };

  // 1) SPIN — set up the isolated net, launch the agents, seed the kick.
  log(`== convoy eval ${cell} ==`);
  log(`   spin:    ${spin}`);
  log(`   network: ${network}`);
  log(`   sandbox: ${sandbox}`);
  log(`-- 1/3 spin.sh --`);
  const spinRes = await run("bash", [spin, sandbox], { env: cellEnv });
  if (!asJson && spinRes.stdout.trim()) process.stderr.write(`${spinRes.stdout.trimEnd()}\n`);
  if (!spinRes.ok) {
    process.stderr.write(`${spinRes.stderr.trimEnd()}\n`);
    return finish({ ...base, outcome: "error", jobs: [], spin: { ran: true, exitCode: spinRes.status }, error: `spin.sh exited ${spinRes.status}` });
  }

  // 2) WAIT — for the deterministic completion event, timeout as the safety fallback.
  log(`-- 2/3 waiting for completion event (job "${job}", timeout ${timeoutMs}ms) --`);
  const waitStart = Date.now();
  const ev: CompletionEvent | null = await waitForCompletion(network, job, { timeoutMs, pollMs });
  const waitedMs = Date.now() - waitStart;
  if (ev) log(`   ✓ job "${job}" signalled done: status=${ev.status}${ev.by ? ` by ${ev.by}` : ""} (after ${waitedMs}ms)`);
  else log(`   ⚠ no completion event after ${waitedMs}ms — grading against current state (via=timeout)`);

  // 3) GRADE — run the cell's grader; its exit code is the authoritative pass/fail.
  log(`-- 3/3 grade.sh --`);
  const gradeRes = await run("bash", [grade, sandbox], { env: cellEnv });
  if (!asJson) process.stderr.write(`${(gradeRes.stdout || gradeRes.stderr).trimEnd()}\n`);
  const grade0 = parseGradeOutput(`${gradeRes.stdout}\n${gradeRes.stderr}`, gradeRes.status);

  const jobVerdict: JobVerdict = {
    id: job,
    outcome: jobOutcomeFromGrade(grade0),
    completion: {
      signalled: ev !== null,
      via: ev ? "explicit" : "timeout",
      status: ev?.status ?? null,
      by: ev?.by ?? null,
      message: ev?.message ?? null,
      waitedMs,
    },
    grade: grade0,
  };
  return finish({ ...base, outcome: overallOutcome([jobVerdict]), jobs: [jobVerdict], spin: { ran: true, exitCode: spinRes.status } });
}

/** Human-readable summary (stderr-safe: printed to stdout only in the non-JSON path). */
function printSummary(v: EvalVerdict): void {
  const glyph = v.outcome === "pass" ? "✓" : v.outcome === "fail" ? "✗" : "‼";
  const lines: string[] = [];
  lines.push("");
  lines.push(`${glyph} convoy eval ${v.cell}: ${v.outcome.toUpperCase()}  (${(v.durationMs / 1000).toFixed(1)}s)`);
  for (const j of v.jobs) {
    const c = j.completion;
    lines.push(`  job ${j.id}: ${j.outcome.toUpperCase()} — done-signal ${c.signalled ? `explicit (status=${c.status}${c.by ? `, by ${c.by}` : ""})` : `MISSING (timeout after ${c.waitedMs}ms)`}`);
    if (j.grade) lines.push(`    grade: exit ${j.grade.exitCode} · ${j.grade.pass} PASS / ${j.grade.fail} FAIL / ${j.grade.warn} WARN${j.grade.headline ? ` · ${j.grade.headline}` : ""}`);
  }
  if (v.error) lines.push(`  error: ${v.error}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}
