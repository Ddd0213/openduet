# OpenDuet's computer: CopilotKit/OpenBot's agent-computer (MIT) at a pinned commit, plus our
# patches (computer/patches/, applied in order) and the tools the shell in /workspace offers.
#
# Upstream arrives as the named build context `upstream` (the OpenBot repository at commit
# da9a3caf5784074baa779110dd7e9d1338c8871b); compose passes it as a git URL. A local build:
#   docker build --build-context upstream=<OpenBot checkout at da9a3ca> \
#     -t openduet-computer:local -f computer/Dockerfile computer/
#
# The stages below mirror upstream's agent-computer/Dockerfile at that commit (same base images,
# same Playwright version; bump both or neither) and add, as separate programs: xvfb, ffmpeg,
# xdotool, xclip (the whole-window live screen and input, patches 0002-0004), git and python3
# (interpreter only), the Node package unpdf for reading PDFs from the shell, and OfficeCLI
# (iOfficeAI/OfficeCLI, Apache-2.0) built from source for Word / Excel / PowerPoint files.
#
# Base images are pinned by digest (the multi-arch index, so amd64 and arm64 both resolve). A digest
# never moves, so security fixes in Ubuntu, Node and Chromium arrive only when someone bumps these
# and rebuilds: see docs/DEPLOY.md "Updating" (rebuild monthly, and when Chrome ships a security release).
FROM node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS node-toolchain
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS bun-toolchain

# OfficeCLI v1.0.159 from source, on the build machine's own platform (a .NET publish targets any
# RID, so an amd64 image built on arm64 is not compiled under emulation). Its skill texts are
# compiled into the binary (officecli.csproj embeds skills/**); eight of them carry text taken from
# Anthropic's proprietary skills, so they are deleted before the build and are not in the binary.
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0@sha256:de4fe90a98845d75910b9769662465c84de1a934665c431279d1382b2bddc02b AS officecli
ARG TARGETARCH
# The commit tagged v1.0.159.
ARG OFFICECLI_COMMIT=5e625bf58aca732335590d7aa271f6337535a7ef
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
WORKDIR /src
RUN git init -q . && git remote add origin https://github.com/iOfficeAI/OfficeCLI.git \
  && git fetch -q --depth 1 origin "$OFFICECLI_COMMIT" && git checkout -q FETCH_HEAD \
  && rm -rf skills/officecli-pptx skills/officecli-xlsx skills/officecli-docx skills/morph-ppt-3d \
            skills/officecli-academic-paper skills/officecli-data-dashboard \
            skills/officecli-financial-model skills/officecli-pitch-deck \
  && case "$TARGETARCH" in amd64) rid=linux-x64 ;; arm64) rid=linux-arm64 ;; \
       *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;; esac \
  && dotnet publish src/officecli/officecli.csproj -c Release -r "$rid" -o /out --nologo \
  && cp LICENSE /out/LICENSE && cp NOTICE /out/NOTICE && cp THIRD-PARTY-NOTICES.txt /out/THIRD-PARTY-NOTICES.txt

FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

ARG PLAYWRIGHT_VERSION=1.62.1
ENV BUN_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"
ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# apt over HTTPS with retries: some networks (a proxy that cuts long plain-HTTP downloads) break
# the default mirrors; HTTPS works everywhere the plain ones do.
RUN printf 'Acquire::Retries "20";\n' > /etc/apt/apt.conf.d/80-retries \
 && apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && sed -i "s|http://ports.ubuntu.com|https://ports.ubuntu.com|g; s|http://archive.ubuntu.com|https://archive.ubuntu.com|g; s|http://security.ubuntu.com|https://security.ubuntu.com|g" /etc/apt/sources.list.d/ubuntu.sources \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node-toolchain /usr/local /usr/local
COPY --from=bun-toolchain /usr/local/bin/bun /usr/local/bin/bun

