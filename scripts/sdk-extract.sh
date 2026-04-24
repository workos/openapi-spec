#!/usr/bin/env bash
set -euo pipefail

LANG=""
OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang)   LANG="$2";   shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$LANG" ]]; then
  echo "Usage: sdk-extract.sh --lang <language> [--output <path>]" >&2
  exit 1
fi

if [[ -z "$OUTPUT" ]]; then
  OUTPUT=".oagen/${LANG}/sdk-surface.json"
fi

exec npx oagen extract --lang "$LANG" --output "$OUTPUT"
