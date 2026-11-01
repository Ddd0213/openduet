// In-container end-to-end check used by scripts/smoke.sh:
//   1. GET /api/server-info answers without a session
//   2. sign in (POST /api/session), GET /api/me with the token, sign out, the token stops working
//   3. the computer refuses calls without COMPUTER_TOKEN, and with it opens https://example.com
//      in Chromium (which also proves the browser starts under cap_drop ALL and egress works)
//   4. the browser cannot open the cloud metadata address through the egress proxy
// M20: on a server without OpenDuet's computer (COMPUTER_URL empty) steps 3-4 are skipped and it
// checks instead that the backend reports it as off (/api/me features.computerMode "off",
// /api/computer available false).
// Reads the throwaway user's password from SMOKE_PASSWORD; never prints tokens or passwords.
import { loadConfig } from "../config.ts";

type Step = { name: string; ok: boolean; detail: string };

const steps: Step[] = [];
const record = (name: string, ok: boolean, detail: string) => {
  steps.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}\n`);
  return ok;
};

async function call(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const { timeoutMs = 15_000, ...rest } = init;
  const response = await fetch(url, { ...rest, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json: json as Record<string, unknown> | null };
}

async function main(): Promise<number> {
  const config = loadConfig();
  const username = process.argv[2];
  const password = process.env.SMOKE_PASSWORD;
  if (!username || !password) {
    process.stderr.write("usage: SMOKE_PASSWORD=<password> bun src/cli/smoke.ts <username>\n");
    return 2;
  }
  const api = `http://127.0.0.1:${config.PORT}`;

  const info = await call(`${api}/api/server-info`);
  record("server-info", info.status === 200 && typeof info.json?.name === "string",
    `HTTP ${info.status}${typeof info.json?.version === "string" ? `, version ${info.json.version}` : ""}`);

  const signIn = await call(`${api}/api/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }),
  });
  const token = typeof signIn.json?.token === "string" ? signIn.json.token : "";
  record("sign-in", signIn.status === 200 && token.length > 0, `HTTP ${signIn.status}`);
  if (token) {
    const auth = { authorization: `Bearer ${token}` };
    const me = await call(`${api}/api/me`, { headers: auth });
    record("me", me.status === 200, `HTTP ${me.status}`);
    if (!config.COMPUTER_URL || !config.COMPUTER_TOKEN) {
      // M20: without a computer the backend has to say so, not offer a browser that isn't there.
      const features = (me.json?.features ?? null) as Record<string, unknown> | null;
      record("computer is off in /api/me", features?.computerMode === "off", `computerMode ${String(features?.computerMode)}`);
      const state = await call(`${api}/api/computer`, { headers: auth });
      record("/api/computer says not available", state.status === 200 && state.json?.available === false, `HTTP ${state.status}, available ${String(state.json?.available)}`);
    }
    const out = await call(`${api}/api/session`, { method: "DELETE", headers: auth });
    record("sign-out", out.status === 204, `HTTP ${out.status}`);
    const after = await call(`${api}/api/me`, { headers: auth });
    record("revoked token refused", after.status === 401, `HTTP ${after.status}`);
  }

  const computer = config.COMPUTER_URL;
  if (!computer || !config.COMPUTER_TOKEN) {
    // M20: a server without OpenDuet's computer (setup.sh --computer off) is a supported setup; the
    // computer steps are skipped and the off state was checked above, while signed in.
    process.stdout.write("SKIP computer: not deployed on this server (COMPUTER_URL empty)\n");
  } else {
    const headers = {
      "content-type": "application/json",
      "x-openbot-computer-token": config.COMPUTER_TOKEN,
      "x-openbot-bot-id": config.COMPUTER_BOT_ID,
    };
    const health = await call(`${computer}/health`);
    record("computer health", health.status === 200 && health.json?.status === "ok", `HTTP ${health.status}`);
    const anonymous = await call(`${computer}/navigate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com/" }),
    });
    record("computer refuses calls without the token", anonymous.status === 401, `HTTP ${anonymous.status}`);
    // Cold start launches Chromium; allow for a slow first page.
    const navigate = () => call(`${computer}/navigate`, {
      method: "POST", headers, body: JSON.stringify({ url: "https://example.com/" }), timeoutMs: 120_000,
    });
    let nav = await navigate();
    // After a restart or handback, agent-computer refuses page mutations until the bot has taken a
    // fresh snapshot (persisted in /profiles). That is its protocol, so follow it once and retry.
    if (nav.status === 409 && /snapshot/i.test(String(nav.json?.error ?? ""))) {
      await call(`${computer}/snapshot`, { method: "POST", headers, body: "{}", timeoutMs: 120_000 });
      nav = await navigate();
    }
    const title = typeof nav.json?.title === "string" ? nav.json.title : "";
    record("computer opens example.com", nav.status === 200 && /example domain/i.test(title),
      nav.status === 200 ? `title "${title}"` : `HTTP ${nav.status}${typeof nav.json?.error === "string" ? `: ${nav.json.error.slice(0, 160)}` : ""}`);
    const meta = await call(`${computer}/navigate`, {
      method: "POST", headers, body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/" }), timeoutMs: 60_000,
    });
    const text = typeof meta.json?.text === "string" ? meta.json.text : "";
    // M20: agent-computer da9a3ca refuses link-local and metadata addresses itself, before the
    // egress proxy, with its own page ("... a cloud metadata or link-local address, which no Bot
    // may reach."); older images got the proxy's "Egress proxying is denied".
    const byComputer = /cloud metadata or link-local address|no bot may reach/i.test(text);
    const byProxy = /egress proxying is denied|denied/i.test(text);
    const refused = meta.status !== 200 || byComputer || byProxy;
    record("browser cannot reach 169.254.169.254", refused,
      meta.status === 200 ? (byComputer ? "the computer refused it" : byProxy ? "egress proxy refused it" : "page loaded") : `navigation failed (HTTP ${meta.status})`);
  }

  return steps.every((step) => step.ok) ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
