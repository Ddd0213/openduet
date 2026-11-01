# OpenDuet 部署和运维

这份文档是部署的完整说明：setup.sh 的全部选项、运行的服务和网络隔离、远程访问、公网服务器加固、大陆网络、在 Mac 上运行、App 签名和推送、配置、更新、备份和排错。产品介绍和最简部署步骤见 [README](../README.zh-CN.md)。

English: [DEPLOY.md](DEPLOY.md)

## 安装（setup.sh）

需要 Docker Engine 和 compose 插件（v2.20 及以上）、git、openssl。全新的 Linux 服务器：`curl -fsSL https://get.docker.com | sh`，然后 `sudo systemctl enable --now docker`。

```sh
git clone https://github.com/Ddd0213/openduet.git && cd openduet
./scripts/setup.sh
```

setup.sh 会检查 Docker，询问手机怎么连到服务器，询问模型网关（协议、base URL、key、模型 id）以及可选的 Composio、网页搜索和推送，还会问要不要部署 OpenDuet 的电脑；写入 `backend/.env`（chmod 600），自动生成 `BETTER_AUTH_SECRET` 和 `COMPUTER_TOKEN`；构建并启动整套服务，等到全部 healthy，运行 `bun run models:check`，创建你的账号，最后打印要在 App 里填的地址。可以重复运行：`backend/.env` 里已有的值和数据卷都会保留。

非交互运行（服务器、CI）：key 只从环境变量读，不从命令行参数读。

```sh
read -rs LLM_API_KEY && export LLM_API_KEY      # 输入 key，不会回显
LLM_PROTOCOL=anthropic LLM_BASE_URL=https://api.anthropic.com LLM_MODEL=<模型 id> \
  ./scripts/setup.sh --mode caddy --public-url https://duet.example.com --yes --username me --name "Your Name"
```

不设 `DUET_PASSWORD` 时会生成一个密码，只打印一次。全部选项见 `./scripts/setup.sh --help`。
CLI 新设密码至少 12 位，且不能是内置黑名单中的常见密码；已有密码照常登录。公网服务器的交互安装推荐自动生成密码。
没有终端或带 `--yes` 时必须给 `--mode lan|tailscale|caddy|tunnel`，更新时也一样。检测到公网默认路由时菜单默认选 Caddy；LAN 绑定 `0.0.0.0` 会被拒绝，除非显式给 `--bind-addr`。检测失败时，交互式要求确认，非交互式要求显式绑定地址。

## 配置要求

最低 2 vCPU、4 GB 内存、40 GB 磁盘。最吃资源的是 Chromium：computer 限制 2 GB 内存，backend 限制 1 GB。镜像约占 4 GB。

## 运行的服务

| 服务 | 作用 | 发布端口 | 数据（具名卷） |
|---|---|---|---|
| backend | API、agent、定时任务；非 root（UID 10001），根文件系统只读，启动时执行数据库迁移 | 仅 LAN / Tailscale 模式：`${BIND_ADDR}:${PORT}` | `backend-db`（SQLite WAL + 搜索索引）、`backend-files`、`backend-artifacts` |
| computer | OpenDuet 的电脑：CopilotKit/OpenBot 的 agent-computer，固定在 `da9a3ca`，加我们的补丁（`computer/`），Chromium（无头或有头）；可选 | 从不 | `computer-profiles`（OpenDuet 的登录状态）、`computer-workspace` |
| computer-exec | OpenDuet 的 shell（`computer_exec`），带 git、python3、OfficeCLI：和电脑同一个镜像，但只挂 `/workspace`；没有登录状态、token 和显示器。随电脑一起部署 | 从不 | `computer-workspace`、`exec-socket` |
| egress | Stripe smokescreen v0.1.0，computer 唯一的出口 | 从不 | 无 |
| caddy | 可选：为 `PUBLIC_URL` 自动配置 HTTPS | 80、443 | `caddy-data`、`caddy-config` |
| tunnel | 可选：Cloudflare Tunnel（cloudflared） | 不发布 | 无 |

