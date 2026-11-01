#!/usr/bin/env bash
# OpenDuet: install or update the self-hosted stack (backend, OpenDuet's computer, egress proxy).
#
#   ./scripts/setup.sh                       interactive
#   ./scripts/setup.sh --mode caddy --public-url https://duet.example.com --yes
#
# Writes backend/.env (chmod 600) from backend/.env.example and links it as ./.env for docker
# compose, generates BETTER_AUTH_SECRET and COMPUTER_TOKEN, builds and starts the stack, waits until
# every service is healthy, runs `bun run models:check` and `bun run user:create` in the backend
# container and prints the address to type into the app.
# Safe to re-run: values already in backend/.env are never overwritten (only empty ones are filled)
# and the named volumes (database, files, browser profile, workspace) are kept.
# Exit codes: 0 ok, 1 error, 3 stack is up but models:check failed.
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/setup-network.sh
source "$ROOT/scripts/setup-network.sh"
ENV_FILE="$ROOT/backend/.env"
EXAMPLE="$ROOT/backend/.env.example"

MODE=""; PUBLIC_URL_ARG=""; BIND_ARG=""; PORT_ARG=""
LLM_PROTOCOL_ARG=""; LLM_BASE_URL_ARG=""; LLM_MODEL_ARG=""
OWNER_USERNAME=${DUET_USERNAME:-}; OWNER_NAME=${DUET_NAME:-}
CREATE_USER=1; CHECK_MODELS=1; IMAGES=build; ASSUME_YES=0; WAIT_TIMEOUT=600
COMPUTER_ARG=""; BROWSER_ARG=""; BROWSER_IDLE_ARG=""; BROWSER_SCREEN_ARG=""; COMPUTER=on
NO_COMPUTER_FILE=compose.no-computer.yml
FRESH=0; INTERACTIVE=0; MODE_KEPT=0; MODELS_OK=1; CREATED_USER=""; GENERATED_PASSWORD=""

# Settings taken from the environment when set there (keys, tokens, providers). On a new
# backend/.env they are written; on an existing one they only fill empty values.
PASSTHROUGH=(
  LLM_PROTOCOL LLM_BASE_URL LLM_API_KEY LLM_MODEL LLM_AUTH_HEADER LLM_CAPABILITIES
  MODEL_CHAT MODEL_TASK MODEL_PROACTIVE MODEL_UTILITY LLM_ALLOW_INSECURE_HOSTS
  LLM_ALLOW_PRIVATE_HOSTS ALLOW_FAKE_IP_RANGE VAULT_KEY
  ANTHROPIC_API_KEY OPENROUTER_API_KEY OLLAMA_API_KEY
  COMPOSIO_API_KEY SEARCH_PROVIDER SEARCH_API_KEY SEARXNG_URL
  NOTIFY_PROVIDER APNS_KEY_ID APNS_TEAM_ID APNS_KEY APNS_CERT APNS_CERT_PASSWORD APNS_TOPIC APNS_ENV
  NTFY_URL NTFY_TOPIC NTFY_TOKEN BARK_URL BARK_DEVICE_KEY BARK_ENCRYPTION_KEY BARK_ENCRYPTION_IV
  TUNNEL_TOKEN SERVER_NAME TRUSTED_PROXIES LOG_LEVEL DUET_IMAGE_PREFIX DUET_VERSION
)

