#!/usr/bin/env bash
# Build the stack's images here for another machine's platform and copy them over, for a server
# that cannot reach GitHub, Docker Hub or GHCR (or builds too slowly):
#   ./scripts/export-images.sh user@server [SERVICE...]        build linux/amd64, stream over SSH
#   ./scripts/export-images.sh --output DIR [SERVICE...]       write DIR/<service>.tar.gz instead
# Options:
#   --platform linux/arm64   target platform (default linux/amd64)
#   --with-caddy             also the caddy image (domain + HTTPS mode)
# SERVICE is any of backend computer egress caddy (default: backend computer egress).
# Then on the server: ./scripts/setup.sh --no-build --mode <mode> (lan|tailscale|caddy|tunnel).
# Caddy/tunnel also need --public-url https://<domain>; export Caddy with --with-caddy.
# For an archive directory: for f in DIR/*.tar.gz; do docker load -i "$f"; done
#
# Images keep the names compose uses, ${DUET_IMAGE_PREFIX:-openduet}-<service>:${DUET_VERSION:-local}.
# `docker buildx build --output type=docker` writes the same archive `docker save` does, straight
# into `ssh <server> docker load`, without replacing this machine's own images of the same name.
# The tunnel profile's cloudflared image is not included; the server pulls it.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

PLATFORM=linux/amd64; TARGET=""; OUTPUT=""; SERVICES=()
while [ $# -gt 0 ]; do
  case $1 in
    --platform) [ $# -ge 2 ] || die "--platform needs a value"; PLATFORM=$2; shift ;;
    --output) [ $# -ge 2 ] || die "--output needs a directory"; OUTPUT=$2; shift ;;
    --with-caddy) SERVICES+=(caddy) ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    backend|computer|egress|caddy) SERVICES+=("$1") ;;
    -*) die "unknown option: $1" ;;
    *) [ -z "$TARGET" ] || die "only one server can be given"; TARGET=$1 ;;
  esac
  shift
done
[ -n "$TARGET" ] || [ -n "$OUTPUT" ] || die "usage: scripts/export-images.sh user@server | --output DIR [SERVICE...]"
case " ${SERVICES[*]-} " in
  *" backend "*|*" computer "*|*" egress "*) ;;
  *) SERVICES=(backend computer egress "${SERVICES[@]}") ;;
esac
docker buildx version >/dev/null 2>&1 || die "docker buildx is required"

env_get() { [ -f backend/.env ] && awk -F= -v k="$1" '$1 == k { v = substr($0, length(k) + 2) } END { print v }' backend/.env; }
PREFIX=${DUET_IMAGE_PREFIX:-$(env_get DUET_IMAGE_PREFIX || true)}; PREFIX=${PREFIX:-openduet}
VERSION=${DUET_VERSION:-$(env_get DUET_VERSION || true)}; VERSION=${VERSION:-local}

# The computer's pinned upstream (OpenBot at a commit; M20b: computer/Dockerfile patches it), read
# from compose.yml so the commit lives in one place.
COMPUTER_UPSTREAM=$(awk '/^  computer:/ { c = 1 } c && /upstream:/ { print $2; exit }' compose.yml)
[ -n "$COMPUTER_UPSTREAM" ] || die "could not read the computer's upstream context from compose.yml"

build() { # build SERVICE -> image archive on stdout
  local svc=$1 ref="$PREFIX-$1:$VERSION"
  local -a args=(--platform "$PLATFORM" --tag "$ref" --output "type=docker,dest=-")
  case $svc in
    backend) docker buildx build "${args[@]}" backend ;;
    egress) docker buildx build "${args[@]}" egress ;;
    caddy) docker buildx build "${args[@]}" caddy ;;
    computer) docker buildx build "${args[@]}" --build-context "upstream=$COMPUTER_UPSTREAM" computer ;;
  esac
}

[ -z "$OUTPUT" ] || { mkdir -p "$OUTPUT"; }
for svc in "${SERVICES[@]}"; do
  say "Building $PREFIX-$svc:$VERSION for $PLATFORM (emulated builds of the computer take long)"
  if [ -n "$OUTPUT" ]; then
    build "$svc" | gzip -c > "$OUTPUT/$svc.tar.gz"
    say "Wrote $OUTPUT/$svc.tar.gz"
  else
    build "$svc" | gzip -c | ssh "$TARGET" 'gzip -dc | docker load'
  fi
done

if [ -n "$TARGET" ]; then
  say "Loaded on $TARGET. There: ./scripts/setup.sh --no-build --mode <mode> (caddy/tunnel: also --public-url https://<domain>)"
else
  say "Copy $OUTPUT to the server, then: for f in $OUTPUT/*.tar.gz; do docker load -i \"\$f\"; done; ./scripts/setup.sh --no-build --mode <mode>"
fi