出口代理只允许目标端口 **80 和 443**（HTTP 和 CONNECT 都检查）。浏览网页、HTTPS git 和这些端口上的软件源照常；SSH git、SMTP、自定义端口软件源和任意 TCP 隧道会被拒绝。这能减少滥用，但不能阻止提示注入把数据发给公网网站。
computer 在一个没有出口路由的 internal 网络上，只能和 backend、egress 通信。egress 拦截私有、回环、链路本地地址（包括云元数据地址 169.254.169.254）、CGNAT 100.64.0.0/10、IPv6 ULA 和链路本地。computer 以 `cap_drop: ALL`、`no-new-privileges`、内存和进程数限制运行，不挂 Docker socket，只拿到 `COMPUTER_TOKEN`、`COMPUTER_BOT_ID` 和代理设置，拿不到模型、Composio、搜索、推送的 key。跑 OpenDuet shell 的 computer-exec 限制相同，只拿到代理设置，没有 `COMPUTER_TOKEN`。`./scripts/smoke.sh` 会逐项检查这些。computer（它的浏览器、OpenDuet 登录过的网站、/workspace）只属于一个账户：backend/.env 里的 `COMPUTER_OWNER`，不填就是最先创建的账户。同一台服务器上的其他账户没有 computer。

## OpenDuet 的电脑（可选）

OpenDuet 用它上网、登录网站、做 Make 作品。占磁盘约 2.4 GB（下载约 600 MB）；浏览器休眠时约占 100 MB 内存，浏览时最多 2 GB。不部署时，OpenDuet 照样能聊天、搜索网页、用连接的 App、记住事情；App 里会显示电脑没有部署，并给出部署命令。

- 新装时会询问要不要部署。之后随时可以改：`./scripts/setup.sh --computer off` 或 `--computer on`。off 会把 `compose.no-computer.yml` 加进 `backend/.env` 的 `COMPOSE_FILE`，并删掉 computer、computer-exec 和 egress 容器；卷保留，再部署时 OpenDuet 登录过的网站还在。
- `--browser headless|headed`（默认 headless）。headless 只显示页面，1280×800 横屏，App 在上面画自己的标签栏和地址栏（`--browser-screen portrait` 换成宽 430 CSS px、和手机差不多的竖屏页面）。有头模式在容器里的虚拟显示器（Xvfb）上运行 Chromium，这时实时画面和接管显示的是整个 Chrome 窗口（标签栏、地址栏和鼠标），1280×800（`--browser-screen portrait` 换成竖着的 860×1600 窗口）。有人看的时候多占约 200 MB 内存。我们实测时，套了 Cloudflare 的网站对有头浏览器弹验证的次数多得多（16 次只过了 2 次，headless 8 次全过），所以默认仍是 headless。
- OpenDuet 的 shell 里有 git、python3 和 OfficeCLI（Word、Excel、PPT 文件）。M28 起电脑和它的 shell 用自己的用户（uid 10003）跑在只读镜像上，所以里面不能再 `apt-get install`；Node 包仍可以装进 `/workspace`（`bun add`、`npm install`）。
- M28 起 shell 的命令在单独的容器 `computer-exec` 里跑：镜像和用户都和电脑一样，但只挂 `/workspace`，所以命令读不到浏览器 profile（OpenDuet 登录过的网站）、`COMPUTER_TOKEN`，也碰不到浏览器的显示器。电脑通过 `exec-socket` 卷上的 unix socket 把每条命令交过去；超时和「停止」和以前一样。computer-exec 没在跑时，命令会报 "The command runner is not reachable"，不会改在电脑里跑（看 `docker compose logs computer-exec`）。它空闲时约占 9 MB（上限 1 GB 内存、512 个进程）。
- Chromium 开着自己的沙箱。这要靠 `computer/seccomp-chrome.json`（Docker 默认的 seccomp 配置，加上用户、pid、网络命名空间和 `chroot`），不加任何 capability。如果主机内核不允许普通用户建用户命名空间，浏览器会起不来：先看 `docker compose logs computer`，确认是这个原因再在 `backend/.env` 里设 `COMPUTER_SANDBOX=off`。
- M28 之前建的卷属于 root。`computer-init` 服务在电脑和 computer-exec 每次启动前把它们交给 uid 10003（交完以后什么都不做）。`docker compose up` 会自动跑它；用 `--no-deps` 时三个都要写上：`docker compose up -d --no-deps --force-recreate computer-init computer computer-exec`。
- `--browser-idle <分钟>`（默认 30，0 表示不关）：浏览器空闲这么久就关掉，容器留着。时间越短越省内存，但开着的页面也丢得越早。登录状态都留在 profile 里，只用会话 cookie 的网站也一样。
- 在 App 里打开「OpenDuet 的电脑」会叫醒它，OpenDuet 要用浏览器时也会自己叫醒；全屏页的「让它休眠」会立刻关掉浏览器。

## 远程访问

