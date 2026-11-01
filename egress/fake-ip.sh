#!/bin/sh
# Safe to source: detection only runs when fake_ip_allowed is called.
resolve_probe() {
  nslookup -timeout=2 "$1" 2>/dev/null | awk '
    /^Name:/ {answer=1}
    answer && /^Address/ {for(i=1;i<=NF;i++) if($i ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ || $i ~ /^[0-9a-fA-F]*:[0-9a-fA-F:]+$/) print $i}'
}
fake_ip_allowed() {
  case ${ALLOW_FAKE_IP_RANGE:-auto} in
    1) return 0 ;;
    0) return 1 ;;
    auto)
      count=0
      for host in github.com www.google.com www.cloudflare.com; do
        addresses=$(resolve_probe "$host")
        valid=1
        [ -n "$addresses" ] || valid=0
        for addr in $addresses; do
          case $addr in 198.18.*|198.19.*) ;; *) valid=0 ;; esac
        done
        [ "$valid" = 0 ] || count=$((count + 1))
      done
      [ "$count" -ge 2 ] ;;
    *) printf 'ALLOW_FAKE_IP_RANGE must be auto, 1 or 0\n' >&2; return 1 ;;
  esac
}
