# Deploying and running OpenDuet

The full deployment guide: every setup.sh option, the services and their network isolation, remote access, hardening a public server, mainland China networks, running on a Mac, app signing and push, configuration, updates, backups and troubleshooting. For what OpenDuet is and the shortest path to a running server, see the [README](../README.md).

中文说明：[DEPLOY.zh-CN.md](DEPLOY.zh-CN.md)

## Setup (setup.sh)

Needs Docker Engine with the compose plugin (v2.20+), git and openssl. On a fresh Linux server: `curl -fsSL https://get.docker.com | sh`, then `sudo systemctl enable --now docker`.

```sh
git clone https://github.com/Ddd0213/openduet.git && cd openduet
./scripts/setup.sh
```

setup.sh checks Docker, asks how the phone will reach the server, asks for the model gateway (protocol, base URL, key, model id) and optionally Composio, web search and push, whether to deploy OpenDuet's computer, writes `backend/.env` (chmod 600) with a generated `BETTER_AUTH_SECRET` and `COMPUTER_TOKEN`, builds and starts the stack, waits until every service is healthy, runs `bun run models:check`, creates your account and prints the address to type into the app. Re-running it is safe: values already in `backend/.env` and the data volumes are kept.

Non-interactive (servers, CI): keys come from the environment, never from flags.

```sh
read -rs LLM_API_KEY && export LLM_API_KEY      # type the key, it isn't echoed
LLM_PROTOCOL=anthropic LLM_BASE_URL=https://api.anthropic.com LLM_MODEL=<model id> \
  ./scripts/setup.sh --mode caddy --public-url https://duet.example.com --yes --username me --name "Your Name"
```

Without `DUET_PASSWORD` a password is generated and printed once. `./scripts/setup.sh --help` lists every option.
Newly set CLI passwords must have at least 12 characters and not be on the built-in common-password list; existing passwords still sign in. Public-server interactive setup recommends a generated password.
Without a terminal or with `--yes`, `--mode lan|tailscale|caddy|tunnel` is required, even on updates. On a public default route the interactive default is Caddy; LAN binding to `0.0.0.0` is refused unless `--bind-addr` is explicit. If detection fails, interactive setup asks for confirmation; non-interactive setup requires an explicit bind address.

## Sizing

Minimum 2 vCPU, 4 GB RAM, 40 GB disk. Chromium is the heavy part: the computer is limited to 2 GB of memory, the backend to 1 GB. The images take about 4 GB.

## What runs

| Service | What it is | Published | Data (named volumes) |
|---|---|---|---|
| backend | API, agent, scheduler; non-root UID 10001, read-only root fs, applies migrations on start | LAN/Tailscale mode only: `${BIND_ADDR}:${PORT}` | `backend-db` (SQLite WAL + search index), `backend-files`, `backend-artifacts` |
| computer | OpenDuet's computer: CopilotKit/OpenBot agent-computer pinned to `da9a3ca` with our patches (`computer/`), Chromium (headless or headed); optional | never | `computer-profiles` (OpenDuet's logins), `computer-workspace` |
| computer-exec | OpenDuet's shell (`computer_exec`) with git, python3 and OfficeCLI: the computer's image, but only `/workspace`; no logins, no token, no display. Deployed with the computer | never | `computer-workspace`, `exec-socket` |
| egress | Stripe smokescreen v0.1.0, the only way out for the computer | never | none |
| caddy | optional: automatic HTTPS for `PUBLIC_URL` | 80, 443 | `caddy-data`, `caddy-config` |
| tunnel | optional: Cloudflare Tunnel (cloudflared) | nothing | none |

