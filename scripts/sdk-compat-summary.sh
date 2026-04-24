#!/usr/bin/env bash
set -euo pipefail

REPORTS=()
OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --report) REPORTS+=("$2"); shift 2 ;;
    --output) OUTPUT="$2";     shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ ${#REPORTS[@]} -eq 0 ]]; then
  echo "Usage: sdk-compat-summary.sh --report <path> [--report <path>...] [--output <file>]" >&2
  exit 1
fi

ARGS=()
for r in "${REPORTS[@]}"; do
  ARGS+=("--report" "$r")
done

if [[ -n "$OUTPUT" ]]; then
  ARGS+=("--output" "$OUTPUT")
fi

exec npx oagen compat-summary "${ARGS[@]}"