say()  { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: scripts/setup.sh [options]

Access (asked interactively; --mode required without a terminal or with --yes):
  --mode lan|tailscale|caddy|tunnel
  --public-url URL        address typed into the app, e.g. https://duet.example.com
  --bind-addr ADDR        lan/tailscale: host address the backend port is published on
  --port N                backend port (default 3000)
Model gateway (asked when backend/.env has no model; the key only via LLM_API_KEY or the prompt):
  --llm-protocol anthropic|openai   --llm-base-url URL   --llm-model ID
Owner account:
  --username U            DUET_USERNAME; --name "Full Name" (DUET_NAME)
                          password: DUET_PASSWORD, the hidden prompt, or generated and printed once
  --no-user               do not create an account
Other:
  --pull                  use prebuilt images (DUET_IMAGE_PREFIX/DUET_VERSION) instead of building
  --no-build              use images already loaded here (scripts/export-images.sh)
  --skip-models-check     do not run `bun run models:check`
  --wait-timeout SECONDS  how long to wait for healthy services (default 600)
OpenDuet's computer (its own browser in a container; asked on a new install, otherwise kept):
  --computer on|off       deploy it or not. off removes its containers and keeps its volumes, so
                          the sites OpenDuet signed in to are still there after --computer on
  --browser headless|headed     browser mode (default headless; headed runs it on a virtual display
                          and the live screen shows the whole Chrome window)
  --browser-screen landscape|portrait  default landscape. Headless: a 1280x800 page or 430x660
                          (phone-like). Headed: a 1280x800 or 860x1600 virtual screen
  --browser-idle MINUTES  close the idle browser after this long (default 30; 0 = never)
  -y, --yes               never prompt (also when stdin is not a terminal)
  -h, --help

Keys and tokens are read from the environment, never from flags (they would show up in `ps`):
  LLM_API_KEY, COMPOSIO_API_KEY, SEARCH_PROVIDER + SEARCH_API_KEY, NOTIFY_PROVIDER + NTFY_*/BARK_*/APNS_*,
  TUNNEL_TOKEN, and the other backend/.env.example names. They only fill empty values.
EOF
}

# ------------------------------------------------------------ backend/.env helpers (no sed -i)

# Value of KEY in backend/.env (last assignment wins), with surrounding quotes removed.
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  KEY="$1" awk -v q="'" '
    BEGIN { k = ENVIRON["KEY"]; v = "" }
    { sub(/\r$/, "") }
    index($0, k "=") == 1 { v = substr($0, length(k) + 2) }
    END {
      n = length(v)
      if (n >= 2 && ((substr(v, 1, 1) == "\"" && substr(v, n, 1) == "\"") || (substr(v, 1, 1) == q && substr(v, n, 1) == q)))
        v = substr(v, 2, n - 2)
      print v
    }' "$ENV_FILE"
}

env_has() { [ -n "$(env_get "$1")" ]; }

# Quote a value for dotenv: bare when safe, single quotes (literal for Bun and compose) otherwise.
env_quote() {
  local v=$1
  case $v in
    *\'*) die "values containing a single quote are not supported; edit backend/.env by hand" ;;
    *[[:space:]\#\$\"\\\`]*) printf "'%s'" "$v" ;;
    *) printf '%s' "$v" ;;
  esac
}