The egress proxy permits only destination ports **80 and 443**, for HTTP and CONNECT. Browsing, HTTPS git and package registries on those ports work; git over SSH, SMTP, alternate-port registries and arbitrary TCP tunnels are blocked. This reduces abuse, not prompt-injection exfiltration to public web hosts.
The computer sits on an internal network with no route out; its peers are the backend and egress. Egress refuses private, loopback and link-local addresses (including the cloud metadata address 169.254.169.254), CGNAT 100.64.0.0/10, IPv6 ULA and link-local. The computer runs with `cap_drop: ALL`, `no-new-privileges`, memory and pids limits and no Docker socket, and it receives only `COMPUTER_TOKEN`, `COMPUTER_BOT_ID` and its proxy settings: no model, Composio, search or push keys. computer-exec, where OpenDuet's shell runs, has the same limits and gets only the proxy settings, not `COMPUTER_TOKEN`. `./scripts/smoke.sh` checks all of this. The computer (its browser, the sites OpenDuet is signed in to, /workspace) belongs to one account: `COMPUTER_OWNER` in backend/.env, or the first account you created. Other accounts on the same server get no computer.

## OpenDuet's computer (optional)

OpenDuet's computer is what it uses to browse the web, sign in to sites and build Make pages. It is about 2.4 GB on disk (about 600 MB to download); its browser uses about 100 MB while it sleeps and up to 2 GB while browsing. Without it OpenDuet still chats, searches the web, uses connected apps and remembers things; the app shows the computer as not set up, with the command that adds it.

