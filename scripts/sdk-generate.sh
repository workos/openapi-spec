#!/usr/bin/env bash
set -euo pipefail

SPEC="spec/open-api-spec.yaml"
LANG=""
OUTPUT=""
NAMESPACE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang)      LANG="$2";      shift 2 ;;
    --output)    OUTPUT="$2";    shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$LANG" ]]; then
  echo "Usage: sdk-generate.sh --lang <language> --output <path> [--namespace <ns>]" >&2
  exit 1
fi

if [[ -z "$OUTPUT" ]]; then
  echo "error: required option '--output <dir>' not specified" >&2
  exit 1
fi

# Default namespace: WorkOS for php, workos for everything else
if [[ -z "$NAMESPACE" ]]; then
  if [[ "$LANG" == "php" ]]; then
    NAMESPACE="WorkOS"
  else
    NAMESPACE="workos"
  fi
fi

exec npx oagen generate --lang "$LANG" --spec "$SPEC" --namespace "$NAMESPACE" --output "$OUTPUT"
