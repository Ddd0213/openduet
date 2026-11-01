#!/usr/bin/env bash
# Pure setup network checks; safe to source without starting Docker or reading dotenv.

default_route_addresses() {
  if command -v ip >/dev/null 2>&1; then
    { ip -4 route get 1.1.1.1 2>/dev/null || true; ip -6 route get 2606:4700:4700::1111 2>/dev/null || true; } |
      awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }'
  elif command -v route >/dev/null 2>&1 && command -v ipconfig >/dev/null 2>&1; then
    local interface
    interface=$(route -n get default 2>/dev/null | awk '/interface:/ {print $2}')
    if [ -n "$interface" ]; then
      ipconfig getifaddr "$interface" 2>/dev/null || true
    fi
    interface=$(route -n get -inet6 default 2>/dev/null | awk '/interface:/ {print $2}')
    if [ -n "$interface" ]; then
      ifconfig "$interface" 2>/dev/null | awk '/inet6 / {sub(/%.*/, "", $2); print $2}'
    fi
  fi
}

is_local_address() {
  local addr=${1%%\%*}
  case $addr in
    *:*) case $(printf '%s' "$addr" | tr '[:upper:]' '[:lower:]') in
      ::1|fc*:*|fd*:*|fe8*:*|fe9*:*|fea*:*|feb*:*) return 0 ;; *) return 1 ;; esac ;;
    *) printf '%s\n' "$addr" | awk -F. '
      NF != 4 {exit 1}
      {for (i=1;i<=4;i++) if ($i !~ /^[0-9]+$/ || $i > 255) exit 1}
      $1==10 || $1==127 || ($1==172 && $2>=16 && $2<=31) || ($1==192 && $2==168) ||
      ($1==100 && $2>=64 && $2<=127) || ($1==169 && $2==254) {exit 0}
      {exit 1}' ;;
  esac
}

route_exposure() { # addresses -> local|public|unknown; any public default route wins
  local addr seen=0
  for addr in $1; do
    seen=1
    if ! is_local_address "$addr"; then printf 'public'; return; fi
  done
  if [ "$seen" = 1 ]; then printf 'local'; else printf 'unknown'; fi
}

require_explicit_mode() { # interactive mode
  [ "$1" = 1 ] || [ -n "$2" ] || {
    printf 'error: non-interactive setup requires --mode lan|tailscale|caddy|tunnel\n' >&2
    return 1
  }
}

select_lan_bind() { # explicit-bind stored-bind fresh-install
  if [ -n "$1" ]; then printf '%s' "$1";
  elif [ "$3" = 1 ]; then printf '0.0.0.0';
  else printf '%s' "${2:-0.0.0.0}"; fi
}

check_lan_binding() { # bind explicit-bind route-exposure interactive
  [ "$1" = 0.0.0.0 ] && [ -z "$2" ] || return 0
  case $3 in
    local) return 0 ;;
    public) printf 'error: LAN on a public default route is unsafe; use caddy/tunnel/tailscale or explicitly pass --bind-addr\n' >&2; return 1 ;;
    *)
      [ "$4" = 1 ] || { printf 'error: cannot detect default-route address; pass --bind-addr explicitly\n' >&2; return 1; }
      local answer
      read -r -p 'Cannot detect the default-route address. Publish plain HTTP on all interfaces? (yes/no): ' answer
      [ "$answer" = yes ] ;;
  esac
}
