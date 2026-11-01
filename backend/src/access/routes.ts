// GET / PUT /api/channels/:id/access and PUT /api/access/scope (M11): what a channel can use.
// GET lists every skill, every custom connector and the apps with an active connected account,
// sorted by name within each kind; the main thread shows everything enabled (PUT there is 400).
import type { Context } from "hono";
import type { AppEnv, RegisterRoutes } from "../app.ts";
import { ChannelAccess, UpdateAccessScopeRequest, UpdateChannelAccessRequest } from "../contract/m11.ts";
import { HttpError, readJson } from "../http.ts";
import { log } from "../log.ts";
import { ownChannel } from "../routes/channels.ts";
import { channelHooks } from "../channels/hooks.ts";
import type { AccessKind, AccessRef, AccessService } from "./service.ts";

const KIND_ORDER: Record<AccessKind, number> = { skill: 0, connector: 1, app: 2 };

export async function channelAccess(c: Context<AppEnv>, access: AccessService, channel: { id: string; userId: string; isMain: boolean }) {
  const { db } = c.get("deps");
  const userId = channel.userId;
  const [skills, connectors, grant, scopes] = await Promise.all([
    db.skill.findMany({ where: { userId }, select: { id: true, name: true, description: true } }),
    db.customConnector.findMany({ where: { userId }, select: { id: true, name: true, description: true } }),
    access.resolve(userId, channel.id),
    access.scopes(userId),
  ]);
  let apps: { toolkit: string; name: string; description: string }[] = [];
  const connected = channelHooks(db).connectedApps;
  if (connected) {
    try {
      apps = await connected(userId);
    } catch (error) {
      // The apps service being down hides the apps here; skills and connectors still show.
      log.warn("connected apps unavailable for the access list", { error: { name: (error as Error)?.name ?? "Error" } });
    }
  }
  const scope = (kind: AccessKind, id: string) => scopes.get(`${kind}:${id}`) ?? "all";
  const items = [
    ...skills.map((s) => ({ kind: "skill" as const, id: s.id, name: s.name, description: s.description, scope: scope("skill", s.id), enabled: grant.skills.has(s.id) })),
    ...connectors.map((x) => ({ kind: "connector" as const, id: x.id, name: x.name, description: x.description, scope: scope("connector", x.id), enabled: grant.connectors.has(x.id) })),
    ...apps.map((a) => ({ kind: "app" as const, id: a.toolkit, name: a.name, description: a.description, scope: scope("app", a.toolkit), enabled: grant.allowsApp(a.toolkit) })),
  ];
  items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return ChannelAccess.parse({ channelId: channel.id, items });
}

/** 400 validation_failed (field `field`) when a ref isn't one of this user's items. */
export async function checkRefs(c: Context<AppEnv>, access: AccessService, refs: readonly AccessRef[], field: string): Promise<void> {
  if (!refs.length) return;
  const { db } = c.get("deps");
  const bad = await access.invalid(c.get("user").id, refs, channelHooks(db).appKnown);
  if (bad.length) throw new HttpError(400, "validation_failed", `${field}: unknown ${bad[0]!.kind} ${bad[0]!.id}`, field);
}

export function registerAccessRoutes(access: AccessService): RegisterRoutes {
  return (app) => {
    app.get("/api/channels/:id/access", async (c) => c.json(await channelAccess(c, access, await ownChannel(c))));

    app.put("/api/channels/:id/access", async (c) => {
      const channel = await ownChannel(c);
      const input = await readJson(c, UpdateChannelAccessRequest);
      if (channel.isMain) throw new HttpError(400, "validation_failed", "id: the main thread can always use everything", "id");
      await checkRefs(c, access, input.changes, "changes");
      for (const change of input.changes) await access.setChannel(channel.userId, channel.id, { kind: change.kind, id: change.id }, change.enabled);
      return c.json(await channelAccess(c, access, channel));
    });

    app.put("/api/access/scope", async (c) => {
      const input = await readJson(c, UpdateAccessScopeRequest);
      await checkRefs(c, access, [input.ref], "ref");
      await access.setScope(c.get("user").id, input.ref, input.scope);
      return c.body(null, 204);
    });
  };
}
