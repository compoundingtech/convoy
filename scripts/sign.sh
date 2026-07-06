#!/usr/bin/env bash
# Re-sign (and optionally notarize + staple) a built Convoy.app with a Developer ID identity.
#
# convoy ships ad-hoc signed. This is the handoff for producing a distributable, notarized build:
# the repo never holds a signing identity or credentials — you provide them here.
#
# Usage:
#   scripts/sign.sh "Developer ID Application: Your Name (TEAMID)"
#   scripts/sign.sh "Developer ID Application: Your Name (TEAMID)" --notarize <notarytool-profile>
#
# Prereqs for --notarize: a stored notarytool profile, created once with
#   xcrun notarytool store-credentials <profile> --apple-id <id> --team-id <team> --password <app-pw>
set -euo pipefail

cd "$(dirname "$0")/.."
APP="${CONVOY_APP:-.build/bundler/Convoy.app}"
IDENTITY="${1:-}"

if [ -z "$IDENTITY" ]; then
  echo "usage: scripts/sign.sh \"Developer ID Application: Your Name (TEAMID)\" [--notarize <profile>]" >&2
  exit 2
fi
[ -d "$APP" ] || { echo "error: $APP not found — run scripts/bundle.sh first" >&2; exit 1; }

echo "==> re-signing $APP with Developer ID (hardened runtime)"
codesign --force --deep --options runtime --timestamp \
  --sign "$IDENTITY" \
  "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

if [ "${2:-}" = "--notarize" ]; then
  PROFILE="${3:?--notarize requires a notarytool keychain profile name}"
  ZIP="$(mktemp -d)/Convoy.app.zip"
  echo "==> zipping for notarization"
  ditto -c -k --keepParent "$APP" "$ZIP"
  echo "==> submitting to notarytool (profile: $PROFILE) — waits for the verdict"
  xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait
  echo "==> stapling the ticket"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  echo "✓ signed + notarized + stapled: $APP"
  echo "  Re-zip with the CLI and cut a release; the cask's quarantine workaround can then be dropped."
else
  echo "✓ signed with Developer ID: $APP"
  echo "  Add --notarize <profile> to notarize + staple for friction-free download."
fi