- **仅局域网**（`--mode lan`）：设 `BIND_ADDR=0.0.0.0`、`PUBLIC_URL=http://<局域网 IP>:3000`。App 只对局域网地址接受明文 http。Docker 发布的端口会绕过 ufw 和 firewalld，所以不要在路由器上做端口转发（或者把 `BIND_ADDR` 设成局域网网卡的地址）。
- **Tailscale**（`--mode tailscale`）：backend 绑定 127.0.0.1:3000，在宿主机上执行一次 `tailscale serve --bg 3000`。`PUBLIC_URL=https://<机器名>.<tailnet>.ts.net`；手机要装 Tailscale。
- **域名 + Caddy**（`--mode caddy --public-url https://duet.example.com`）：DNS 解析到服务器，开放 80 和 443 端口。Caddy 自动申请证书，backend 不发布端口。
- **Cloudflare Tunnel**（`--mode tunnel --public-url https://duet.example.com`，环境变量里给 `TUNNEL_TOKEN`）：在 Cloudflare Zero Trust 控制台创建隧道，把公网主机名指向 `http://backend:3000`。不发布任何端口。

以后要换方式：改 `backend/.env` 里的 `DUET_MODE`、`COMPOSE_FILE`、`COMPOSE_PROFILES`、`PUBLIC_URL`、`BIND_ADDR`（说明见 `backend/.env.example`），然后 `docker compose up -d --remove-orphans`。
Caddy/Tunnel 模式设 `TRUSTED_PROXIES=caddy` / `tunnel`（setup 会填空值）。Docker DNS 只解析这个服务的精确 IP，缓存 30 秒；解析失败不信任该服务的任何地址。不要信任整个网段。切换模式时也更新这个变量。使用 Caddy 默认的转发头策略和 cloudflared 最右侧的客户端地址；直连客户端不能伪造可信转发头。

Linux 上必须发布 3000 时，应在 Docker 的 `DOCKER-USER` 链限制，不要只靠 ufw。替换网卡和可信局域网 CIDR；启用 Docker IPv6 时也需对应 IPv6 规则，并用发行版的防火墙工具持久化：

```sh
sudo iptables -I DOCKER-USER 1 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
sudo iptables -I DOCKER-USER 2 -i eth0 -s 192.168.1.0/24 -p tcp -m conntrack --ctorigdstport 3000 -j RETURN
sudo iptables -I DOCKER-USER 3 -i eth0 -p tcp -m conntrack --ctorigdstport 3000 -j DROP
```

不要把明文 HTTP 暴露到公网；优先 Caddy、Tunnel 或 Tailscale。

## 公网 VPS 部署

1. 用 `./scripts/setup.sh --mode caddy --public-url https://duet.example.com`（或 Tunnel/Tailscale），不用 LAN。非交互必须给 `--mode`。Caddy/Tunnel 的 `COMPOSE_FILE` 不应包含 `compose.lan.yml`。
2. 云防火墙/安全组：SSH 仅可信来源；Caddy 只另开 80/443，Tunnel/Tailscale 不开 App 端口。从外部扫描公网 **IPv4 和 IPv6**，3000 不可达。Docker 发布端口会绕过 ufw。
3. SSH 只用密钥，关闭 root/密码登录；开启自动安全更新和 Docker 开机启动。
4. 只信任上述精确代理服务名。手机移动网络输错五次后，检查第二个 IP 仍能登录。保留 IP/组合锁；仅用户名的尝试最多减速 30 秒，不拒绝不同 IP。
5. 优先自动生成的账号密码（或 16 位以上随机密码）和不公开的用户名。用密码管理器，不把密码放命令行参数。
6. Caddy 已带 HSTS、nosniff、no-referrer、隐藏 Server、JSON 访问日志和 30 MiB 外层请求体上限。Hono 登录上限 16 KiB，其他非上传请求 6 MiB（技能文件夹可达 5 MiB）；上传仍用各自上限。
7. **存第一条密钥前**设置 `VAULT_KEY`（`openssl rand -base64 32`），把密钥和数据库分开。用 age/restic 等加密备份及单独保存的 dotenv，存一份在服务器外，在隔离的栈上测试恢复。不要替换已有 vault key，否则旧密钥不可读。
8. 设 `SESSION_TOKEN_LIMIT`、`WEEKLY_TOKEN_LIMIT` 和厂商侧消费上限。语音优先 Gemini，或限制 StepFun key 的消费；Tunnel 在 Cloudflare 终止 TLS，它能看到传输中的凭据。
9. 不需要 OpenDuet 的电脑就 `--computer off`。需要时每月、以及 Chrome 发安全更新后重建（见「更新」）；M28 起浏览器有 Chromium 沙箱，OpenDuet 的 shell 也挪到了读不到保存登录的 computer-exec，但 OpenDuet 操作的浏览器仍登录着这些网站，所以不要登录高价值账号。出口只开 80/443，HTTPS git 正常，SSH git/SMTP 被挡。公网网页外传及现有的用户发起 Make 构建的 shell 批准例外**没有**被这个端口策略修复。
10. 隔离 internal 网桥到宿主机的服务（下方规则）；不要扩大 `TRUSTED_PROXIES`。暴露前运行 `cd backend && bun audit`，并用 trivy/osv 扫描镜像；依赖审计不等于浏览器/内核审计。
11. 外部检查 HTTPS `/api/server-info` 正常，无 token 的 `/api/me` 返回 401，HTTP 跳 HTTPS，3000 关闭。监控 JSON `sign-in ok`、`sign-in failed`、`sign-in locked` 日志，不记密码/token；检查磁盘和日志轮转。
12. 丢手机：在另一台已登录的设备上打开「头像 › 已登录的设备」，让丢的那台退出登录，它正在连的流会立刻断开。没有别的设备时运行 `docker compose exec backend bun run user:password --username <u>`：所有会话都会失效，还开着的流最多 60 秒内断开。会话从登录起 90 天后失效，用的时候不续期。

