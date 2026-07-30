#!/usr/bin/env bash
# The Automation Hub module and the userscript are the SAME file. Two hand-maintained
# copies is why the hub sat on v2.4 for months after the userscript reached v3.x.
# This copies the source into the extension; `--check` fails if they have drifted.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/reddit-auto-hide.user.js"
DEST="${CHROME_AUTOMATION_DIR:-$HOME/repos/chrome-automation}/modules/reddit-auto-hide.js"

if [ ! -f "$SRC" ]; then echo "missing source: $SRC" >&2; exit 1; fi
if [ ! -d "$(dirname "$DEST")" ]; then echo "missing extension modules dir: $(dirname "$DEST")" >&2; exit 1; fi

if [ "${1:-}" = "--check" ]; then
  if cmp -s "$SRC" "$DEST"; then
    echo "in sync: $(grep -m1 '@version' "$SRC" | tr -s ' ')"
  else
    echo "DRIFT: $DEST differs from $SRC" >&2
    diff <(head -40 "$SRC") <(head -40 "$DEST") | head -20 >&2 || true
    exit 1
  fi
else
  cp "$SRC" "$DEST"
  echo "copied -> $DEST ($(grep -m1 '@version' "$SRC" | tr -s ' '))"
fi
