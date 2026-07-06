#!/usr/bin/env bash
# TCC de-risk probe — answers the scope-decider for app-hosting (IDEA.md Part 4):
# do TCC grants (Full Disk Access / Calendar) survive when the pty-daemon re-parents to launchd?
#
# pty-claude confirmed `pty run -d` re-parents the daemon to launchd (PID 1). The open question is
# whether the daemon (and its agents) keep the *responsible-process* TCC grants of the app/terminal
# that launched them, after that launcher exits. This needs a TCC-GRANTED launcher, so it can't be
# run headlessly — a human grants the app in System Settings, then runs this.
#
# TWO WAYS TO RUN IT:
#
# A) Fast (~5 min), no bundle — from a Terminal.app that HAS Full Disk Access + Calendar:
#    1. System Settings → Privacy & Security → grant Terminal.app Full Disk Access AND Calendars.
#    2. In a Terminal tab, run:  scripts/tcc-probe.sh start
#    3. CLOSE that Terminal tab (or quit Terminal) so the launcher dies and the daemon re-parents.
#    4. From any shell:  scripts/tcc-probe.sh check
#       exit 0 in the log  → grants INHERITED → ship app-hosting.
#       exit non-zero      → grants LOST      → app-hosting is day-2 (dashboard + keep-awake only).
#
# B) Harder signal — grant Convoy.app itself (it carries the TCC usage keys) and have it spawn the
#    probe. Use this if (A) is ambiguous.

set -uo pipefail
PROBE_LOG="/tmp/convoy-tcc-probe.log"
CAL_DIR="$HOME/Library/Calendars"   # Calendar-protected path; ls fails (non-zero) if TCC-denied

case "${1:-}" in
  start)
    : > "$PROBE_LOG"
    echo "starting detached probe (writes exit codes to $PROBE_LOG every 2s)"
    echo "now CLOSE this terminal/app so the daemon re-parents to launchd, then run: $0 check"
    pty run -d --name convoy-tcc-probe -- \
      /bin/sh -c "while :; do ls \"$CAL_DIR\" >/dev/null 2>&1; echo \$? >> \"$PROBE_LOG\"; sleep 2; done"
    ;;
  check)
    if [ ! -s "$PROBE_LOG" ]; then echo "no probe data yet at $PROBE_LOG — did you run '$0 start'?"; exit 2; fi
    echo "last 5 exit codes (0 = Calendar access OK, non-zero = TCC denied):"
    tail -5 "$PROBE_LOG"
    if tail -1 "$PROBE_LOG" | grep -qx 0; then
      echo "→ GRANTS INHERITED across re-parent. App-hosting is viable — ship it."
    else
      echo "→ GRANTS LOST after re-parent. App-hosting → day-2 (needs a native shim that calls"
      echo "  responsibility_spawnattrs_setdisclaim(false), or a supervisor holding the TCC anchor)."
    fi
    ;;
  stop)
    pty kill convoy-tcc-probe 2>/dev/null || true
    echo "probe stopped."
    ;;
  *)
    echo "usage: $0 {start|check|stop}  — see the header of this script for the full procedure" >&2
    exit 2
    ;;
esac