Linux internal→宿主机隔离：替换为自己部署的 internal CIDR。`DOCKER-USER` 只过滤**转发**流量；到宿主机本身还要 `INPUT`。开启 IPv6 时也配相应规则并持久化；先在独立栈验证再应用到现有部署：

```sh
# 用 docker network inspect <project>_internal 找自己项目的网段。
INTERNAL_CIDR=172.28.0.0/16  # 仅示例，使用真实网段
sudo iptables -I DOCKER-USER 1 -s "$INTERNAL_CIDR" -m addrtype --dst-type LOCAL -j DROP
sudo iptables -I INPUT 1 -s "$INTERNAL_CIDR" -j DROP
```

应用加固要重建 backend、egress、以及启用时的 Caddy 镜像；computer 和 cloudflared 不需因这些修复改动。现有 Mac 的 LAN/fake-IP 部署不需改 dotenv：`ALLOW_FAKE_IP_RANGE=auto` 是默认值，在各容器检测自己的解析器。不增加网络 IPAM 或固定容器地址。

## 大陆和海外服务器

- 大陆服务器用域名在 80/443 端口提供服务需要 ICP 备案。Tailscale、仅局域网和 Cloudflare Tunnel 不占用服务器自己的 80/443。
- 大陆直连不了 Anthropic 和 OpenAI。把国内厂商的 OpenAI 或 Anthropic 兼容接口、或者中转网关填为 `LLM_BASE_URL`，再运行 `docker compose exec backend bun run models:check`。
- Composio、GitHub、GHCR、Docker Hub 可能很慢或连不上。在 `/etc/docker/daemon.json` 配置镜像加速（`{"registry-mirrors": ["https://<镜像地址>"]}`），然后 `sudo systemctl restart docker`。构建 computer 镜像要克隆 GitHub 并下载 Chromium，可以在别处构建后用 `scripts/export-images.sh` 拷过去。egress 的 Go 模块：`docker compose build --build-arg GOPROXY=https://goproxy.cn,direct egress`。
- Fake-IP（Clash/Surge）的 198.18.0.0/15 仅在 `ALLOW_FAKE_IP_RANGE=auto` 检测到 github.com、www.google.com、www.cloudflare.com 至少两个域名完全解析到这个网段时放行。后端启动及每 5 分钟检测，egress 启动时检测。`1` 强制放行，`0` 始终拒绝（普通 VPS 推荐）。缺少/失败的 DNS 检测会拒绝；其他私有/保留网段从不豁免。
- 用香港、日本或新加坡的 VPS，以上问题都不存在。
- 下面的免 key 内置工具会访问 Exa、Parallel、Open-Meteo 和 Frankfurter，在有些网络下可能很慢或连不上。连不上时工具会如实说明，不会猜；「设置 › 应用和连接器 › 内置」里能看到上一次的结果。可以用 `BUILTIN_CONNECTORS_OFF` 关掉其中任何一个，或者配置带 key 的 `SEARCH_PROVIDER`。

## 在 Mac 上运行

