// /api/computer (docs/API.md, L141, L143, M20, M27 browser): the computer's state, Take over / Hand
// back, Sleep, the full-screen view's tab strip and address bar, the sign-in card
// (submit, code, take over, dismiss), the live screen's WebSocket upgrade (after
// requireSession, so the phone's own session is the only credential), and the "OpenDuet's computer"
// row's Ask / Always pickers.
// Sign-in bodies are read raw here and never logged: app.ts logs only method, path and error class.
// One owner per deployment: any other account sees the computer as not set up (503 / the off state).
import type { Server } from "bun";
import type { AppEnv, RegisterRoutes } from "../app.ts";
import { ComputerControlResponse, ComputerState, SignInCardResponse } from "../contract/computer.ts";
import { BrowserBar, NavigateRequest, NewTabRequest } from "../contract/m27browser.ts";
import { ConnectorDetail, UpdatePolicyRequest } from "../contract/connectors.ts";
import { HttpError, readJson } from "../http.ts";
import type { PolicyService } from "../policy/service.ts";
import { ComputerService } from "../computer/service.ts";
import { DISMISSED_PROMPT, SIGNED_IN_PROMPT, type SignInService } from "../computer/signin.ts";
import { streamData, type StreamSocketData } from "../computer/stream.ts";
import { COMPUTER_APP, COMPUTER_TOOLKIT, POLICY_TOOLS, TOOL_INFO, type PolicyTool } from "../computer/tools.ts";
import { alwaysBlockedFor, alwaysFields, alwaysNotAllowed } from "../policy/floor.ts";
import type { Context } from "hono";

export interface ComputerRouteDeps {
  service: ComputerService;
  signIn: SignInService;
  policy: PolicyService;
}

/** The connector-style detail sheet of the "OpenDuet's computer" row (L143). */
async function toolsDetail(policy: PolicyService, userId: string) {
  const modes = await policy.modes(userId, POLICY_TOOLS.map((slug) => ({ slug, toolkit: COMPUTER_TOOLKIT, defaultMode: TOOL_INFO[slug].defaultMode })));
  const rows = POLICY_TOOLS.map((slug) => ({
    slug, name: TOOL_INFO[slug].name, description: TOOL_INFO[slug].description, access: TOOL_INFO[slug].access, mode: modes.get(slug) ?? TOOL_INFO[slug].defaultMode, common: TOOL_INFO[slug].common,
    // M20: whether the picker's Always is enabled (policy/floor.ts; the consequential-click check stays either way).
    ...alwaysFields({ slug, toolkit: COMPUTER_TOOLKIT, defaultMode: TOOL_INFO[slug].defaultMode }),
  }));
  rows.sort((a, b) => (a.access === b.access ? 0 : a.access === "read" ? -1 : 1) || Number(b.common) - Number(a.common));
  return ConnectorDetail.parse({
    connector: { toolkit: COMPUTER_TOOLKIT, name: COMPUTER_APP, description: "OpenDuet's own browser and workspace on your server.", logoUrl: null, category: null, accounts: [] },
    tools: rows,
  });
}

type UpgradeServer = Pick<Server<StreamSocketData>, "upgrade">;

function bunServer(c: Context<AppEnv>): UpgradeServer | null {
  const env = c.env as unknown;
  return env && typeof env === "object" && typeof (env as { upgrade?: unknown }).upgrade === "function" ? (env as UpgradeServer) : null;
}

const notSetUp = () => new HttpError(503, "not_configured", "OpenDuet's computer isn't set up on this server.");