# Set KEY=VALUE in backend/.env, replacing an existing line or appending one. The value travels
# through the environment, never through argv.
env_put() {
  local key=$1 tmp
  local quoted
  quoted=$(env_quote "$2")
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  KEY="$key" VAL="$quoted" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"]; done = 0 }
    { sub(/\r$/, "") }
    index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 }; next }
    { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# Write KEY only when it is empty (or when backend/.env was created by this run).
env_fill() {
  if [ "$FRESH" = 1 ] || ! env_has "$1"; then env_put "$1" "$2"; fi
}

# A value the operator asked for explicitly: filled when empty, otherwise reported, never replaced.
env_want() {
  local key=$1 want=$2 have
  have=$(env_get "$key")
  if [ "$FRESH" = 1 ] || [ -z "$have" ]; then
    env_put "$key" "$want"
  elif [ "$have" != "$want" ]; then
    warn "$key is already set in backend/.env; keeping it (edit backend/.env to change it)"
  fi
}

# ------------------------------------------------------------ prompts

ask() { # ask VAR "Question" [default]
  local __var=$1 __q=$2 __def=${3:-} __ans
  if [ -n "$__def" ]; then read -r -p "$__q [$__def]: " __ans; else read -r -p "$__q: " __ans; fi
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

ask_secret() { # ask_secret VAR "Question"
  local __var=$1 __q=$2 __ans
  read -r -s -p "$__q: " __ans; printf '\n'
  printf -v "$__var" '%s' "$__ans"
}

lan_ip() {
  local addr=""
  if command -v ip >/dev/null 2>&1; then
    addr=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')
  fi
  if [ -z "$addr" ]; then
    addr=$(default_route_addresses | awk '!/:/ {print; exit}')
  fi
  printf '%s' "$addr"
}
version_ge() { # version_ge 2.38.1-desktop.1 2.20.0
  local IFS=. i
  local -a a b
  read -r -a a <<< "${1%%[-+]*}"
  read -r -a b <<< "$2"
  for i in 0 1 2; do
    if (( 10#${a[i]:-0} > 10#${b[i]:-0} )); then return 0; fi
    if (( 10#${a[i]:-0} < 10#${b[i]:-0} )); then return 1; fi
  done
  return 0
}

# ------------------------------------------------------------ steps

check_tools() {
  say "Checking Docker"
  command -v docker >/dev/null 2>&1 \
    || die "Docker is not installed. On Linux: curl -fsSL https://get.docker.com | sh (Docker Engine + compose plugin); on a Mac: Docker Desktop."
  local v
  v=$(docker compose version --short 2>/dev/null) \
    || die "Docker Compose v2 (the 'docker compose' plugin) is missing. Install it: https://docs.docker.com/compose/install/linux/ (or re-run get.docker.com)."
  version_ge "${v#v}" 2.20.0 || die "Docker Compose $v is too old; 2.20 or newer is needed."
  docker info >/dev/null 2>&1 \
    || die "Cannot talk to the Docker daemon. Start it (sudo systemctl start docker) or add your user to the docker group (sudo usermod -aG docker \"\$USER\", then log in again)."
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets."
  note "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'), Compose ${v#v}"

  # The stack restarts after a reboot only if the Docker service itself starts at boot.
  if [ "$(uname -s)" = Linux ] && command -v systemctl >/dev/null 2>&1; then
    if systemctl is-enabled docker >/dev/null 2>&1; then
      :
    elif [ "$(id -u)" = 0 ]; then
      if systemctl enable docker >/dev/null 2>&1; then
        note "Enabled the docker service at boot."
      else
        warn "Could not enable the docker service; run: systemctl enable docker"
      fi
    else
      warn "The docker service is not enabled at boot, so the stack will not come back after a reboot. Run: sudo systemctl enable docker"
    fi
  elif [ "$(uname -s)" = Darwin ]; then
    note "Mac: turn on Docker Desktop > Settings > General > 'Start Docker Desktop when you sign in'. A sleeping Mac pauses briefs and check-ins."
  fi
}

prepare_env() {
  if [ ! -f "$ENV_FILE" ]; then
    [ -f "$EXAMPLE" ] || die "backend/.env.example is missing; run this from a full clone."
    cp "$EXAMPLE" "$ENV_FILE"
    FRESH=1
    say "Created backend/.env from backend/.env.example"
  else
    say "Using the existing backend/.env (only empty values are filled)"
  fi
  chmod 600 "$ENV_FILE"

  # docker compose reads ./.env for ${...} interpolation; it is the same file.
  local link="$ROOT/.env"
  if [ -L "$link" ]; then
    [ "$(readlink "$link")" = "backend/.env" ] || die "./.env is a link to something other than backend/.env; remove it and re-run."
  elif [ -e "$link" ]; then
    die "./.env exists and is not a link to backend/.env. Move its settings into backend/.env, delete it and re-run."
  else
    ln -s backend/.env "$link"
  fi

  local key
  for key in "${PASSTHROUGH[@]}"; do
    if [ -n "${!key:-}" ]; then env_fill "$key" "${!key}"; fi
  done
}

choose_mode() {
  local existing
  existing=$(env_get DUET_MODE)
  if [ -n "$existing" ]; then
    if [ -n "$MODE" ] && [ "$MODE" != "$existing" ]; then
      warn "backend/.env already uses DUET_MODE=$existing; keeping it. To switch, edit DUET_MODE, COMPOSE_FILE and COMPOSE_PROFILES there."
    fi
    MODE=$existing
    MODE_KEPT=1
    return
  fi
  if [ -z "$MODE" ] && [ "$INTERACTIVE" = 1 ]; then
    cat <<'EOF'
How will the iPhone app reach this server?
  1) LAN only           phone on the same network (http://<LAN IP>:PORT)
  2) Tailscale          on the host, with `tailscale serve` (HTTPS on your tailnet)
  3) Domain + Caddy     a public domain pointing here, automatic HTTPS on 80/443
  4) Cloudflare Tunnel  no open ports; needs a tunnel token
EOF
    local pick default=1
    [ "$(route_exposure "$(default_route_addresses)")" != public ] || default=3
    ask pick "Choose 1-4" "$default"
    case $pick in 1|lan) MODE=lan ;; 2|tailscale) MODE=tailscale ;; 3|caddy) MODE=caddy ;; 4|tunnel) MODE=tunnel ;; *) die "unknown choice: $pick" ;; esac
  fi
  MODE=${MODE:-lan}
  case $MODE in lan|tailscale|caddy|tunnel) ;; *) die "--mode must be lan, tailscale, caddy or tunnel" ;; esac
}