Docker Desktop 可以用（包括 Apple Silicon），至少给它 4 GB 内存，并打开「登录时启动 Docker Desktop」。Mac 休眠时简报、检查和任务都会暂停：接电源时保持唤醒（系统设置 > 电池 > 选项，或 `caffeinate -s`）。Mac 只用于开发，正式部署以 Linux 为准。

后端跑在宿主机、computer 跑在 Docker：`docker compose -f compose.yml -f compose.dev.yml up -d computer-dev` 只在 127.0.0.1:4100 发布 computer。在 `backend/.env` 里设 `COMPUTER_URL=http://127.0.0.1:4100`，然后 `cd backend && bun run dev`。

## 安装 App

```sh
brew install xcodegen
cd ios && xcodegen generate && open OpenDuet.xcodeproj
```

在 Xcode 的 Signing & Capabilities 里选择你的团队，并把 bundle id `dev.openduet.OpenDuet` 改成你自己的。各种签名方式适合的推送：

- **免费 Apple ID**（Personal Team）：每 7 天要用 Xcode 重新安装一次，不能用 APNs。用 ntfy 或 Bark（`NOTIFY_PROVIDER=ntfy` 或 `bark`）。
- **付费 Apple Developer Program**：签名有效期一年，可以用 TestFlight 和 APNs。设置 `NOTIFY_PROVIDER=apns`、`APNS_KEY_ID`、`APNS_TEAM_ID`、`APNS_KEY`（.p8 key）、`APNS_TOPIC`（你的 bundle id）；Xcode 调试包用 `APNS_ENV=sandbox`。
- **重签 IPA**（侧载工具或签名服务）：只有签名团队提供推送权限、并且你拿得到它的 key 时 APNs 才可用；否则用 ntfy 或 Bark。

用服务器地址（`PUBLIC_URL`）、用户名和密码登录。

## 技能

可以通过聊天创建技能，上传 `.zip`、`.skill` 或单个 `SKILL.md`，也可以从 GitHub 导入。上传按文件内容识别：ZIP 包上限 20 MB，单个 UTF-8 SKILL.md 上限 1 MB；文件名为 SKILL.md 时，需要在 frontmatter 里写 name。预览不会保存；聊天里创建的技能只有点 **Save skill（保存技能）** 才会保存。上传的技能里的脚本，每个版本第一次运行前都要批准。

openduet 还内置了几个不显示的助手：创建技能、创作页的设计和主题、Office 和 PDF 文档、数据探索、任务、会议纪要。它们只在相关的回合按需加载，不出现在技能页和 `/` 列表里，也不能越过系统规则和审批。你自己的技能优先；创作构建只用对应的内置助手。Office 和 PDF 助手需要 OpenDuet 的电脑。来源、许可和改动见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 和 `backend/skills-builtin/`。

## 内置工具（不用 key）

