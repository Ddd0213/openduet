#!/usr/bin/env bash
# End-to-end check of a running stack (run from the repo root after ./scripts/setup.sh):
#   - every service is running and healthy; the computer and egress publish no port
#   - in the backend container (src/cli/smoke.ts): server-info, sign-in with a throwaway user,
#     /api/me, sign-out, the computer refusing calls without COMPUTER_TOKEN, Chromium opening
#     https://example.com through the egress proxy, the browser failing on 169.254.169.254
#   - in the computer container: private, link-local (169.254.169.254), CGNAT, ULA and Docker
#     addresses are unreachable, both directly and through the egress proxy; a public site works
#     through the proxy
# Without OpenDuet's computer (setup.sh --computer off): the backend checks only, plus that the
# computer and egress aren't running and the backend really reports the computer as off.
# The throwaway user is deleted again; tokens and passwords are never printed.
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

FAILS=0
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILS=$((FAILS + 1)); }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# Compose exec can select a one-off run container. Pin the running service's first replica.
service_id() {
  local ids id labels
  ids=$(docker compose ps --status running -q "$1") || return 1
  for id in $ids; do
    labels=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.oneoff"}} {{index .Config.Labels "com.docker.compose.container-number"}} {{.State.Running}}' "$id") || return 1
    case $labels in 'False 1 true'|'false 1 true') printf '%s\n' "$id"; return 0 ;; esac
  done
  die "service $1 replica 1 is not running (docker compose up -d --wait)"
}

[ -f backend/.env ] && [ -L .env ] || die "run ./scripts/setup.sh first (backend/.env and the ./.env link are missing)"

# ------------------------------------------------------------ services
# M20: OpenDuet's computer is optional (./scripts/setup.sh --computer off puts it and egress behind
# a profile nobody turns on, via compose.no-computer.yml in COMPOSE_FILE). Deployed = compose
# lists the service; then it has to be running and healthy like the backend.
# Read the list once: `compose config | grep -q` under pipefail fails now and then (grep exits on the
# match, compose gets EPIPE and exits 255), which would skip the computer's checks.
listed=$(docker compose config --services 2>/dev/null || true)
COMPUTER=off
if grep -qx computer <<<"$listed"; then COMPUTER=on; fi
# M28: computer_exec's commands run in computer-exec (no profiles, no token); listed with the computer.
EXEC=off
if grep -qx computer-exec <<<"$listed"; then EXEC=on; fi
computer_services=(computer egress)
[ "$EXEC" = off ] || computer_services+=(computer-exec)
services=(backend)
[ "$COMPUTER" = off ] || services+=("${computer_services[@]}")
BACKEND=""; COMPUTER_ID=""
for svc in "${services[@]}"; do
  id=$(service_id "$svc") || die "could not find the running $svc service container"
  case $svc in backend) BACKEND=$id ;; computer) COMPUTER_ID=$id ;; esac
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")
  if [ "$health" = healthy ]; then pass "$svc is healthy"; else fail "$svc health is $health"; fi
done
if [ "$COMPUTER" = off ]; then
  pass "OpenDuet's computer is not deployed (setup.sh --computer off): its checks are skipped"
  for svc in computer computer-exec egress; do
    if [ -z "$(docker compose --profile computer ps -q "$svc" 2>/dev/null || true)" ]; then pass "$svc is not running"; else fail "$svc is running although the computer is off"; fi
  done
fi
isolated=()
[ "$COMPUTER" = off ] || isolated=("${computer_services[@]}")
for svc in ${isolated[@]+"${isolated[@]}"}; do
  id=$(service_id "$svc") || die "could not find the running $svc service container"
  ports=$(docker inspect --format '{{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{$p}} {{end}}{{end}}' "$id")
  if [ -z "$ports" ]; then pass "$svc publishes no port"; else fail "$svc publishes $ports"; fi
  mounts=$(docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$id")
  case $mounts in *docker.sock*) fail "$svc has the Docker socket mounted" ;; *) pass "$svc has no Docker socket" ;; esac
done
if [ "$COMPUTER" = on ] && [ "$EXEC" = on ]; then
  id=$(service_id computer-exec) || die "could not find the running computer-exec service container"
  dests=$(docker inspect --format '{{range .Mounts}}{{.Destination}} {{end}}' "$id")
  case " $dests" in *" /profiles "*) fail "computer-exec mounts the browser profiles" ;; *) pass "computer-exec has no browser profiles (mounts: $dests)" ;; esac
  # Names only, never values.
  env_names=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" | cut -d= -f1)
  if grep -qx COMPUTER_TOKEN <<<"$env_names"; then
    fail "computer-exec has COMPUTER_TOKEN"
  else
    pass "computer-exec has no COMPUTER_TOKEN"
  fi
fi

# ------------------------------------------------------------ API + computer, from the backend
SMOKE_USER="smoke_$(openssl rand -hex 4)"
SMOKE_PASSWORD=$(openssl rand -hex 16)
export SMOKE_PASSWORD
cleanup() {
  docker exec "$BACKEND" bun src/cli/user-delete.ts --username "$SMOKE_USER" --yes >/dev/null 2>&1 || true
}
trap cleanup EXIT

printf '%s\n' "$SMOKE_PASSWORD" | docker exec -i "$BACKEND" bun src/cli/user-create.ts \
  --username "$SMOKE_USER" --name "Smoke Test" --password-stdin >/dev/null \
  || die "could not create the throwaway user"