- A new install asks whether to deploy it. Change it any time: `./scripts/setup.sh --computer off` or `--computer on`. Off adds `compose.no-computer.yml` to `COMPOSE_FILE` in `backend/.env` and removes the computer, computer-exec and egress containers; their volumes stay, so the sites OpenDuet signed in to are still there when you turn it back on.
- `--browser headless|headed` (default headless). Headless shows the page alone, 1280×800 and landscape, and the app draws its own tab strip and address bar above it (`--browser-screen portrait` for a 430 CSS px wide page like a phone's). Headed runs Chromium on a virtual display (Xvfb) inside the container, and the live screen and Take over then show the whole Chrome window (its tab strip, address bar and pointer), 1280×800 (`--browser-screen portrait` for an upright 860×1600 window). It uses about 200 MB more while you watch. In our tests sites behind Cloudflare challenged the headed browser much more often (2 of 16 loads got through, against 8 of 8 headless), so headless stays the default.
- OpenDuet's shell has git, python3 and OfficeCLI (Word, Excel and PowerPoint files). Since M28 the computer and its shell run as their own user (uid 10003) on a read-only image, so `apt-get install` no longer works there; OpenDuet can still install Node packages into `/workspace` (`bun add`, `npm install`).
- Since M28 the shell's commands run in a container of their own, `computer-exec`: the same image and user, but it mounts only `/workspace`, so a command can't read the browser profiles (the sites OpenDuet is signed in to), `COMPUTER_TOKEN` or the browser's display. The computer hands each command over a unix socket on the `exec-socket` volume; the timeout and Stop work as before. If computer-exec isn't running, commands fail with "The command runner is not reachable" and never run in the computer instead (`docker compose logs computer-exec`). It uses about 9 MB while idle (limits: 1 GB, 512 processes).
- Chromium runs with its own sandbox. That needs `computer/seccomp-chrome.json` (Docker's default seccomp profile plus user, pid and net namespaces and `chroot`); no capability is added. On a host whose kernel refuses unprivileged user namespaces the browser won't start: check `docker compose logs computer`, and only then set `COMPUTER_SANDBOX=off` in `backend/.env`.
- Volumes from before M28 belong to root. The `computer-init` service hands them to uid 10003 before every start of the computer and computer-exec (it does nothing once they are). It runs with `docker compose up`; with `--no-deps`, name all three: `docker compose up -d --no-deps --force-recreate computer-init computer computer-exec`.
- `--browser-idle <minutes>` (default 30, 0 = never): the browser closes after this long without use, the container stays. Shorter saves memory; an open page is lost sooner. Sign-ins are kept in the profile either way, including sites that only use session cookies.
- The app wakes it when you open OpenDuet's computer, OpenDuet wakes it when it needs the browser, and "Let it sleep" in the full-screen view closes the browser at once.

## Remote access

- **LAN only** (`--mode lan`): set `BIND_ADDR=0.0.0.0` and `PUBLIC_URL=http://<LAN IP>:3000`. The app accepts plain http only for LAN addresses. Docker-published ports bypass ufw and firewalld, so don't forward the port on your router (or set `BIND_ADDR` to the LAN interface's address).
- **Tailscale** (`--mode tailscale`): the backend binds 127.0.0.1:3000; on the host run `tailscale serve --bg 3000` once. `PUBLIC_URL=https://<machine>.<tailnet>.ts.net`; the phone needs the Tailscale app.
- **Domain + Caddy** (`--mode caddy --public-url https://duet.example.com`): point the DNS record at the server and open ports 80 and 443. Caddy gets the certificate; the backend publishes nothing.
- **Cloudflare Tunnel** (`--mode tunnel --public-url https://duet.example.com`, with `TUNNEL_TOKEN` in the environment): create the tunnel in the Cloudflare Zero Trust dashboard and route its public hostname to `http://backend:3000`. Nothing is published.

To switch later, edit `DUET_MODE`, `COMPOSE_FILE`, `COMPOSE_PROFILES`, `PUBLIC_URL` and `BIND_ADDR` in `backend/.env` (see `backend/.env.example`), then `docker compose up -d --remove-orphans`.
In Caddy/Tunnel mode set `TRUSTED_PROXIES=caddy` / `tunnel` (setup fills empty values). Docker DNS resolves just that service's exact IPs, cached for 30 seconds; failed resolution trusts no service address. Never trust the bridge subnet. When switching modes, update this setting too. Caddy's default forwarding policy and cloudflared's rightmost client hop are used; direct clients cannot supply trusted forwarding headers.

If you must publish port 3000 on Linux, restrict it in Docker's `DOCKER-USER` chain, not just ufw. Replace the interface and trusted LAN CIDR; apply equivalent IPv6 rules if Docker IPv6 is enabled, and persist the rules with your distribution's firewall tooling:

```sh
sudo iptables -I DOCKER-USER 1 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
sudo iptables -I DOCKER-USER 2 -i eth0 -s 192.168.1.0/24 -p tcp -m conntrack --ctorigdstport 3000 -j RETURN
sudo iptables -I DOCKER-USER 3 -i eth0 -p tcp -m conntrack --ctorigdstport 3000 -j DROP
```

Do not expose plain HTTP on a public interface; prefer Caddy, Tunnel or Tailscale.

## Deploying on a public VPS

1. Use `./scripts/setup.sh --mode caddy --public-url https://duet.example.com` (or Tunnel/Tailscale), not LAN. Non-interactive setup must specify `--mode`. Keep `compose.lan.yml` out of Caddy/Tunnel's `COMPOSE_FILE`.
2. Provider firewall/security group: SSH from trusted addresses; 80/443 only for Caddy, no app ports for Tunnel/Tailscale. Scan the public IPv4 **and IPv6** from another machine; port 3000 must not be reachable. Docker published ports bypass ufw.
3. SSH keys only, disable root/password login, enable unattended security updates and Docker at boot.
4. Use the exact proxy service name above. After five bad logins from mobile data, verify a second IP can still sign in. IP/pair lockouts remain; username-only attempts delay verification by at most 30 seconds, never reject a different IP.
5. Prefer the generated owner password (or 16+ random characters) and a non-public username. Keep credentials in a password manager, not shell arguments.
6. Caddy includes HSTS, nosniff, no-referrer, no Server header, JSON access logs and a 30 MiB outer body cap. Hono caps sign-in at 16 KiB and other non-upload bodies at 6 MiB (a skill folder can be 5 MiB); uploads retain their individual limits.
7. Set `VAULT_KEY` (`openssl rand -base64 32`) **before storing the first secret** so the vault key is separate from the database. Encrypt backups and the separately saved dotenv with age/restic or equivalent; keep an off-server copy and test restores in an isolated stack. Do not replace an existing vault key: that makes existing secrets unreadable.
8. Set `SESSION_TOKEN_LIMIT`, `WEEKLY_TOKEN_LIMIT` and provider-side spend caps. Prefer Gemini for voice or a spend-limited StepFun key; Tunnel terminates TLS at Cloudflare, which can see credentials in transit.
9. If you do not need OpenDuet's computer, use `--computer off`. Otherwise rebuild it monthly and after Chrome security releases (see Updating), and avoid high-value site logins: since M28 its browser has Chromium's sandbox and OpenDuet's shell runs in computer-exec, which can't read the saved logins, but OpenDuet still drives a browser that is signed in to them. Egress allows only 80/443; HTTPS git works, SSH git/SMTP do not. Public-web exfiltration and the existing user-started Make shell approval exception are **not** fixed by this port policy.
10. Isolate the internal bridge from host services (rules below); never widen `TRUSTED_PROXIES`. Run `cd backend && bun audit` and scan images with trivy/osv before exposure; do not treat a clean dependency audit as a browser/kernel audit.
11. From outside, check HTTPS `/api/server-info` works, `/api/me` returns 401 without a token, HTTP redirects to HTTPS and port 3000 is closed. Review JSON `sign-in ok`, `sign-in failed`, `sign-in locked` logs; passwords/tokens are never logged. Monitor disk and log rotation.
12. Lost phone: on another signed-in device open Profile › Signed-in devices and sign the lost one out; its open streams close at once. With no other device, run `docker compose exec backend bun run user:password --username <u>`: every session is revoked and streams still open close within 60 seconds. Sessions expire 90 days after sign-in and aren't extended by use.

For internal-to-host isolation on Linux, substitute your deployment's internal CIDR. `DOCKER-USER` filters **forwarded** traffic; host-bound traffic also needs `INPUT`. Apply matching IPv6 rules if enabled and persist both. Test in a separate stack before applying to a running deployment:

```sh
# Find YOUR project's internal subnet with docker network inspect <project>_internal.
INTERNAL_CIDR=172.28.0.0/16  # example only; use the actual subnet
sudo iptables -I DOCKER-USER 1 -s "$INTERNAL_CIDR" -m addrtype --dst-type LOCAL -j DROP
sudo iptables -I INPUT 1 -s "$INTERNAL_CIDR" -j DROP
```

Backend, egress and (if used) Caddy images must be rebuilt for this hardening. Computer and cloudflared images need no change for these fixes. Existing Mac LAN/fake-IP installs need no dotenv edit: `ALLOW_FAKE_IP_RANGE=auto` is the default and detects the same resolver in each container. No network IPAM or static container addresses are introduced.

## Mainland China and overseas servers

- A domain served on ports 80/443 of a mainland server needs ICP filing (备案). Tailscale, LAN only and Cloudflare Tunnel don't serve on the server's own 80/443.
- Anthropic and OpenAI can't be reached directly from the mainland. Use a domestic provider's OpenAI- or Anthropic-compatible API, or a relay gateway, as `LLM_BASE_URL`, then run `docker compose exec backend bun run models:check`.
- Composio, GitHub, GHCR and Docker Hub may be slow or unreachable. Add a registry mirror to `/etc/docker/daemon.json` (`{"registry-mirrors": ["https://<mirror>"]}`) and `sudo systemctl restart docker`. Building the computer image clones GitHub and downloads Chromium, so build it elsewhere and copy it with `scripts/export-images.sh`. Go modules for egress: `docker compose build --build-arg GOPROXY=https://goproxy.cn,direct egress`.
- Fake-IP (Clash/Surge) addresses in 198.18.0.0/15 are allowed by `ALLOW_FAKE_IP_RANGE=auto` only when at least two of github.com, www.google.com and www.cloudflare.com resolve entirely into that range. Backend detects at startup and every 5 minutes; egress detects at startup. `1` forces allowance, `0` always denies (recommended on a normal VPS). Missing/failed DNS detection denies the range; other private/reserved ranges are never exempted.
- A Hong Kong, Japan or Singapore VPS avoids all of the above.
- The key-less built-in tools (below) call Exa, Parallel, Open-Meteo and Frankfurter, which may be slow or unreachable from some networks. A tool that can't reach its service says so instead of guessing, and Settings › Apps and connectors › Built in shows the last result; turn any of them off with `BUILTIN_CONNECTORS_OFF`, or set a keyed `SEARCH_PROVIDER`.

## Running on a Mac

Docker Desktop works (Apple Silicon included); give it at least 4 GB of memory and turn on "Start Docker Desktop when you sign in". A sleeping Mac pauses briefs, check-ins and tasks: keep it awake on power (System Settings > Battery > Options, or `caffeinate -s`). The Mac is for development; the production target is Linux.

Backend on the host, computer in Docker: `docker compose -f compose.yml -f compose.dev.yml up -d computer-dev` publishes the computer on 127.0.0.1:4100 only. Set `COMPUTER_URL=http://127.0.0.1:4100` in `backend/.env`, then `cd backend && bun run dev`.

## Installing the app

```sh
brew install xcodegen
cd ios && xcodegen generate && open OpenDuet.xcodeproj
```

In Xcode, pick your team under Signing & Capabilities and change the bundle id `dev.openduet.OpenDuet` to one you own. Which push channel fits:

- **Free Apple ID** (Personal Team): the app must be re-installed from Xcode every 7 days and can't use APNs. Use ntfy or Bark (`NOTIFY_PROVIDER=ntfy` or `bark`).
- **Paid Apple Developer Program**: one-year signing, TestFlight and APNs. Set `NOTIFY_PROVIDER=apns`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY` (the .p8 key), `APNS_TOPIC` (your bundle id); `APNS_ENV=sandbox` for Xcode debug builds.
- **Re-signed IPA** (sideloading tools or a signing service): APNs works only if the signing team grants the push entitlement and you hold its key; otherwise use ntfy or Bark.

Sign in with the server address (`PUBLIC_URL`), your username and password.

## Skills

Add a skill through chat, upload a `.zip`, `.skill` or standalone `SKILL.md`, or import from GitHub. Uploads are detected by content: ZIP packages are limited to 20 MB; a standalone UTF-8 SKILL.md is limited to 1 MB and needs a frontmatter name when its filename is SKILL.md. Previewing does not save anything. Chat-created skills are saved only when you tap **Save skill**; uploaded scripts ask for approval before the first run of each version.

openduet also bundles hidden helpers for skill creation, Make design and themes, Office and PDF documents, data exploration, tasks and meeting minutes. They load only on relevant turns, do not appear in your skills or `/` list, and never override system or approval rules. Your own skills take precedence; Make builds use only their built-in helpers. The Office and PDF helpers need OpenDuet's computer. Sources, licenses and changes are listed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and `backend/skills-builtin/`.

## Built-in tools (no keys)

Built-in read-only tools work without API keys. `web_search` sends only the public search query to Exa, then Parallel on failure (both US companies); an explicit `SEARCH_PROVIDER` uses only that service instead. `weather` sends a place name and language to Open-Meteo geocoding, then coordinates, time zone and units to the Open-Meteo forecast. Its free API is **non-commercial only**, which includes personal self-hosted use; commercial deployments must set `OPEN_METEO_URL`, `OPEN_METEO_GEOCODING_URL` and `OPEN_METEO_API_KEY` for the paid service, or run Open-Meteo themselves. Weather results credit [Weather data by Open-Meteo.com](https://open-meteo.com/) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)). `exchange_rate` sends currency codes and a date to Frankfurter; amounts are converted locally, and these are European Central Bank reference rates, not trading rates. `read_feed` requests the public feed URL directly from its site, without a third-party reader. OpenDuet is told never to put private information in queries, place names or URLs.

Turn tools off with a comma-separated `BUILTIN_CONNECTORS_OFF=weather,exchange_rate,read_feed,web_search` in `backend/.env`, then `docker compose up -d`. For search this turns off only the key-less default, so also leave `SEARCH_PROVIDER` empty. A model's own built-in search, if enabled separately, isn't affected.

## Configuration and accounts

All settings live in `backend/.env`, grouped and commented in `backend/.env.example`. After editing it run `docker compose up -d` (`restart` does not re-read it). A `backend/models.json` (see `backend/models.example.json`) is built into the backend image: `docker compose up -d --build`.
Model URLs are checked when saved and before every model/list/dictation request, with DNS-pinned Host/SNI and certificate verification. Localhost and exact `LLM_ALLOW_INSECURE_HOSTS` remain exceptions; `LLM_ALLOW_PRIVATE_HOSTS` allows named private HTTPS gateways without allowing plain HTTP. Entries are exact hostnames/IPs, not wildcards or CIDRs. Only add hosts you control.

```sh
docker compose exec backend bun run user:create --username <u> --name "<Full Name>"
docker compose exec backend bun run user:password --username <u>
docker compose exec backend bun run user:delete --username <u> --yes
```

## Updating

`git pull && docker compose up -d --build`: migrations run on start and the volumes are kept. Rebuild OpenDuet's computer at least once a month, and whenever Chrome ships a security release: its base images are pinned by digest in `computer/Dockerfile`, so a rebuild without changing them reuses the cached layers and picks up nothing. Update the `ubuntu` and `node` digests (`docker buildx imagetools inspect ubuntu:24.04`, and the same for `node:24.18.1-bookworm-slim`), and for a newer Chromium the Playwright version the Dockerfile says to bump together with upstream's; then `docker compose build computer && docker compose up -d computer-init computer computer-exec`. Prebuilt images: set `DUET_IMAGE_PREFIX=ghcr.io/<owner>/openduet` and `DUET_VERSION=<version>` in `backend/.env`, then `docker compose pull && docker compose up -d`. A server that can't reach registries: on the Mac run `./scripts/export-images.sh user@server` (`--with-caddy` if needed; buildx for linux/amd64, streamed into `docker load` over SSH), then `./scripts/setup.sh --no-build --mode <your mode>` on the server (Caddy/Tunnel also need `--public-url https://<domain>`).

## Backups

`./scripts/backup.sh` writes `backups/<timestamp>/`: a consistent SQLite snapshot (`sqlite3 .backup`), the search index, tarballs of the files and of the computer's profile and workspace (the computer pauses for a few seconds) and checksums. `./scripts/restore.sh backups/<timestamp> --yes` puts them back. `backend/.env` isn't included: keep a copy of it somewhere safe. Backups hold your chats and OpenDuet's logins. Nightly: `0 3 * * * cd /opt/openduet && ./scripts/backup.sh > /dev/null`.
These backups are **not encrypted** by backup.sh and may contain the vault key plus browser cookies. Encrypt them before copying off-server; keep encrypted dotenv/key material separately. A backup on the same VPS is not disaster recovery.

## Troubleshooting

- **models:check fails**: check `LLM_BASE_URL` (Anthropic protocol: no `/v1`; OpenAI-compatible: usually ends in `/v1`), the key and the model id exactly as the gateway names it. Gateways that want `Authorization: Bearer` on the Anthropic protocol need `LLM_AUTH_HEADER=bearer`; a plain-http LAN gateway needs `LLM_ALLOW_INSECURE_HOSTS`. HTTP 429 means rate limited: wait a minute. Then `docker compose up -d && docker compose exec backend bun run models:check`.
- **computer unhealthy**: `docker compose logs --tail 100 computer computer-exec egress`, `docker compose exec backend bun src/cli/health.ts`. It needs about 2 GB of free memory and a healthy egress. After changing `COMPUTER_TOKEN` run `docker compose up -d` so both containers get it. A failed build usually means GitHub, NuGet (OfficeCLI) or the Playwright download is unreachable; `./scripts/export-images.sh` builds the images on another machine.
- **The phone can't reach the address**: open `<PUBLIC_URL>/api/server-info` in Safari on the phone. LAN: `BIND_ADDR` must be `0.0.0.0` (or the LAN IP) and `PUBLIC_URL` the LAN IP, not localhost; same Wi-Fi without client isolation; the host firewall allows the port; allow Local Network for the app in iOS Settings. Tailscale: `tailscale serve status` on the host, Tailscale on the phone. Caddy: DNS, ports 80/443, `docker compose logs caddy`, ICP filing on mainland servers. Tunnel: the public hostname routes to `http://backend:3000`; `docker compose logs tunnel`.

Third-party components and licenses: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
