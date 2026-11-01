#!/usr/bin/env bash
# Put a backup made by scripts/backup.sh back into this stack's named volumes:
#   ./scripts/restore.sh backups/<timestamp> --yes
# Replaces the database, the vault key, files, artifacts, OpenDuet's browser profile and workspace with
# the backup's copies (everything written since that backup is lost), then starts the stack again.
# backend/.env is left alone; restore it yourself if you also lost it (sessions need the same
# BETTER_AUTH_SECRET, and a VAULT_KEY set there must be the same one).
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

DIR=""; YES=0
for arg in "$@"; do
  case $arg in
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $arg" ;;
    *) DIR=$arg ;;
  esac
done
[ -n "$DIR" ] || die "usage: scripts/restore.sh <backup dir> --yes"
[ -f "$DIR/duet.db" ] || die "$DIR/duet.db not found; is this a backup made by scripts/backup.sh?"
[ -f backend/.env ] && [ -L .env ] || die "run ./scripts/setup.sh first (backend/.env and the ./.env link)"
[ "$YES" = 1 ] || die "this replaces the current data with $DIR; add --yes to confirm"

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
if [ -f "$DIR/SHA256SUMS" ]; then
  say "Verifying checksums"
  (cd "$DIR" && sha256 -c SHA256SUMS >/dev/null) || die "checksum mismatch in $DIR"
fi

say "Stopping the backend and the computer"
docker compose stop backend computer >/dev/null
# M28: computer_exec's commands run here and write to /workspace (absent from an older compose.yml).
docker compose stop computer-exec >/dev/null 2>&1 || true

# One-off containers on the same named volumes, as the images' own users (no bind mounts).
backend_run() { docker compose run --rm --no-deps -T --entrypoint sh backend -c "$1"; }

say "Database"
backend_run 'cat > /data/db/.restore.db && sqlite3 -readonly /data/db/.restore.db "PRAGMA integrity_check;" | grep -qx ok \
  && rm -f /data/db/.restore.db-wal /data/db/.restore.db-shm /data/db/duet.db-wal /data/db/duet.db-shm /data/db/duet.db-journal \
  && mv /data/db/.restore.db /data/db/duet.db' < "$DIR/duet.db" || die "restoring duet.db failed"
if [ -f "$DIR/search.db" ]; then
  backend_run 'cat > /data/db/.restore-search.db && rm -f /data/db/search.db-wal /data/db/search.db-shm \
    && mv /data/db/.restore-search.db /data/db/search.db' < "$DIR/search.db" || die "restoring search.db failed"
else
  # The search index is rebuilt from the database when it is missing.
  backend_run 'rm -f /data/db/search.db /data/db/search.db-wal /data/db/search.db-shm'
fi

if [ -f "$DIR/vault.key" ]; then
  # The key the restored database's secrets were sealed with (mode 600, the backend's own user).
  say "Vault key"
  backend_run 'umask 077 && cat > /data/db/.restore-vault.key && test -s /data/db/.restore-vault.key \
    && chmod 600 /data/db/.restore-vault.key && mv /data/db/.restore-vault.key /data/db/vault.key' < "$DIR/vault.key" \
    || die "restoring the vault key failed"
else
  # A vault.key already there is kept: the backup's secrets may need it, or VAULT_KEY in backend/.env.
  say "No vault.key in the backup; the server's own key (or VAULT_KEY) is kept"
fi

if [ -f "$DIR/backend-data.tar.gz" ]; then
  say "Backend files and artifacts"
  backend_run 'find /data/files /data/artifacts -mindepth 1 -delete && tar -C /data -xzf -' < "$DIR/backend-data.tar.gz" \
    || die "restoring the backend files failed"
fi

if [ -f "$DIR/computer-data.tar.gz" ]; then
  say "OpenDuet's computer: browser profile and workspace"
  docker compose run --rm --no-deps -T --entrypoint sh computer -c \
    'find /profiles /workspace -mindepth 1 -delete && tar -C / --no-same-owner -xzf -' < "$DIR/computer-data.tar.gz" \
    || die "restoring the computer volumes failed"
fi

say "Starting the stack"
docker compose up -d --no-build --wait
docker compose ps
say "Restored from $DIR"