if docker exec -e SMOKE_PASSWORD "$BACKEND" bun src/cli/smoke.ts "$SMOKE_USER"; then :; else FAILS=$((FAILS + 1)); fi

if [ "$COMPUTER" = off ]; then
  printf '\n'
  if [ "$FAILS" -eq 0 ]; then printf 'smoke: all checks passed (without OpenDuet'\''s computer)\n'; else printf 'smoke: %d check(s) failed\n' "$FAILS"; exit 1; fi
  exit 0
fi

# ------------------------------------------------------------ egress block check, from the computer
project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$COMPUTER_ID")
gateway() { docker network inspect --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}' "${project}_$1" 2>/dev/null | awk '{ print $1 }'; }
backend_ip=$(docker inspect --format "{{(index .NetworkSettings.Networks \"${project}_internal\").IPAddress}}" "$BACKEND")

# Addresses that must stay unreachable from inside OpenDuet's computer, directly and via the proxy.
targets=(
  "http://169.254.169.254/latest/meta-data/"
  "http://10.0.0.1/" "http://172.16.0.1/" "http://192.168.1.1/" "http://192.168.65.1/"
  "http://100.64.0.1/"
  "http://[fd00::1]/" "http://[fe80::1]/" "http://[::ffff:169.254.169.254]/"
)
for net in public internal; do
  gw=$(gateway "$net")
  [ -z "$gw" ] || targets+=("http://$gw/")
done
# Reachable on purpose but never through the proxy: the computer's own loopback and its one
# direct peer, the backend (whose API needs a session; checked below).
port=$(awk -F= '$1 == "PORT" { v = $2 } END { print v ? v : 3000 }' backend/.env)
proxy_only=("http://127.0.0.1:4100/health" "http://backend:$port/api/server-info")
[ -z "$backend_ip" ] || proxy_only+=("http://$backend_ip:$port/api/server-info")

# shellcheck disable=SC2016 # expanded by the shell inside the container
probe='
mode=$1; url=$2
if [ "$mode" = direct ]; then
  code=$(curl --noproxy "*" -s -o /dev/null -w "%{http_code}" --connect-timeout 4 --max-time 6 "$url"); rc=$?
  if [ $rc -eq 0 ] && [ "$code" != 000 ]; then echo "OPEN (HTTP $code)"; else echo "blocked (curl exit $rc)"; fi
else
  hdr=$(curl --proxy http://egress:3128 --noproxy "" -s -D - -o /dev/null --connect-timeout 4 --max-time 8 "$url"); rc=$?
  first=$(printf "%s\n" "$hdr" | head -n 1 | tr -d "\r")
  if printf "%s" "$hdr" | grep -qi "^X-Smokescreen-Error"; then echo "blocked (egress refused: $first)"
  elif [ $rc -ne 0 ]; then echo "blocked (curl exit $rc)"
  else echo "OPEN ($first)"; fi
fi'

check() { # check MODE URL
  local result
  result=$(docker exec "$COMPUTER_ID" sh -c "$probe" probe "$1" "$2" 2>/dev/null || true)
  case $result in
    blocked*) pass "computer -> $2 ($1): $result" ;;
    *) fail "computer -> $2 ($1): ${result:-no answer}" ;;
  esac
}
for url in "${targets[@]}"; do check direct "$url"; check proxy "$url"; done
for url in "${proxy_only[@]}"; do check proxy "$url"; done

# The backend is the computer's direct peer, but its API refuses a caller without a session.
code=$(docker exec "$COMPUTER_ID" sh -c "curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 6 http://backend:$port/api/me" 2>/dev/null || true)
if [ "$code" = 401 ]; then pass "computer -> backend /api/me without a session: HTTP 401"; else fail "computer -> backend /api/me without a session: ${code:-no answer}"; fi

# HTTPS through the proxy (CONNECT) is refused for the metadata address too.
code=$(docker exec "$COMPUTER_ID" sh -c 'curl --proxy http://egress:3128 --noproxy "" -s -o /dev/null -w "%{http_code}" --max-time 8 https://169.254.169.254/' 2>/dev/null || true)
case $code in 2*|3*) fail "computer -> https://169.254.169.254 via CONNECT: HTTP $code" ;; *) pass "computer -> https://169.254.169.254 (CONNECT): refused" ;; esac

# Control: the proxy does let public traffic through, so the refusals above are the policy.
code=$(docker exec "$COMPUTER_ID" sh -c 'curl -s -o /dev/null -w "%{http_code}" --max-time 15 https://example.com/' 2>/dev/null || true)
case $code in 2*|3*) pass "computer -> https://example.com via egress: HTTP $code" ;; *) fail "computer -> https://example.com via egress: ${code:-no answer}" ;; esac
code=$(docker exec "$COMPUTER_ID" sh -c 'curl --noproxy "*" -s -o /dev/null -w "%{http_code}" --connect-timeout 4 --max-time 6 https://example.com/' 2>/dev/null || true)
case $code in 2*|3*) fail "computer reaches https://example.com without the proxy" ;; *) pass "computer has no direct route out (example.com without the proxy fails)" ;; esac

printf '\n'
if [ "$FAILS" -eq 0 ]; then printf 'smoke: all checks passed\n'; else printf 'smoke: %d check(s) failed\n' "$FAILS"; exit 1; fi
