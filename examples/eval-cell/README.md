# Example eval cell — the `convoy eval` contract

`convoy eval` runs a **batch cell** end-to-end and emits a machine verdict:

```
spin.sh  →  (agents work)  →  convoy job done  →  grade.sh  →  verdict JSON
```

Run this reference cell (deterministic, no LLM):

```sh
convoy eval examples/eval-cell            # human summary + rc (0 pass / 1 fail / 2 error)
convoy eval examples/eval-cell --json     # the machine verdict JSON on stdout
```

## The contract

A cell is a directory with `fixture/spin.sh` + `fixture/grade.sh` (they may also sit at the cell root). The
orchestrator owns an **isolated network** and hands both scripts the same environment:

| provided                | what it is                                                        |
| ----------------------- | ----------------------------------------------------------------- |
| `$1` / `$EVAL_SANDBOX`  | a scratch dir for this run's artifacts                            |
| `$CONVOY_NETWORK`       | the isolated convoy network dir — use it for `convoy add/up/down` |
| `$ST_ROOT`              | the bus root (`<net>/smalltalk`) — agent inboxes live here        |
| `$PTY_ROOT`             | the pty runtime root (`<net>/pty`)                                |
| `$CONVOY_BIN`           | an absolute path to the convoy CLI                                |

- **`spin.sh <sandbox>`** sets up the run, launches the work, and **returns** (agents run async — background
  anything long-lived, and send its stdio to a file so it doesn't hold the orchestrator's pipe open).
- **The done-signal.** When the task is *verified complete*, something calls **`convoy job done --status ok`**
  (or `--status fail`). That writes `<net>/jobs/<job>.done.json`, which the orchestrator is polling. This is
  the deterministic replacement for a human watching the bus for "settled." A `--timeout` fallback still
  grades whatever state exists if the signal never comes (recorded as `via: "timeout"` in the verdict).
- **`grade.sh <sandbox>`** inspects the result and prints `[PASS]`/`[FAIL]`/`[WARN]` rows, a `SCORE:` line,
  and a `==> <cell>: PASS|FAIL` headline, **exiting 0 iff the cell passed**. The exit code is authoritative;
  the rows/score/headline become verdict telemetry. (An agent can self-report `ok` and still fail the grade.)

## Mapping a REAL team cell onto this

This example fakes the "agent" with a background shell so it always runs. A real team cell (e.g. a supervisor
relaying a task to a worker) keeps the exact same contract — only `spin.sh` grows up:

```sh
# in spin.sh, using the orchestrator's $CONVOY_NETWORK:
"$CONVOY_BIN" init   "$CONVOY_NETWORK"
"$CONVOY_BIN" add supervisor --identity sup    --network "$CONVOY_NETWORK" --persona sup.md    --strategy batch
"$CONVOY_BIN" add worker     --identity worker --network "$CONVOY_NETWORK" --persona worker.md --strategy batch
"$CONVOY_BIN" up --once "$CONVOY_NETWORK"        # DECLARE → launch this host's agents (reconcile-and-exit)
# …seed the kick into the supervisor's inbox under $ST_ROOT…
```

The supervisor's persona gets **one line**: *"when the whole task is verified complete, run
`convoy job done --status ok` (or `--status fail` if it could not be completed)."* `grade.sh` is your existing
grader, unchanged. `--strategy batch` marks each agent a **one-shot job** — non-permanent and never
respawned once it has run (so a persistent `convoy up` won't resurrect a finished job).

## The verdict JSON (`--json`)

```jsonc
{
  "schema": "convoy.eval.verdict/v1",
  "cell": "example-eval-cell",
  "outcome": "pass",                 // overall: pass | fail | error (error > fail > pass)
  "jobs": [{
    "id": "default",
    "outcome": "pass",
    "completion": { "signalled": true, "via": "explicit", "status": "ok", "by": "…", "message": "…", "waitedMs": 1041 },
    "grade": { "ran": true, "exitCode": 0, "pass": 1, "fail": 0, "warn": 0, "headline": "…", "score": "1 PASS / 0 FAIL / 0 WARN", "rows": [ … ] }
  }],
  "spin": { "ran": true, "exitCode": 0 },
  "durationMs": 1180, "startedAt": "…", "finishedAt": "…", "convoyVersion": "…"
}
```
