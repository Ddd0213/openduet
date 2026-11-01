#!/bin/sh
# Container entry point: apply pending Prisma migrations, then run the command (default: the API).
# The environment comes from compose (backend/.env plus the container paths in compose.yml).
set -eu

if [ "${1:-}" = "bun" ] && [ "${2:-}" = "src/index.ts" ]; then
  if ! out=$(bunx --bun prisma migrate deploy 2>&1); then
    printf '%s\n' "$out" >&2
    printf '{"level":"error","msg":"database migrations failed"}\n' >&2
    exit 1
  fi
  printf '{"level":"info","msg":"database migrations applied"}\n'
fi

exec "$@"