几个只读的内置工具不需要 API key。`web_search` 只把搜索词发给 Exa，失败时换 Parallel（都是美国公司）；配了 `SEARCH_PROVIDER` 时只用配的那家。`weather` 先把地名和语言发给 Open-Meteo 的地名查询，再把坐标、时区和单位发给 Open-Meteo 的天气预报。它的免费接口**只允许非商业使用**，个人自托管算在内；商业部署要设置 `OPEN_METEO_URL`、`OPEN_METEO_GEOCODING_URL`、`OPEN_METEO_API_KEY` 用付费版，或者自己部署 Open-Meteo。天气结果会注明 [Weather data by Open-Meteo.com](https://open-meteo.com/)（[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)）。`exchange_rate` 把币种代码和日期发给 Frankfurter；金额在本地换算；这是欧洲央行的参考汇率，不是交易汇率。`read_feed` 直接向订阅源自己的网址请求，不经过第三方阅读器。OpenDuet 被要求不把私人信息放进搜索词、地名和网址。

关掉某个工具：在 `backend/.env` 里写 `BUILTIN_CONNECTORS_OFF=weather,exchange_rate,read_feed,web_search`（逗号分隔），然后 `docker compose up -d`。对搜索来说，这只关掉免 key 的默认搜索，所以 `SEARCH_PROVIDER` 也要留空。模型自带的搜索如果另外开了，不受影响。

## 配置和账号

所有设置都在 `backend/.env`，`backend/.env.example` 里分组写了说明。改完运行 `docker compose up -d`（`restart` 不会重新读取它）。`backend/models.json`（见 `backend/models.example.json`）会打进 backend 镜像：`docker compose up -d --build`。
模型地址保存和每次模型/列表/听写请求前都检查 DNS，并固定连接地址、Host/SNI 和证书校验。localhost 及精确 `LLM_ALLOW_INSECURE_HOSTS` 仍豁免；`LLM_ALLOW_PRIVATE_HOSTS` 可放行指定私有 HTTPS 网关，但不放行明文 HTTP。只填精确主机名/IP，不支持通配符/CIDR，只加自己控制的主机。

```sh
docker compose exec backend bun run user:create --username <u> --name "<Full Name>"
docker compose exec backend bun run user:password --username <u>
docker compose exec backend bun run user:delete --username <u> --yes
```

## 更新

`git pull && docker compose up -d --build`：启动时自动迁移数据库，数据卷保留。OpenDuet 的电脑至少每月重建一次，Chrome 发安全更新时也要重建：`computer/Dockerfile` 里的基础镜像按 digest 固定，不改 digest 就重建只会用缓存，什么更新都拿不到。先更新 `ubuntu` 和 `node` 的 digest（`docker buildx imagetools inspect ubuntu:24.04`、`node:24.18.1-bookworm-slim`）；要新的 Chromium，再按 Dockerfile 里写的和上游一起升 Playwright 版本；然后 `docker compose build computer && docker compose up -d computer-init computer computer-exec`。用预构建镜像：在 `backend/.env` 里设 `DUET_IMAGE_PREFIX=ghcr.io/<owner>/openduet` 和 `DUET_VERSION=<版本>`，然后 `docker compose pull && docker compose up -d`。服务器连不上镜像仓库：在 Mac 上运行 `./scripts/export-images.sh user@server`（需要 Caddy 时加 `--with-caddy`；buildx 构建 linux/amd64，经 SSH 直接 `docker load`），然后在服务器上 `./scripts/setup.sh --no-build --mode <所选模式>`（Caddy/Tunnel 也给 `--public-url https://<域名>`）。

## 备份

`./scripts/backup.sh` 写入 `backups/<时间戳>/`：一致的 SQLite 快照（`sqlite3 .backup`）、搜索索引、文件以及 computer 的 profile 和 workspace 的压缩包（computer 会暂停几秒）、校验和。`./scripts/restore.sh backups/<时间戳> --yes` 恢复。备份不含 `backend/.env`，请另外妥善保存一份。备份里有你的聊天记录和 OpenDuet 的登录状态。每晚备份：`0 3 * * * cd /opt/openduet && ./scripts/backup.sh > /dev/null`。
backup.sh **不加密**备份，里面可能同时有 vault key 和浏览器 cookies。拷贝到服务器外前先加密，dotenv/密钥材料单独加密保存。同一台 VPS 上的备份不是灾难恢复。

## 排错

- **models:check 失败**：检查 `LLM_BASE_URL`（Anthropic 协议不带 `/v1`；OpenAI 兼容接口通常以 `/v1` 结尾）、key，以及网关里模型 id 的准确写法。Anthropic 协议下要求 `Authorization: Bearer` 的网关需要 `LLM_AUTH_HEADER=bearer`；局域网里的明文 http 网关需要 `LLM_ALLOW_INSECURE_HOSTS`。HTTP 429 是被限流，等一分钟。改完 `docker compose up -d && docker compose exec backend bun run models:check`。
- **computer 不健康**：`docker compose logs --tail 100 computer computer-exec egress`、`docker compose exec backend bun src/cli/health.ts`。它需要约 2 GB 空闲内存和一个健康的 egress。改了 `COMPUTER_TOKEN` 后运行 `docker compose up -d`，让两个容器都拿到新值。构建失败通常是连不上 GitHub、NuGet（OfficeCLI）或 Playwright 的下载地址；可以用 `./scripts/export-images.sh` 在别的机器上构建镜像。
- **手机连不上地址**：先在手机 Safari 里打开 `<PUBLIC_URL>/api/server-info`。局域网：`BIND_ADDR` 必须是 `0.0.0.0`（或局域网 IP），`PUBLIC_URL` 用局域网 IP 而不是 localhost；手机和服务器在同一个 Wi-Fi 且没有开 AP 隔离；宿主机防火墙放行了端口；在 iOS 设置里允许 App 访问本地网络。Tailscale：宿主机上 `tailscale serve status`，手机上开着 Tailscale。Caddy：DNS、80/443 端口、`docker compose logs caddy`，大陆服务器还要备案。Tunnel：公网主机名指向 `http://backend:3000`；`docker compose logs tunnel`。

第三方组件和许可证：[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
