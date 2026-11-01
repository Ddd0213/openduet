# OpenDuet backend: Bun + Hono + Prisma (SQLite in WAL mode).
# Multi-stage: dependencies and the Prisma client are prepared in `deps`, dev-only packages are
# pruned in `prune`, and the runtime runs as the fixed non-root UID 10001, which owns the volume
# directories so new named volumes inherit that ownership.
ARG BUN_IMAGE=oven/bun:1.3.6-slim@sha256:9d20d1b535596c4a021ba2087d2d303c4098e96be15f47775729cf7a259bb41e

FROM ${BUN_IMAGE} AS base
# openssl: Prisma's engines detect libssl at generate time and at run time.
# sqlite3: scripts/backup.sh takes `.backup` snapshots inside this container.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates sqlite3 \
  && rm -rf /var/lib/apt/lists/*
ENV CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY prisma ./prisma
RUN bunx --bun prisma generate

FROM deps AS prune
# Dev-only packages the runtime never loads. The Prisma CLI stays: migrations run on start.
RUN rm -rf node_modules/typescript node_modules/@typescript node_modules/@types \
    node_modules/.cache

FROM base AS runtime
ARG APP_UID=10001
ARG APP_GID=10001
RUN groupadd --system --gid "${APP_GID}" duet \
  && useradd --system --uid "${APP_UID}" --gid duet --home-dir /nonexistent --shell /usr/sbin/nologin duet \
  && mkdir -p /data/db /data/files /data/artifacts \
  && chown -R "${APP_UID}:${APP_GID}" /data \
  && chmod 700 /data/db /data/files /data/artifacts
ENV NODE_ENV=production \
    DATABASE_URL=file:/data/db/duet.db \
    FILES_DIR=/data/files \
    PORT=3000
COPY --from=prune /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json bunfig.toml ./
COPY prisma ./prisma
COPY src ./src
COPY skills-builtin ./skills-builtin
# models.json is optional (the LLM_* shortcut works without it); the glob keeps COPY from failing
# when it is absent. It names key variables, never keys.
COPY package.json models.jso[n] ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh
USER ${APP_UID}:${APP_GID}
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "src/index.ts"]
