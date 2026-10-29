#!/usr/bin/env bash
set -euo pipefail

SPEC="spec/open-api-spec.yaml"
LANG=""
OUTPUT=""
NAMESPACE=""
SERVICES=""
BASELINE_REF=""
EXTRA_ARGS=()
TMP_SURFACE=""
TMP_SDK=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang)      LANG="$2";      shift 2 ;;
    --output)    OUTPUT="$2";    shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --services)  SERVICES="$2";  shift 2 ;;
    --baseline-ref) BASELINE_REF="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Scoped generation: forward --services to `oagen generate`. Absent (or empty)
# means full generation — no flag is appended, preserving the default behavior
# every existing caller relies on. An unknown service makes oagen exit non-zero
# with the valid-name list, which `set -euo pipefail` propagates as a job failure.
#
# First canonicalize the list to post-mount names: callers (the dashboard,
# manual dispatches) sometimes pass a raw pre-mount spec tag like
# `UserManagementRedirectUris` (mounts onto `UserManagement`), which oagen
# rejects outright. canonicalize-services folds those onto their post-mount
# target using the same resolution oagen generate applies; genuine typos still
# pass through and fail loudly. Its own failures degrade to the raw list.
#
# canonicalize-services prints an EMPTY list when the selection covers every
# service (the dashboard's "Stage all"). Fall through to full generation then:
# a scoped run disables oagen's pruner, so a resource a mount rule folded away
# would leave its orphaned resource + test files on disk, still calling a client
# accessor the regenerated client no longer has.
if [[ -n "$SERVICES" ]]; then
  SERVICES="$(node "$(dirname "$0")/canonicalize-services.mjs" --spec "$SPEC" --services "$SERVICES")"
  if [[ -n "$SERVICES" ]]; then
    EXTRA_ARGS+=(--services "$SERVICES")
  fi
fi

if [[ -z "$LANG" ]]; then
  echo "Usage: sdk-generate.sh --lang <language> --output <path> [--namespace <ns>] [--services <list>] [--baseline-ref <git-ref>]" >&2
  exit 1
fi

if [[ -z "$OUTPUT" ]]; then
  echo "error: required option '--output <dir>' not specified" >&2
  exit 1
fi

# Default namespace: WorkOS for languages whose namespace is a cased type/module
# name (php namespace, Swift module, Kotlin client class), workos for everything
# else. oagen copies --namespace into `namespacePascal` verbatim, so a language
# that renders the namespace as a type name needs the cased form here; the
# android emitter lowercases it independently for Kotlin package segments.
if [[ -z "$NAMESPACE" ]]; then
  if [[ "$LANG" == "php" || "$LANG" == "ios" || "$LANG" == "android" ]]; then
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

# Languages whose shipped SDK `oagen extract` can read into an API surface. Keep
# in step with oagen's extractor registry (src/compat/extractor-registry.ts).
EXTRACTABLE_LANGS=" node php python ruby go rust kotlin dotnet "

# A live SDK checkout is the baseline: the surface extracted from it lets the
# emitter keep the names and positions callers already depend on. A scratch
# output directory has no history worth preserving and gets no surface — and a
# scratch directory inside this repository (`.oagen/<lang>/sdk`) is still
# scratch: only the root of its own checkout counts as a live SDK.
is_checkout_root() {
  local top
  top="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ "$top" == "$(cd "$1" && pwd -P)" ]]
}
is_live_sdk() {
  [[ "$EXTRACTABLE_LANGS" == *" $LANG "* ]] || return 1
  if [[ "$LANG" == "node" ]]; then
    [[ -f "$1/package.json" && -d "$1/src" ]]
  else
    is_checkout_root "$1"
  fi
}

# Make `--baseline-ref` resolvable in a shallow checkout: a tag that is not
# present locally is fetched on demand. Anything else must already exist.
ensure_ref() {
  git -C "$1" rev-parse --verify --quiet "$2^{commit}" >/dev/null && return 0
  git -C "$1" fetch --quiet --depth 1 origin "refs/tags/$2:refs/tags/$2" >/dev/null 2>&1 || true
  git -C "$1" rev-parse --verify --quiet "$2^{commit}" >/dev/null \
    || { echo "sdk-generate.sh: baseline ref '$2' not found in $1" >&2; exit 1; }
}

# The baseline is the SDK as shipped: HEAD by default, or `--baseline-ref` when
# HEAD is not the surface to preserve (a repair release after a broken one). An
# explicit ref that could not be honored is an error, never a silent no-op —
# `--baseline-ref HEAD` included, since it asks for a surface just as firmly.
if [[ -n "$BASELINE_REF" ]]; then
  if [[ "$EXTRACTABLE_LANGS" != *" $LANG "* ]]; then
    echo "sdk-generate.sh: --baseline-ref has no effect for $LANG: oagen has no extractor for it" >&2
    exit 1
  fi
  if ! is_checkout_root "$OUTPUT"; then
    echo "sdk-generate.sh: --baseline-ref needs --output to be the root of an SDK checkout" >&2
    exit 1
  fi
fi
if is_live_sdk "$OUTPUT"; then
  TMP_SURFACE="$(mktemp "${TMPDIR:-/tmp}/oagen-${LANG}-surface.XXXXXX")"
  EXTRACT_SDK="$OUTPUT"
  if is_checkout_root "$OUTPUT"; then
    ensure_ref "$OUTPUT" "${BASELINE_REF:-HEAD}"
    TMP_SDK="$(mktemp -d "${TMPDIR:-/tmp}/oagen-${LANG}-sdk.XXXXXX")"
    git -C "$OUTPUT" worktree add --detach "$TMP_SDK" "${BASELINE_REF:-HEAD}" >/dev/null 2>&1
    EXTRACT_SDK="$TMP_SDK"

    if [[ "$LANG" == "node" && -f "$OUTPUT/.oagen-manifest.json" ]]; then
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

# These emitters preserve positional arguments and public model aliases from
# the existing SDK surface. Capture it before generation overwrites any files.
# A new SDK has no manifest/baseline yet and uses the normal generated surface.
if [[ "$LANG" == "go" || "$LANG" == "kotlin" || "$LANG" == "php" ]] && [[ -f "$OUTPUT/.oagen-manifest.json" ]]; then
  TMP_SURFACE="$(mktemp "${TMPDIR:-/tmp}/oagen-${LANG}-surface.XXXXXX")"
  npx oagen extract --sdk-path "$OUTPUT" --lang "$LANG" --output "$TMP_SURFACE" >/dev/null
  EXTRA_ARGS+=(--api-surface "$TMP_SURFACE")
fi

# `${EXTRA_ARGS[@]+…}` guard: macOS runners still ship bash 3.2, where expanding
# an empty array under `set -u` is a fatal "unbound variable" error. A language
# without an extractor (ios, android, elixir) reaches the exec with EXTRA_ARGS
# still empty unless `--services` was given, which is why the ios job alone was
# affected: it reported success while generating nothing, then ran CI against
# the unmodified checkout.
#
# Not fixable at the trap: with any EXIT trap installed, bash 3.2 hands the
# handler `$?` == 0 for this particular fatal, so even `cleanup() { local s=$?;
# …; exit $s; }` still exits 0. Ordinary command failures are unaffected — they
# propagate through the trap correctly. Avoiding the error is the only fix.
# Keep the EXIT trap active so temporary surfaces/worktrees are cleaned up.
npx oagen generate --lang "$LANG" --spec "$SPEC" --namespace "$NAMESPACE" --output "$OUTPUT" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