# Which compose files and profiles the mode uses. Written when the mode is chosen; a kept mode
# keeps whatever backend/.env already says.
set_compose() { # set_compose FILES PROFILES
  if [ "$MODE_KEPT" = 1 ]; then
    env_fill COMPOSE_FILE "$1"
  else
    env_put COMPOSE_FILE "$1"; env_put COMPOSE_PROFILES "$2"
  fi
}

configure_access() {
  choose_mode
  say "Access mode: $MODE"
  # --port wins on a fresh backend/.env (env_fill would overwrite it with the default there).
  if [ -n "$PORT_ARG" ]; then env_want PORT "$PORT_ARG"; else env_fill PORT 3000; fi
  local port url="$PUBLIC_URL_ARG" bind
  port=$(env_get PORT)

  case $MODE in
    lan)
      bind=$(select_lan_bind "$BIND_ARG" "$(env_get BIND_ADDR)" "$FRESH")
      check_lan_binding "$bind" "$BIND_ARG" "$(route_exposure "$(default_route_addresses)")" "$INTERACTIVE" || die "unsafe LAN binding"
      if [ -z "$url" ]; then
        local ip; ip=$(lan_ip)
        url="http://${ip:-localhost}:$port"
        if [ "$INTERACTIVE" = 1 ] && ! env_has PUBLIC_URL; then ask url "Address the app will use" "$url"; fi
      fi
      set_compose "compose.yml:compose.lan.yml" "" ;;
    tailscale)
      bind=${BIND_ARG:-127.0.0.1}
      if [ -z "$url" ] && command -v tailscale >/dev/null 2>&1; then
        local dns
        dns=$(tailscale status --json 2>/dev/null | awk -F'"' '/"DNSName"/ { print $4; exit }')
        dns=${dns%.}
        [ -z "$dns" ] || url="https://$dns"
      fi
      if [ -z "$url" ] && [ "$INTERACTIVE" = 1 ] && ! env_has PUBLIC_URL; then ask url "Tailnet address (https://<machine>.<tailnet>.ts.net)"; fi
      set_compose "compose.yml:compose.lan.yml" "" ;;
    caddy|tunnel)
      if [ -z "$url" ] && [ "$INTERACTIVE" = 1 ] && ! env_has PUBLIC_URL; then ask url "Public address (https://duet.example.com)"; fi
      set_compose "compose.yml" "$MODE" ;;
  esac
  if [ "$MODE" = caddy ] || [ "$MODE" = tunnel ]; then env_fill TRUSTED_PROXIES "$MODE"; fi

  if [ -n "$url" ]; then
    url=${url%/}
    case $url in http://*|https://*) ;; *) die "the public URL must start with http:// or https://" ;; esac
    if [ "$MODE" = caddy ] || [ "$MODE" = tunnel ]; then
      case $url in https://*) ;; *) die "$MODE mode needs an https:// public URL" ;; esac
    fi
    if [ -n "$PUBLIC_URL_ARG" ]; then env_want PUBLIC_URL "$url"; else env_fill PUBLIC_URL "$url"; fi
  fi
  env_has PUBLIC_URL || die "PUBLIC_URL is empty; pass --public-url https://..."
  if [ -n "${bind:-}" ]; then
    if [ -n "$BIND_ARG" ]; then env_want BIND_ADDR "$bind"; else env_fill BIND_ADDR "$bind"; fi
  fi
  env_put DUET_MODE "$MODE"

  if [ "$MODE" = tunnel ] && ! env_has TUNNEL_TOKEN; then
    local token=""
    [ "$INTERACTIVE" = 0 ] || ask_secret token "Cloudflare Tunnel token"
    [ -n "$token" ] || die "tunnel mode needs TUNNEL_TOKEN (set it in the environment or backend/.env)"
    env_put TUNNEL_TOKEN "$token"
  fi
}

