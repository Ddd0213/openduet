#!/bin/sh
set -eu
. /usr/local/lib/openduet-fake-ip.sh
if fake_ip_allowed; then
  printf 'OpenDuet egress: fake-IP range enabled\n' >&2
else
  printf 'OpenDuet egress: fake-IP range denied\n' >&2
  set -- "$@" --deny-range=198.18.0.0/15
fi
exec /usr/local/bin/smokescreen "$@"
