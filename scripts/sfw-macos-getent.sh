#!/usr/bin/env bash
# Job-local macOS getent(ahosts) adapter for the pinned Socket Firewall teardown.
# dscacheutil uses the native resolver path, including /etc/hosts; this is not
# a remote-DNS substitute or a no-op success shim.
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage:
  sfw-macos-getent.sh install
  getent ahosts <host>
USAGE
}

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

install_shim() {
  if command -v getent >/dev/null 2>&1; then
    printf 'getent already available; Socket Firewall macOS shim not installed.\n'
    return 0
  fi
  [ -n "${RUNNER_TEMP:-}" ] || fail 'RUNNER_TEMP is required to install the macOS getent shim.'
  [ -n "${GITHUB_PATH:-}" ] || fail 'GITHUB_PATH is required to install the macOS getent shim.'
  [ -x /usr/bin/dscacheutil ] || fail 'dscacheutil is required to install the macOS getent shim.'
  command -v python3 >/dev/null 2>&1 || fail 'python3 is required to install the macOS getent shim.'

  local shim_dir
  shim_dir="$RUNNER_TEMP/sfw-getent"
  mkdir -p "$shim_dir"
  cp "$0" "$shim_dir/getent"
  chmod 755 "$shim_dir/getent"
  printf '%s\n' "$shim_dir" >>"$GITHUB_PATH"
  printf 'Installed job-local Socket Firewall macOS getent shim at %s/getent.\n' "$shim_dir"
}

validate_ip() {
  local family="$1"
  local address="$2"
  python3 - "$family" "$address" <<'PY'
import ipaddress
import sys
family = sys.argv[1]
address = sys.argv[2]
try:
    parsed = ipaddress.ip_address(address)
except ValueError:
    sys.exit(1)
if family == "4" and parsed.version != 4:
    sys.exit(1)
if family == "6" and parsed.version != 6:
    sys.exit(1)
PY
}

emit_ahosts() {
  local dscacheutil="$1"
  shift
  if [ "$#" -ne 2 ] || [ "$1" != 'ahosts' ]; then
    usage
    exit 2
  fi

  local host="$2"
  local raw line field address family records found
  records=''
  found=false

  [ -x "$dscacheutil" ] || fail "dscacheutil is required to verify DNS restoration: $dscacheutil"
  command -v python3 >/dev/null 2>&1 || fail 'python3 is required to validate macOS DNS address records.'

  "$dscacheutil" -flushcache >/dev/null 2>&1 || true
  if ! raw="$({ "$dscacheutil" -q host -a name "$host"; } 2>/dev/null)"; then
    fail "dscacheutil host query failed for $host"
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ip_address:*|ipv6_address:*)
        set -- $line
        if [ "$#" -ne 2 ]; then
          fail "Malformed dscacheutil address record for $host: $line"
        fi
        field="$1"
        address="$2"
        case "$field" in
          ip_address:) family=4 ;;
          ipv6_address:) family=6 ;;
          *) fail "Unsupported dscacheutil address record for $host: $line" ;;
        esac
        if ! validate_ip "$family" "$address"; then
          fail "Malformed dscacheutil address for $host: $line"
        fi
        found=true
        records="${records}${address} STREAM ${host}
${address} DGRAM ${host}
${address} RAW ${host}
"
        ;;
    esac
  done <<EOFRAW
$raw
EOFRAW

  [ "$found" = true ] || fail "No usable dscacheutil address records for $host"
  printf '%s' "$records"
}

case "${1:-}" in
  install)
    shift
    [ "$#" -eq 0 ] || { usage; exit 2; }
    install_shim
    ;;
  __test_getent)
    shift
    [ "$#" -ge 1 ] || { usage; exit 2; }
    test_dscacheutil="$1"
    shift
    emit_ahosts "$test_dscacheutil" "$@"
    ;;
  *)
    emit_ahosts /usr/bin/dscacheutil "$@"
    ;;
esac