configure_secrets() {
  if ! env_has BETTER_AUTH_SECRET; then
    env_put BETTER_AUTH_SECRET "$(openssl rand -hex 32)"; note "Generated BETTER_AUTH_SECRET"
  fi
  if ! env_has COMPUTER_TOKEN; then
    env_put COMPUTER_TOKEN "$(openssl rand -hex 24)"; note "Generated COMPUTER_TOKEN"
  fi
  env_fill COMPUTER_BOT_ID duet
  # COMPUTER_URL stays as it is: compose sets http://computer:4100 for the backend container, and
  # a host-run `bun run dev` uses http://127.0.0.1:4100 with compose.dev.yml when you set it.
}

configure_models() {
  if env_has LLM_MODEL || env_has MODEL_CHAT || [ -f "$ROOT/backend/models.json" ]; then return; fi
  say "Model gateway"
  local protocol=${LLM_PROTOCOL_ARG:-} base=${LLM_BASE_URL_ARG:-} model=${LLM_MODEL_ARG:-} key=""
  key=$(env_get LLM_API_KEY)
  if [ "$INTERACTIVE" = 1 ]; then
    [ -n "$protocol" ] || ask protocol "Protocol (anthropic or openai)" anthropic
    [ -n "$base" ] || ask base "Base URL (e.g. https://api.anthropic.com or https://api.openai.com/v1)"
    [ -n "$key" ] || ask_secret key "API key"
    [ -n "$model" ] || ask model "Model id, exactly as the gateway names it"
  fi
  if [ -z "$protocol" ] || [ -z "$base" ] || [ -z "$key" ] || [ -z "$model" ]; then
    die "no model is configured: set LLM_PROTOCOL, LLM_BASE_URL, LLM_API_KEY and LLM_MODEL (or create backend/models.json)"
  fi
  case $protocol in anthropic|openai) ;; *) die "the protocol must be anthropic or openai" ;; esac
  env_put LLM_PROTOCOL "$protocol"; env_put LLM_BASE_URL "${base%/}"
  env_put LLM_API_KEY "$key"; env_put LLM_MODEL "$model"
}

configure_optional() {
  [ "$INTERACTIVE" = 1 ] || return 0
  local v=""
  if ! env_has COMPOSIO_API_KEY; then
    ask_secret v "Composio API key for connectors (Enter to skip)"
    [ -z "$v" ] || env_put COMPOSIO_API_KEY "$v"
  fi
  if ! env_has SEARCH_PROVIDER; then
    ask v "Web search: exa, parallel (no key), tavily, brave, serper, searxng (Enter for Exa, then Parallel on failure)" ""
    case $v in
      "") ;;
      exa|parallel) env_put SEARCH_PROVIDER "$v" ;;
      searxng) local u; ask u "SearXNG base URL"; env_put SEARCH_PROVIDER searxng; env_put SEARXNG_URL "$u" ;;
      tavily|brave|serper) local k; ask_secret k "$v API key"; env_put SEARCH_PROVIDER "$v"; env_put SEARCH_API_KEY "$k" ;;
      *) warn "unknown search provider '$v'; skipped" ;;
    esac
  fi
  if ! env_has NOTIFY_PROVIDER; then
    ask v "Push: ntfy, bark, apns (Enter to skip)" ""
    case $v in
      "") ;;
      ntfy) local u t k; ask u "ntfy server" "https://ntfy.sh"; ask t "ntfy topic"; ask_secret k "ntfy access token (Enter for none)"
            env_put NOTIFY_PROVIDER ntfy; env_put NTFY_URL "$u"; env_put NTFY_TOPIC "$t"; [ -z "$k" ] || env_put NTFY_TOKEN "$k" ;;
      bark) local u k; ask u "Bark server" "https://api.day.app"; ask_secret k "Bark device key"
            env_put NOTIFY_PROVIDER bark; env_put BARK_URL "$u"; env_put BARK_DEVICE_KEY "$k" ;;
      apns) note "APNs needs the .p8 key: fill NOTIFY_PROVIDER=apns and the APNS_* values in backend/.env (see docs/DEPLOY.md), then: docker compose up -d" ;;
      *) warn "unknown push provider '$v'; skipped" ;;
    esac
  fi
}

