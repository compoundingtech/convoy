#!/usr/bin/env bash
# grade.sh — inspect the post-run state and render a verdict. Print `[PASS]`/`[FAIL]`/`[WARN]` rows, a
# `SCORE:` line, and a `==> <cell>: PASS|FAIL` headline; EXIT 0 iff the cell passed. `convoy eval` treats the
# exit code as authoritative and turns the rows/score/headline into the verdict JSON (for triage/telemetry).
#
#   ./grade.sh <sandbox>
set -uo pipefail
SB="${1:-${EVAL_SANDBOX:-./.sandbox}}"
pass=0; fail=0
ok(){ echo "  [PASS] $1"; pass=$((pass+1)); }
no(){ echo "  [FAIL] $1"; fail=$((fail+1)); }

echo "== task-success: the worker's artifact =="
if [ "$(cat "$SB/LICENSE.txt" 2>/dev/null)" = "MIT" ]; then
  ok "LICENSE.txt is MIT — the one-shot worker did its job"
else
  no "LICENSE.txt is missing or not MIT (worker didn't finish, or wrote the wrong thing)"
fi

echo
echo "SCORE (mechanical): $pass PASS / $fail FAIL / 0 WARN"
[ "$fail" -eq 0 ] && echo "==> example-eval-cell: PASS — work done + verified." \
                  || echo "==> example-eval-cell: FAIL — see the [FAIL] rows."
[ "$fail" -eq 0 ]
