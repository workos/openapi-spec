#!/usr/bin/env bash
set -euo pipefail

SPEC="spec/open-api-spec.yaml"
LANG=""
SDK_ROOT=""
OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang)     LANG="$2";     shift 2 ;;
    --sdk-root) SDK_ROOT="$2"; shift 2 ;;
    --output)   OUTPUT="$2";   shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$LANG" ]]; then
  echo "Usage: sdk-compat-extract.sh --lang <language> [--sdk-root <path>] [--output <dir>]" >&2
  exit 1
fi

if [[ -z "$SDK_ROOT" ]]; then
  SDK_ROOT=".oagen/${LANG}/sdk"
fi

if [[ -z "$OUTPUT" ]]; then
  OUTPUT=".oagen/${LANG}"
fi

exec npx oagen compat-extract --lang "$LANG" --sdk-path "$SDK_ROOT" --output "$OUTPUT" --spec "$SPEC"