# OpenDuet's computer (M20): deployed or not, its browser's mode and idle time. Not deployed =
# compose.no-computer.yml in COMPOSE_FILE (the computer and egress go behind a profile nobody turns
# on and the backend gets no COMPUTER_URL). A new install asks; an existing one keeps what it has
# unless --computer says otherwise. Volumes are never touched.
configure_computer() {
  local files list=() kept=() f
  files=$(env_get COMPOSE_FILE); files=${files:-compose.yml}
  IFS=: read -r -a list <<< "$files"
  COMPUTER=on
  for f in "${list[@]}"; do [ "$f" != "$NO_COMPUTER_FILE" ] || COMPUTER=off; done
  if [ -n "$COMPUTER_ARG" ]; then
    COMPUTER=$COMPUTER_ARG
  elif [ "$FRESH" = 1 ] && [ "$INTERACTIVE" = 1 ]; then
    cat <<'EOF'
OpenDuet's computer: its own browser in a container, for browsing the web, signing in to sites
and Make builds. About 2.4 GB on disk; about 100 MB while its browser sleeps, up to 2 GB while
browsing. Without it OpenDuet still chats, searches the web (if set up) and uses connected apps.
Change it later with: ./scripts/setup.sh --computer on|off
EOF
    local yn
    ask yn "Deploy OpenDuet's computer? (y/n)" y
    case $yn in [Nn]*) COMPUTER=off ;; *) COMPUTER=on ;; esac
  fi
  for f in "${list[@]}"; do [ "$f" = "$NO_COMPUTER_FILE" ] || kept+=("$f"); done
  [ "$COMPUTER" = on ] || kept+=("$NO_COMPUTER_FILE")
  files=$(IFS=:; printf '%s' "${kept[*]}")
  if [ "$files" != "$(env_get COMPOSE_FILE)" ]; then env_put COMPOSE_FILE "$files"; fi
  if [ -n "$BROWSER_ARG" ]; then env_put COMPUTER_BROWSER_MODE "$BROWSER_ARG"; fi
  if [ -n "$BROWSER_IDLE_ARG" ]; then env_put COMPUTER_BROWSER_IDLE_MS "$((BROWSER_IDLE_ARG * 60000))"; fi
  if [ -n "$BROWSER_SCREEN_ARG" ]; then env_put COMPUTER_BROWSER_SCREEN "$BROWSER_SCREEN_ARG"; fi
  say "OpenDuet's computer: $COMPUTER"
}

# Services behind a disabled profile are left alone by `up`, so a computer that was running before
# --computer off is stopped and removed here (containers only; its volumes stay).
remove_computer() {
  [ "$COMPUTER" = off ] || return 0
  if [ -n "$(docker compose --profile computer ps -a -q computer computer-exec computer-init egress 2>/dev/null)" ]; then
    say "Removing OpenDuet's computer containers (its volumes are kept)"
    docker compose --profile computer rm -s -f computer computer-exec computer-init egress
  fi
}
start_stack() {
  case $IMAGES in
    pull) say "Pulling prebuilt images"; docker compose pull ;;
    none) say "Using the images already on this machine (scripts/export-images.sh)" ;;
    *) say "Building images (the first build downloads Chromium and takes a while)"; docker compose build ;;
  esac
  say "Starting the stack and waiting until every service is healthy"
  if ! docker compose up -d --no-build --wait --wait-timeout "$WAIT_TIMEOUT"; then
    docker compose ps || true
    die "the stack did not become healthy. See: docker compose logs --tail 100 backend computer computer-exec egress"
  fi
  docker compose ps
}