# As upstream: only the Chromium build Playwright launches (`--no-shell`), with its system deps.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils \
  && ln -s bun /usr/local/bin/bunx \
  && bunx --bun "playwright@${PLAYWRIGHT_VERSION}" install --with-deps --no-shell chromium \
  && rm -rf /root/.cache /root/.bun /usr/local/install/cache /tmp/* /var/lib/apt/lists/*

# Ours. The live screen (ffmpeg x11grab), input (xdotool, xclip) and the X server itself (xvfb,
# named even if Playwright's deps already brought it); git and a bare python3 for the shell;
# `patch` applies computer/patches. All run as their own processes; nothing links into our code.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb ffmpeg xdotool xclip git python3 patch \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# The lockfile as well as the manifest, so `--frozen-lockfile` means something (upstream's note).
COPY --from=upstream agent-computer/package.json agent-computer/bun.lock ./
RUN bun install --frozen-lockfile

COPY --from=upstream agent-computer/src ./src
COPY --from=upstream agent-computer/tests ./tests
# index.ts imports ../../shared/file-download at runtime; the one file it needs, where that resolves.
COPY --from=upstream shared/file-download.ts /shared/file-download.ts

# Our patches, in file-name order. --forward refuses a patch that is already applied, and any hunk
# that does not apply exactly fails the build rather than leaving a .rej behind.
COPY patches /tmp/patches
RUN set -e; for p in /tmp/patches/*.patch; do \
      echo "applying $p"; patch -p1 --forward --fuzz=0 --no-backup-if-mismatch < "$p"; \
    done; \
    if find /app -name '*.rej' -o -name '*.orig' | grep -q .; then echo "patch left rejects" >&2; exit 1; fi; \
    rm -rf /tmp/patches

# Node packages the shell may use (`import { extractText } from "unpdf"` from any directory):
# installed from our own lockfile into /opt/shell-node and linked as /node_modules, which every
# path's module resolution reaches last.
COPY js/package.json js/bun.lock /opt/shell-node/
RUN cd /opt/shell-node && bun install --frozen-lockfile --production \
  && ln -s /opt/shell-node/node_modules /node_modules \
  && rm -rf /root/.bun /usr/local/install/cache

# OfficeCLI as a plain program. Off: its 24-hourly self-update (which replaces the running binary
# and rewrites installed officecli skills), installing itself when run bare, and the resident
# background process. No officecli skill is placed in any agent skill directory.
COPY --from=officecli /out/officecli /usr/local/bin/officecli
COPY --from=officecli /out/LICENSE /out/NOTICE /out/THIRD-PARTY-NOTICES.txt /usr/local/share/doc/officecli/
ENV OFFICECLI_SKIP_UPDATE=1 OFFICECLI_NO_AUTO_INSTALL=1 OFFICECLI_NO_AUTO_RESIDENT=1

# Durable working directory. Bot-produced files that must survive replacement live here.
ENV WORKSPACE_DIR=/workspace

# M28: the computer runs as its own user, uid/gid 10003 (backend 10001, egress 10002), not root.
# The two volumes' mountpoints belong to it, so a new named volume starts out owned by it (Docker
# copies the mountpoint's owner and mode into an empty volume). Volumes made by an older image are
# root's: compose.yml's computer-init service hands them over once. HOME is a tmpfs in compose
# (Chromium's fontconfig and NSS caches); commands from computer_exec get HOME=/workspace instead.
RUN groupadd --gid 10003 computer \
  && useradd --uid 10003 --gid 10003 --home-dir /home/computer --shell /usr/sbin/nologin computer \
  && install -d -o 10003 -g 10003 -m 700 /home/computer /profiles \
  && install -d -o 10003 -g 10003 -m 755 /workspace
ENV HOME=/home/computer

ENV PORT=4100
EXPOSE 4100
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD bun -e "const r = await fetch('http://localhost:4100/health'); process.exit(r.ok ? 0 : 1)"

USER 10003:10003
CMD ["bun", "src/index.ts"]
