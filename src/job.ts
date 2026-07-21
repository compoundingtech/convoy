// The COMPLETION EVENT — convoy's batch-job "done" signal, and the deterministic done-contract that
// `convoy eval` waits on (option A: explicit, not a quiescence heuristic).
//
// A batch job (an eval run, a one-shot task) has no persistent supervisor watching the bus for "settled";
// nothing today can tell an orchestrator that the work is finished, so a HUMAN has to watch. This module
// closes that gap: the agent (the supervisor, for a team cell) EXPLICITLY signals completion by calling
// `convoy job done`, which writes a small JSON completion event under the network dir; an orchestrator
// (`convoy eval`) polls for it (with a timeout as the safety fallback). Machine-clean, one persona line.
//
// The event lives at `<networkDir>/jobs/<job>.done.json` — machine-local RUN state (alongside pty/ +
// worktrees/, OUTSIDE the smalltalk/ sync boundary), because a completion is a fact about THIS run on THIS
// host, not something to replicate cross-machine. Both writer (`convoy job done`) and reader (`convoy eval`)
// resolve the network dir through convoy's ONE resolver (resolveNetworkRoot), so they agree by construction.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The agent's SELF-REPORTED outcome. NOTE: this is the job's own claim; the eval verdict is decided by
 *  the grader (grade.sh) — an agent can report `ok` and still fail the grade. */
export type JobStatus = "ok" | "fail";

/** A completion event — the batch job's "I'm done" record. */
export interface CompletionEvent {
  /** The job id (a cell = one job for now). Defaults to `DEFAULT_JOB_ID`. */
  job: string;
  /** The agent's self-reported outcome. */
  status: JobStatus;
  /** Optional human note (why ok/fail) — surfaced in the verdict for triage, never parsed. */
  message?: string;
  /** Provenance: the ST_AGENT that signalled (null when unset — e.g. a manual CLI call outside a session). */
  by?: string;
  /** Epoch ms when the event was written. */
  ts: number;
}

/** The default job id when a cell doesn't name one — one cell is one job in Phase 1. */
export const DEFAULT_JOB_ID = "default";

/** Valid job id shape — same charset as an identity (lowercase alnum + `. _ -`, start alnum). Kept
 *  filesystem-safe because it becomes a filename stem. */
export function isValidJobId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(id);
}

/** The jobs dir for a network — `<networkDir>/jobs/` (machine-local run state, not synced). */
export function jobsDir(networkDir: string): string {
  return join(networkDir, "jobs");
}

/** The completion-event file for a job — `<networkDir>/jobs/<job>.done.json`. */
export function completionPath(networkDir: string, job: string = DEFAULT_JOB_ID): string {
  return join(jobsDir(networkDir), `${job}.done.json`);
}

/** Write the completion event ATOMICALLY (temp + rename in the same dir) so a poller never reads a
 *  half-written file. Creates the jobs dir. Returns the path written. */
export function writeCompletion(networkDir: string, ev: CompletionEvent): string {
  const dir = jobsDir(networkDir);
  mkdirSync(dir, { recursive: true });
  const path = completionPath(networkDir, ev.job);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ev, null, 2)}\n`);
  renameSync(tmp, path); // atomic on the same filesystem — the reader sees all-or-nothing
  return path;
}

/** Read + parse the completion event for a job, or null if none exists yet (or it's unreadable/corrupt —
 *  a partial write is transient; the poller just tries again). */
export function readCompletion(networkDir: string, job: string = DEFAULT_JOB_ID): CompletionEvent | null {
  let text: string;
  try {
    text = readFileSync(completionPath(networkDir, job), "utf8");
  } catch {
    return null; // not signalled yet
  }
  try {
    const doc = JSON.parse(text) as Partial<CompletionEvent>;
    if (doc.status !== "ok" && doc.status !== "fail") return null; // malformed — treat as not-yet-done
    return {
      job: typeof doc.job === "string" ? doc.job : job,
      status: doc.status,
      message: typeof doc.message === "string" ? doc.message : undefined,
      by: typeof doc.by === "string" ? doc.by : undefined,
      ts: typeof doc.ts === "number" ? doc.ts : 0,
    };
  } catch {
    return null; // corrupt/partial — poller retries
  }
}

// ---- one-shot "already ran" bookkeeping (a DIFFERENT concern from the completion event) ----
//
// A `strategy="batch"` agent is a ONE-SHOT: it should launch AT MOST ONCE per network. The completion event
// above is the RUN-level success signal an orchestrator waits on (often only the supervisor writes it); it
// is NOT a reliable per-agent "this one finished" marker (a batch worker may just do its task + exit without
// calling `convoy job done`). So `convoy up` records a per-agent RAN marker when it launches a batch agent,
// and reconcile treats a batch agent that has run + is no longer live as terminal — otherwise a persistent
// host relaunches the finished job the moment its exited session is GC'd (the catalog still lists it active).

/** The one-shot ran marker for a batch agent — `<networkDir>/jobs/<identity>.ran`. */
export function ranMarkerPath(networkDir: string, identity: string): string {
  return join(jobsDir(networkDir), `${identity}.ran`);
}

/** Record that `convoy up` has launched this batch agent (idempotent). Creates the jobs dir. */
export function markBatchRan(networkDir: string, identity: string): void {
  mkdirSync(jobsDir(networkDir), { recursive: true });
  writeFileSync(ranMarkerPath(networkDir, identity), `${Date.now()}\n`);
}

/** Has this batch agent already been launched once on this network? */
export function batchHasRun(networkDir: string, identity: string): boolean {
  return existsSync(ranMarkerPath(networkDir, identity));
}

/** Poll for a job's completion event until it appears or `timeoutMs` elapses. Resolves with the event, or
 *  null on timeout (the orchestrator then falls back to running the grader against whatever state exists +
 *  records `via: "timeout"`). `pollMs` is the poll cadence. Cheap: a stat + tiny read per tick. */
export async function waitForCompletion(
  networkDir: string,
  job: string = DEFAULT_JOB_ID,
  opts: { timeoutMs: number; pollMs?: number } = { timeoutMs: 15 * 60_000 },
): Promise<CompletionEvent | null> {
  const pollMs = opts.pollMs ?? 1000;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const ev = readCompletion(networkDir, job);
    if (ev) return ev;
    if (Date.now() >= deadline) return null;
    const remaining = deadline - Date.now();
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, remaining))));
  }
}