check_models() {
  [ "$CHECK_MODELS" = 1 ] || { note "Skipped models:check"; return 0; }
  say "Checking the model gateway (bun run models:check)"
  if ! docker compose exec -T backend bun run models:check; then
    MODELS_OK=0
    warn "models:check failed. Fix LLM_* / MODEL_* (or models.json) in backend/.env, then: docker compose up -d && docker compose exec backend bun run models:check"
  fi
}

user_count() {
  docker compose exec -T backend sqlite3 -readonly /data/db/duet.db 'SELECT COUNT(*) FROM "User";' 2>/dev/null | tr -d '[:space:]'
}

create_owner() {
  [ "$CREATE_USER" = 1 ] || return 0
  local count
  count=$(user_count || true)
  if [ -z "$OWNER_USERNAME" ] && [ "${count:-0}" != 0 ]; then
    note "An account already exists; not creating another (docker compose exec backend bun run user:create --username <u> --name \"<Full Name>\")."
    return 0
  fi
  if [ -z "$OWNER_USERNAME" ]; then
    if [ "$INTERACTIVE" = 0 ]; then
      warn "No account yet. Create one: docker compose exec backend bun run user:create --username <u> --name \"<Full Name>\""
      return 0
    fi
    say "Owner account"
    ask OWNER_USERNAME "Username (letters, numbers, _ and .)"
  fi
  if [ -z "$OWNER_NAME" ]; then
    if [ "$INTERACTIVE" = 1 ]; then ask OWNER_NAME "Full name" "$OWNER_USERNAME"; else OWNER_NAME=$OWNER_USERNAME; fi
  fi

  local generate=0 choice
  if [ -z "${DUET_PASSWORD:-}" ] && [ "$INTERACTIVE" = 1 ]; then
    if [ "$MODE" = caddy ] || [ "$MODE" = tunnel ] || [ "$(route_exposure "$(default_route_addresses)")" = public ]; then
      note "On a VPS, use a generated password (at least 12 characters; common passwords are refused)."
      ask choice "Generate a random password and show it once? (y/n)" y
      case $choice in [Nn]*) ;; *) generate=1 ;; esac
    fi
  fi
  local out status=0
  if [ -n "${DUET_PASSWORD:-}" ]; then
    out=$(printf '%s\n' "$DUET_PASSWORD" | docker compose exec -T backend bun run user:create \
      --username "$OWNER_USERNAME" --name "$OWNER_NAME" --password-stdin 2>&1) || status=$?
  elif [ "$INTERACTIVE" = 1 ] && [ "$generate" = 0 ]; then
    # Hidden prompt inside the container; the password never passes through this script.
    docker compose exec backend bun run user:create --username "$OWNER_USERNAME" --name "$OWNER_NAME" || status=$?
    out=""
  else
    GENERATED_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-20)
    out=$(printf '%s\n' "$GENERATED_PASSWORD" | docker compose exec -T backend bun run user:create \
      --username "$OWNER_USERNAME" --name "$OWNER_NAME" --password-stdin 2>&1) || status=$?
  fi
  if [ "$status" = 0 ]; then
    CREATED_USER=$OWNER_USERNAME
    [ -z "$out" ] || printf '%s\n' "$out" | grep -v '^\$ ' || true
  elif printf '%s' "$out" | grep -q 'already exists'; then
    GENERATED_PASSWORD=""
    note "User \"$OWNER_USERNAME\" already exists; left unchanged (change its password: docker compose exec backend bun run user:password --username $OWNER_USERNAME)."
  else
    GENERATED_PASSWORD=""
    [ -z "$out" ] || printf '%s\n' "$out" >&2
    die "creating the account failed"
  fi
}

