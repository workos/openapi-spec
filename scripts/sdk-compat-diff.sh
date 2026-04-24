#!/usr/bin/env bash
set -euo pipefail

LANG=""
BASELINE=""
CANDIDATE=""
FAIL_ON="breaking"
OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang)      LANG="$2";      shift 2 ;;
    --baseline)  BASELINE="$2";  shift 2 ;;
    --candidate) CANDIDATE="$2"; shift 2 ;;
    --fail-on)   FAIL_ON="$2";   shift 2 ;;
    --output)    OUTPUT="$2";    shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$BASELINE" && -z "$LANG" ]]; then
  echo "Usage: sdk-compat-diff.sh --lang <language> [--baseline <path>] [--candidate <path>] [--fail-on <level>] [--output <path>]" >&2
  echo "       sdk-compat-diff.sh --baseline <path> --candidate <path> [--fail-on <level>] [--output <path>]" >&2
  exit 1
fi

if [[ -n "$LANG" ]]; then
  if [[ -z "$BASELINE" ]]; then
    BASELINE=".oagen/${LANG}/.oagen-compat-snapshot.json"
  fi
  if [[ -z "$CANDIDATE" ]]; then
    CANDIDATE=".oagen/${LANG}/sdk/.oagen-compat-snapshot.json"
  fi
  if [[ -z "$OUTPUT" ]]; then
    OUTPUT=".oagen/${LANG}/compat-report.json"
  fi
fi

if [[ -z "$BASELINE" || -z "$CANDIDATE" ]]; then
  echo "Error: both --baseline and --candidate are required (or provide --lang to use defaults)" >&2
  exit 1
fi

ARGS=(--baseline "$BASELINE" --candidate "$CANDIDATE" --fail-on "$FAIL_ON")
if [[ -n "$OUTPUT" ]]; then
  ARGS+=(--output "$OUTPUT")
fi

exec npx oagen compat-diff "${ARGS[@]}"
