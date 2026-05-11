#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PARENT_DIR=""

usage() {
  echo "Usage: sdk-generate-all.sh --parent-dir <path>" >&2
  echo "  <path> is the directory containing workos-{lang} SDK repos" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --parent-dir)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --parent-dir requires a path argument" >&2
        usage
      fi
      PARENT_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

if [[ -z "$PARENT_DIR" ]]; then
  usage
fi

PARENT_DIR="$(cd "$PARENT_DIR" && pwd)"

PASSED=()
FAILED=()

LANGUAGES=$(npm --prefix "$REPO_ROOT" run sdk:languages --silent 2>/dev/null)

for lang in $LANGUAGES; do
  OUTPUT="$PARENT_DIR/workos-$lang"
  echo ""
  echo "========================================"
  echo "Generating SDK: $lang -> $OUTPUT"
  echo "========================================"

  if ! npm --prefix "$REPO_ROOT" run sdk:generate -- --lang "$lang" --output "$OUTPUT"; then
    echo "[FAIL] Generation failed for: $lang"
    FAILED+=("$lang (generation failed)")
    continue
  fi

  CI_SCRIPT=""
  if [[ -f "$OUTPUT/scripts/ci" ]]; then
    CI_SCRIPT="$OUTPUT/scripts/ci"
  elif [[ -f "$OUTPUT/script/ci" ]]; then
    CI_SCRIPT="$OUTPUT/script/ci"
  fi

  if [[ -z "$CI_SCRIPT" ]]; then
    echo "[WARN] No CI script found for: $lang (checked scripts/ci and script/ci)"
    PASSED+=("$lang (no CI script)")
    continue
  fi

  echo "Running CI: $CI_SCRIPT"
  if ! (cd "$OUTPUT" && bash "$CI_SCRIPT"); then
    echo "[FAIL] CI failed for: $lang"
    FAILED+=("$lang (CI failed)")
  else
    echo "[PASS] $lang"
    PASSED+=("$lang")
  fi
done

echo ""
echo "========================================"
echo "Results"
echo "========================================"

echo ""
echo "PASSED (${#PASSED[@]}):"
if [[ ${#PASSED[@]} -eq 0 ]]; then
  echo "  (none)"
else
  for s in "${PASSED[@]}"; do
    echo "  ✓ $s"
  done
fi

echo ""
echo "FAILED (${#FAILED[@]}):"
if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "  (none)"
else
  for s in "${FAILED[@]}"; do
    echo "  ✗ $s"
  done
fi

echo ""
if [[ ${#FAILED[@]} -gt 0 ]]; then
  exit 1
fi