print_summary() {
  local url port bind
  url=$(env_get PUBLIC_URL); port=$(env_get PORT); bind=$(env_get BIND_ADDR)
  printf '\n'
  say "OpenDuet is running."
  note "Server address for the app: $url"
  case $MODE in
    lan)
      if [ -z "$bind" ] || [ "$bind" = 127.0.0.1 ] || [ "$bind" = localhost ]; then
        warn "BIND_ADDR=${bind:-127.0.0.1} publishes the backend on this machine only; a phone can't reach it. Set BIND_ADDR=0.0.0.0 in backend/.env, then: docker compose up -d"
      fi
      case $url in
        *://localhost*|*://127.*) warn "PUBLIC_URL points at this machine; use http://<LAN IP>:$port (this host: $(lan_ip || true)) in backend/.env and in the app." ;;
      esac
      note "Open port $port in the host firewall for your LAN only. Docker-published ports bypass ufw/firewalld." ;;
    tailscale)
      note "On the host, once: tailscale serve --bg $port   (the app then uses $url)" ;;
    caddy)
      note "Point the DNS record of ${url#https://} at this server and allow ports 80 and 443; Caddy fetches the certificate." ;;
    tunnel)
      note "In the Cloudflare dashboard, route the tunnel's public hostname to http://backend:$port" ;;
  esac
  if [ -n "$CREATED_USER" ]; then
    note "Sign in as: $CREATED_USER"
    [ -z "$GENERATED_PASSWORD" ] || note "Generated password (shown once, write it down): $GENERATED_PASSWORD"
  fi
  if [ "$COMPUTER" = off ]; then
    note "OpenDuet's computer isn't deployed. Add it any time: ./scripts/setup.sh --computer on"
  else
    local browser; browser=$(env_get COMPUTER_BROWSER_MODE)
    note "OpenDuet's computer: ${browser:-headless} browser. Remove it: ./scripts/setup.sh --computer off"
  fi
  note "Logs: docker compose logs -f backend    Update: git pull && docker compose up -d --build"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --mode|--public-url|--bind-addr|--port|--llm-protocol|--llm-base-url|--llm-model|--username|--name|--wait-timeout|--computer|--browser|--browser-idle|--browser-screen)
        [ $# -ge 2 ] || die "$1 needs a value" ;;
    esac
    case $1 in
      --mode) MODE=$2; shift ;;
      --public-url) PUBLIC_URL_ARG=$2; shift ;;
      --bind-addr) BIND_ARG=$2; shift ;;
      --port) PORT_ARG=$2; shift ;;
      --llm-protocol) LLM_PROTOCOL_ARG=$2; shift ;;
      --llm-base-url) LLM_BASE_URL_ARG=$2; shift ;;
      --llm-model) LLM_MODEL_ARG=$2; shift ;;
      --username) OWNER_USERNAME=$2; shift ;;
      --name) OWNER_NAME=$2; shift ;;
      --wait-timeout) WAIT_TIMEOUT=$2; shift ;;
      --computer)
        case $2 in on|off) COMPUTER_ARG=$2 ;; *) die "--computer must be on or off" ;; esac; shift ;;
      --browser)
        case $2 in headless|headed) BROWSER_ARG=$2 ;; *) die "--browser must be headless or headed" ;; esac; shift ;;
      --browser-idle)
        case $2 in ''|*[!0-9]*) die "--browser-idle takes whole minutes (0 = never)" ;; *) BROWSER_IDLE_ARG=$((10#$2)) ;; esac; shift ;;
      --browser-screen)
        case $2 in portrait|landscape) BROWSER_SCREEN_ARG=$2 ;; *) die "--browser-screen must be portrait or landscape" ;; esac; shift ;;
      --no-user) CREATE_USER=0 ;;
      --pull) IMAGES=pull ;;
      --no-build) IMAGES=none ;;
      --skip-models-check) CHECK_MODELS=0 ;;
      -y|--yes) ASSUME_YES=1 ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
    shift
  done
}

main() {
  parse_args "$@"
  if [ -t 0 ] && [ "$ASSUME_YES" = 0 ]; then INTERACTIVE=1; fi
  require_explicit_mode "$INTERACTIVE" "$MODE" || exit 1
  cd "$ROOT"
  check_tools
  prepare_env
  configure_access
  configure_secrets
  configure_models
  configure_optional
  configure_computer
  start_stack
  remove_computer
  check_models
  create_owner
  print_summary
  [ "$MODELS_OK" = 1 ] || exit 3
}

main "$@"
