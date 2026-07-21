#!/usr/bin/env bash
# spin.sh — set up the run + launch the work, then RETURN (the work runs on after us). For this reference
# cell the "agent" is a trivial background job (no LLM/pty), so the cell is deterministic + always runnable;
# a real team cell would instead `convoy init` + `convoy add` + `convoy up --once "$CONVOY_NETWORK"` to launch
# actual agents and seed a kick (see README.md). Either way the contract is the same: when the work is
# verified complete, something calls `convoy job done` — the completion event `convoy eval` waits on.
#
#   ./spin.sh <sandbox>
# The orchestrator provides: $CONVOY_NETWORK (isolated net), $ST_ROOT, $EVAL_SANDBOX, $CONVOY_BIN.
set -euo pipefail
SB="${1:-${EVAL_SANDBOX:-./.sandbox}}"
CONVOY="${CONVOY_BIN:-convoy}"
mkdir -p "$SB"

echo "== spin: launching the one-shot worker (network ${CONVOY_NETWORK:-<ambient>}) =="

# The unit of work + the done-signal, backgrounded so spin.sh returns immediately (agents run async). Its
# stdio MUST go to a file, not spin.sh's pipe — otherwise the orchestrator's capture of spin.sh won't close
# until the worker also exits. `disown` detaches it from this shell.
(
  sleep 1                                   # stand in for "the agent does real work"
  echo "MIT" > "$SB/LICENSE.txt"            # the artifact the grader checks
  "$CONVOY" job done --status ok --message "worker set LICENSE to MIT"
) >"$SB/worker.log" 2>&1 &
disown || true

echo "== spun: worker running; it will 'convoy job done' when finished. Grader will verify $SB/LICENSE.txt. =="
