#!/usr/bin/env bash
# Back up a running OpenDuet stack into backups/<UTC timestamp>/ (or the directory given):
#   duet.db, search.db      consistent SQLite snapshots (sqlite3 .backup) taken inside the backend
#   vault.key               the vault key (/data/db/vault.key) when the server made one: without it
#                           the stored connector keys can't be read (VAULT_KEY in .env needs none)
#   backend-data.tar.gz     channel files, uploads and artifacts (/data/files, /data/artifacts)
#   computer-data.tar.gz    OpenDuet's browser profile and workspace (/profiles, /workspace); the
#                           computer is stopped for a few seconds so Chromium's files are consistent
#   SHA256SUMS, MANIFEST
# backend/.env is not included (it holds your keys): keep a copy of it somewhere safe yourself.
# The backups hold your chats and OpenDuet's logins; the directory is created with mode 700.
#   ./scripts/backup.sh [DIR]          restore with ./scripts/restore.sh DIR --yes
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Compose exec/cp can select a one-off run container. Pin the running service's first replica.
service_id() {
  local ids id labels
  ids=$(docker compose ps --status running -q "$1") || return 1
  for id in $ids; do
    labels=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.oneoff"}} {{index .Config.Labels "com.docker.compose.container-number"}} {{.State.Running}}' "$id") || return 1
    case $labels in 'False 1 true'|'false 1 true') printf '%s\n' "$id"; return 0 ;; esac
  done
  die "service $1 replica 1 is not running (docker compose up -d --wait)"
}

case ${1:-} in -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
[ -f backend/.env ] && [ -L .env ] || die "run ./scripts/setup.sh first"
BACKEND=$(service_id backend) || die "could not find the running backend service container"

OUT=${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}
[ ! -e "$OUT" ] || [ -z "$(ls -A "$OUT" 2>/dev/null)" ] || die "$OUT already exists and is not empty"
mkdir -p "$OUT"
chmod 700 "$OUT"

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# Untar exit 1 means "a file changed while it was read", which is fine for live uploads.
tar_ok() { local rc=$1; [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]; }

snapshot() { # snapshot NAME: /data/db/NAME -> $OUT/NAME
  local name=$1 tmp=".backup-$1-$$"
  if ! docker exec "$BACKEND" test -f "/data/db/$name"; then
    say "No $name yet; skipped"
    return 0
  fi
  say "Snapshot of $name"
  docker exec "$BACKEND" sqlite3 "/data/db/$name" ".backup '/data/db/$tmp'"
  local check
  check=$(docker exec "$BACKEND" sqlite3 -readonly "/data/db/$tmp" 'PRAGMA integrity_check;' | tr -d '\r')
  if [ "$check" != ok ]; then
    docker exec "$BACKEND" rm -f "/data/db/$tmp" "/data/db/$tmp-wal" "/data/db/$tmp-shm" || true
    die "integrity check of the $name snapshot failed: $check"
  fi
  docker cp "$BACKEND:/data/db/$tmp" "$OUT/$name" >/dev/null 2>&1 || die "copying the $name snapshot failed"
  docker exec "$BACKEND" rm -f "/data/db/$tmp" "/data/db/$tmp-wal" "/data/db/$tmp-shm"
}

snapshot duet.db
snapshot search.db

# The vault key goes with the database it unlocks (the backup directory is mode 700, files 600).
if docker exec "$BACKEND" test -f /data/db/vault.key; then
  say "Vault key"
  docker cp "$BACKEND:/data/db/vault.key" "$OUT/vault.key" >/dev/null 2>&1 || die "copying the vault key failed"
else
  say "No vault.key (VAULT_KEY is set in backend/.env, or no secret was stored yet); skipped"
fi

say "Backend files and artifacts"
rc=0
docker exec "$BACKEND" tar -C /data -czf - files artifacts > "$OUT/backend-data.tar.gz" || rc=$?
tar_ok "$rc" || die "archiving the backend files failed"

say "OpenDuet's computer: browser profile and workspace (the computer pauses briefly)"
# M28: computer-exec too, where computer_exec's commands write to /workspace (when compose lists it).
paused=(computer)
# Read the list first: `compose config | grep -q` under pipefail fails now and then (grep exits on
# the match, compose gets EPIPE and exits 255), which left computer-exec running during the archive.
listed=$(docker compose config --services 2>/dev/null || true)
if grep -qx computer-exec <<<"$listed"; then paused+=(computer-exec); fi
docker compose stop "${paused[@]}" >/dev/null
rc=0
docker compose run --rm --no-deps -T --entrypoint tar computer -C / -czf - profiles workspace > "$OUT/computer-data.tar.gz" || rc=$?
docker compose up -d --no-build --wait "${paused[@]}" backend >/dev/null || printf 'warning: the computer did not come back healthy; run: docker compose up -d --wait\n' >&2
tar_ok "$rc" || die "archiving the computer volumes failed"

{
  printf 'created=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'commit=%s\n' "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  printf 'project=%s\n' "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$BACKEND")"
} > "$OUT/MANIFEST"
(cd "$OUT" && sha256 ./* > SHA256SUMS.tmp && grep -v 'SHA256SUMS' SHA256SUMS.tmp > SHA256SUMS && rm -f SHA256SUMS.tmp)
chmod 600 "$OUT"/*

say "Backup written to $OUT"
ls -l "$OUT"
printf 'Not included: backend/.env (your keys and secrets). Keep a copy of it with this backup, safely.\n'