export function computerRoutes(deps: ComputerRouteDeps): RegisterRoutes {
  const { service, signIn, policy } = deps;
  /** The signed-in user, if the computer is theirs; otherwise 503 like a server without one. */
  const owner = async (c: Context<AppEnv>) => {
    const userId = c.get("user").id;
    if (!(await service.allows(userId))) throw notSetUp();
    return userId;
  };
  /** The tools sheet works without a computer (the row says "isn't set up"), not for another account. */
  const toolsUser = async (c: Context<AppEnv>) => (service.configured ? owner(c) : c.get("user").id);
  return (app) => {
    app.get("/api/computer", async (c) => {
      const userId = c.get("user").id;
      if (!(await service.allows(userId))) return c.json(ComputerState.parse(service.configured ? ComputerService.offState() : await service.refresh(userId)));
      return c.json(ComputerState.parse(await service.refresh(userId)));
    });

    app.post("/api/computer/take", async (c) => c.json(ComputerControlResponse.parse({ computer: await service.take(await owner(c)) })));

    app.post("/api/computer/release", async (c) => c.json(ComputerControlResponse.parse({ computer: await service.release(await owner(c)) })));

    app.post("/api/computer/sign-in/:requestId", async (c) => {
      const userId = await owner(c);
      const requestId = c.req.param("requestId") ?? "";
      // Parsed here, never logged or echoed: a bad body is a plain 400.
      let raw: unknown;
      try { raw = await c.req.json(); } catch { throw new HttpError(400, "validation_failed", "Enter an email and a password."); }
      const result = await signIn.submit(userId, requestId, raw, (done) => service.carryOn({ ...done, prompt: SIGNED_IN_PROMPT }));
      raw = null;
      return c.json(SignInCardResponse.parse(result));
    });

    // M20: the verification code the site asked for after the password (read raw, never logged).
    app.post("/api/computer/sign-in/:requestId/code", async (c) => {
      const userId = await owner(c);
      const requestId = c.req.param("requestId") ?? "";
      let raw: unknown;
      try { raw = await c.req.json(); } catch { throw new HttpError(400, "validation_failed", "Enter the code the site sent you."); }
      const result = await signIn.code(userId, requestId, raw, (done) => service.carryOn({ ...done, prompt: SIGNED_IN_PROMPT }));
      raw = null;
      return c.json(SignInCardResponse.parse(result));
    });

    // M20: "Take control instead": the user signs in themselves; the assistant carries on after the hand back.
    app.post("/api/computer/sign-in/:requestId/take-over", async (c) => {
      const userId = await owner(c);
      return c.json(SignInCardResponse.parse(await signIn.takeOver(userId, c.req.param("requestId") ?? "")));
    });

    // M20: "Not now": the card closes and the assistant carries on, told the user didn't sign in.
    app.post("/api/computer/sign-in/:requestId/dismiss", async (c) => {
      const userId = await owner(c);
      const result = await signIn.dismiss(userId, c.req.param("requestId") ?? "", (done) => service.carryOn({ ...done, prompt: DISMISSED_PROMPT }));
      return c.json(SignInCardResponse.parse(result));
    });

    // M20: close the browser now (409 computer_busy while the assistant uses it or the user is in control).
    app.post("/api/computer/sleep", async (c) => c.json(ComputerControlResponse.parse({ computer: await service.sleep(await owner(c)) })));

    // M27 browser: the full-screen view's own tab strip and address bar. Reading works at any time;
    // acting only after Take over (409 take_over_first). A tab id the computer never gave is a tab
    // that isn't there (404), whatever it looks like.
    const tabId = (c: Context<AppEnv>) => {
      const id = c.req.param("tabId") ?? "";
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new HttpError(404, "not_found", "That tab has closed.");
      return id;
    };
    app.get("/api/computer/tabs", async (c) => {
      await owner(c);
      return c.json(BrowserBar.parse(await service.browserBar()));
    });
    app.post("/api/computer/tabs", async (c) => {
      const userId = await owner(c);
      const body = await readJson(c, NewTabRequest);
      return c.json(BrowserBar.parse(await service.browserAct(userId, { kind: "new", ...(body.address ? { address: body.address } : {}) })));
    });
    app.post("/api/computer/tabs/:tabId/activate", async (c) => {
      const userId = await owner(c);
      return c.json(BrowserBar.parse(await service.browserAct(userId, { kind: "activate", tabId: tabId(c) })));
    });
    app.post("/api/computer/tabs/:tabId/close", async (c) => {
      const userId = await owner(c);
      return c.json(BrowserBar.parse(await service.browserAct(userId, { kind: "close", tabId: tabId(c) })));
    });
    app.post("/api/computer/navigate", async (c) => {
      const userId = await owner(c);
      const body = await readJson(c, NavigateRequest);
      return c.json(BrowserBar.parse(await service.browserAct(userId, "address" in body ? { kind: "navigate", address: body.address } : { kind: body.action })));
    });

    app.get("/api/computer/stream", async (c) => {
      const userId = await owner(c);
      const server = bunServer(c);
      if (!server || c.req.header("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(400, "validation_failed", "Expected a WebSocket upgrade.");
      if (!server.upgrade(c.req.raw, { data: streamData(userId, c.get("session").id) })) throw new HttpError(400, "validation_failed", "Expected a WebSocket upgrade.");
      // Bun ignores the response of an upgraded request.
      return new Response(null);
    });

    app.get("/api/computer/tools", async (c) => c.json(await toolsDetail(policy, await toolsUser(c))));

    app.put("/api/computer/policy", async (c) => {
      const userId = await toolsUser(c);
      const body = await readJson(c, UpdatePolicyRequest);
      if (body.tool === null) {
        await policy.setToolkit(userId, COMPUTER_TOOLKIT, body.mode, POLICY_TOOLS);
      } else {
        if (!(POLICY_TOOLS as readonly string[]).includes(body.tool)) throw new HttpError(400, "validation_failed", "tool: not a tool of OpenDuet's computer", "tool");
        const slug = body.tool as PolicyTool;
        const blocked = body.mode === "always" ? alwaysBlockedFor({ slug, toolkit: COMPUTER_TOOLKIT, defaultMode: TOOL_INFO[slug].defaultMode }) : null;
        if (blocked) throw alwaysNotAllowed(blocked);
        await policy.setTool(userId, body.tool, body.mode);
      }
      return c.json(await toolsDetail(policy, userId));
    });
  };
}
