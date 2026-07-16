#!/usr/bin/env bash
set -euo pipefail

SPEC="spec/open-api-spec.yaml"
LANG=""
OUTPUT=""
NAMESPACE=""
SERVICES=""
EXTRA_ARGS=()
TMP_SURFACE=""
TMP_SDK=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang)      LANG="$2";      shift 2 ;;
    --output)    OUTPUT="$2";    shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --services)  SERVICES="$2";  shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Scoped generation: forward --services to `oagen generate`. Absent (or empty)
# means full generation — no flag is appended, preserving the default behaviour
# every existing caller relies on. An unknown service makes oagen exit non-zero
# with the valid-name list, which `set -euo pipefail` propagates as a job failure.
if [[ -n "$SERVICES" ]]; then
  EXTRA_ARGS+=(--services "$SERVICES")
fi

if [[ -z "$LANG" ]]; then
  echo "Usage: sdk-generate.sh --lang <language> --output <path> [--namespace <ns>] [--services <list>]" >&2
  exit 1
fi

if [[ -z "$OUTPUT" ]]; then
  echo "error: required option '--output <dir>' not specified" >&2
  exit 1
fi

# Default namespace: WorkOS for languages whose namespace is a cased type/module
# name (php namespace, Swift module), workos for everything else
if [[ -z "$NAMESPACE" ]]; then
  if [[ "$LANG" == "php" || "$LANG" == "ios" ]]; then
    NAMESPACE="WorkOS"
  else
    NAMESPACE="workos"
  fi
fi

cleanup() {
  if [[ -n "$TMP_SDK" ]]; then
    if git -C "$OUTPUT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      git -C "$OUTPUT" worktree remove --force "$TMP_SDK" >/dev/null 2>&1 || true
    fi
    rm -rf "$TMP_SDK"
  fi
  if [[ -n "$TMP_SURFACE" && -f "$TMP_SURFACE" ]]; then
    rm -f "$TMP_SURFACE"
  fi
}
trap cleanup EXIT

if [[ "$LANG" == "node" && -f "$OUTPUT/package.json" && -d "$OUTPUT/src" ]]; then
  TMP_SURFACE="$(mktemp "${TMPDIR:-/tmp}/oagen-node-surface.XXXXXX")"
  EXTRACT_SDK="$OUTPUT"
  if git -C "$OUTPUT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    TMP_SDK="$(mktemp -d "${TMPDIR:-/tmp}/oagen-node-sdk.XXXXXX")"
    git -C "$OUTPUT" worktree add --detach "$TMP_SDK" HEAD >/dev/null 2>&1
    EXTRACT_SDK="$TMP_SDK"

    if [[ -f "$OUTPUT/.oagen-manifest.json" ]]; then
      RECOVERY_COUNT="$(python3 - <<'PY' "$OUTPUT" "$TMP_SDK"
import json
import pathlib
import shutil
import subprocess
import sys

output = pathlib.Path(sys.argv[1])
head = pathlib.Path(sys.argv[2])
manifest_path = output / '.oagen-manifest.json'
manifest = json.loads(manifest_path.read_text()).get('files', [])
tracked = set(subprocess.check_output(['git', '-C', str(output), 'ls-files', 'src'], text=True).split())
manifest_src = [path for path in manifest if path.startswith('src/')]
has_untracked_manifest_paths = any(path not in tracked for path in manifest_src)

if not has_untracked_manifest_paths:
    print(0)
    raise SystemExit(0)

restored = 0
for rel in manifest_src:
    if rel not in tracked:
        continue
    src = head / rel
    dst = output / rel
    if not src.exists():
        continue
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    restored += 1

print(restored)
PY
)"
      if [[ "$RECOVERY_COUNT" != "0" ]]; then
        echo "Node SDK recovery: restored $RECOVERY_COUNT tracked manifest files from HEAD"
      fi
    fi
  fi
  npx oagen extract --sdk-path "$EXTRACT_SDK" --lang "$LANG" --output "$TMP_SURFACE" >/dev/null
  EXTRA_ARGS+=(--api-surface "$TMP_SURFACE")
fi

exec npx oagen generate --lang "$LANG" --spec "$SPEC" --namespace "$NAMESPACE" --output "$OUTPUT" "${EXTRA_ARGS[@]}"
