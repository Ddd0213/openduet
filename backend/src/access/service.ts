// What each channel can use (M11): skills, custom connectors and apps (Composio toolkits).
// - The main thread (Everything) can use everything.
// - Else a ChannelAccess row (the channel's own on / off) wins.
// - Else the item's AccessRule.scope (no row = all): all -> on, channels -> off.
// Items created in a channel get scope channels plus an enabled row for that channel; items made on
// the main thread get no rule (all). Apps with no rows stay "all", so nothing changes for existing users.
import type { Db } from "../db.ts";
import { TOOLKIT_SLUG } from "../composio/names.ts";

export type AccessKind = "skill" | "connector" | "app";
export type AccessScope = "all" | "channels";
export interface AccessRef { kind: AccessKind; id: string }

/** What a channel can use right now. `apps` is "all" when no app is restricted for this channel. */
export interface Grant {
  main: boolean;
  skills: Set<string>;
  connectors: Set<string>;
  apps: Set<string> | "all";
  /** whether this toolkit is on here (works with apps = "all" and with toolkits not listed) */
  allowsApp(toolkit: string): boolean;
}

/** Whether a toolkit slug is one the user could use (the catalog knows it). */
export type AppCheck = (userId: string, toolkit: string) => Promise<boolean>;

type Rows = { rules: { kind: string; refId: string; scope: string }[]; overrides: { kind: string; refId: string; enabled: boolean }[] };

/** On / off for one item: the channel's own row, else its scope (no rule = all). */
function decide(rows: Rows, kind: AccessKind, id: string): boolean {
  const own = rows.overrides.find((o) => o.kind === kind && o.refId === id);
  if (own) return own.enabled;
  const rule = rows.rules.find((r) => r.kind === kind && r.refId === id);
  return !rule || rule.scope !== "channels";
}

export class AccessService {
  constructor(private readonly db: Db) {}

  private async rows(userId: string, channelId: string): Promise<Rows> {
    const [rules, overrides] = await Promise.all([
      this.db.accessRule.findMany({ where: { userId }, select: { kind: true, refId: true, scope: true } }),
      this.db.channelAccess.findMany({ where: { userId, channelId }, select: { kind: true, refId: true, enabled: true } }),
    ]);
    return { rules, overrides };
  }

  /** The skills, connectors and apps this channel can use. An unknown or foreign channel gets nothing. */
  async resolve(userId: string, channelId: string): Promise<Grant> {
    const channel = await this.db.channel.findFirst({ where: { id: channelId, userId }, select: { isMain: true } });
    const [skills, connectors] = await Promise.all([
      this.db.skill.findMany({ where: { userId }, select: { id: true } }),
      this.db.customConnector.findMany({ where: { userId }, select: { id: true } }),
    ]);
    if (channel?.isMain) {
      return { main: true, skills: new Set(skills.map((s) => s.id)), connectors: new Set(connectors.map((c) => c.id)), apps: "all", allowsApp: () => true };
    }
    if (!channel) return { main: false, skills: new Set(), connectors: new Set(), apps: new Set(), allowsApp: () => false };
    const rows = await this.rows(userId, channelId);
    const appRules = rows.rules.filter((r) => r.kind === "app");
    const appOverrides = rows.overrides.filter((o) => o.kind === "app");
    const restricted = appRules.some((r) => r.scope === "channels") || appOverrides.some((o) => !o.enabled);
    const allowsApp = (toolkit: string) => decide(rows, "app", toolkit.toLowerCase());
    let apps: Set<string> | "all" = "all";
    if (restricted) {
      // Toolkits with a row are listed; toolkits without one still answer through allowsApp (on).
      apps = new Set([...appRules.map((r) => r.refId), ...appOverrides.map((o) => o.refId)].filter((slug) => decide(rows, "app", slug)));
    }
    return {
      main: false,
      skills: new Set(skills.map((s) => s.id).filter((id) => decide(rows, "skill", id))),
      connectors: new Set(connectors.map((c) => c.id).filter((id) => decide(rows, "connector", id))),
      apps,
      allowsApp,
    };
  }

  /** The item's own default (no rule = all). */
  async scopeOf(userId: string, ref: AccessRef): Promise<AccessScope> {
    const rule = await this.db.accessRule.findUnique({ where: { userId_kind_refId: { userId, kind: ref.kind, refId: ref.id } }, select: { scope: true } });
    return rule?.scope === "channels" ? "channels" : "all";
  }

  /** kind:id -> scope for every rule of the user. */
  async scopes(userId: string): Promise<Map<string, AccessScope>> {
    const rules = await this.db.accessRule.findMany({ where: { userId }, select: { kind: true, refId: true, scope: true } });
    return new Map(rules.map((r) => [`${r.kind}:${r.refId}`, r.scope === "channels" ? "channels" : "all"]));
  }

  /** kind:id -> the channels (live, not main) where it's turned on by a row. */
  async enabledChannels(userId: string, kind: AccessKind): Promise<Map<string, string[]>> {
    const rows = await this.db.channelAccess.findMany({ where: { userId, kind, enabled: true }, select: { channelId: true, refId: true }, orderBy: { createdAt: "asc" } });
    if (!rows.length) return new Map();
    const live = new Set((await this.db.channel.findMany({ where: { userId, id: { in: [...new Set(rows.map((r) => r.channelId))] }, isMain: false }, select: { id: true } })).map((c) => c.id));
    const out = new Map<string, string[]>();
    for (const row of rows) if (live.has(row.channelId)) out.set(row.refId, [...(out.get(row.refId) ?? []), row.channelId]);
    return out;
  }

  async setScope(userId: string, ref: AccessRef, scope: AccessScope): Promise<void> {
    await this.db.accessRule.upsert({
      where: { userId_kind_refId: { userId, kind: ref.kind, refId: ref.id } },
      create: { userId, kind: ref.kind, refId: ref.id, scope },
      update: { scope },
    });
  }

  /** The channel's own on / off for an item (overrides its scope). */
  async setChannel(userId: string, channelId: string, ref: AccessRef, enabled: boolean): Promise<void> {
    await this.db.channelAccess.upsert({
      where: { channelId_kind_refId: { channelId, kind: ref.kind, refId: ref.id } },
      create: { userId, channelId, kind: ref.kind, refId: ref.id, enabled },
      update: { enabled },
    });
  }

  /**
   * A new item: made in a channel -> scope channels + on there; on the main thread (or null) -> no
   * rule (all). Replacing an existing item keeps its scope and only turns it on in that channel.
   */
  async created(userId: string, ref: AccessRef, channelId: string | null, opts: { replaced?: boolean } = {}): Promise<void> {
    if (!channelId) return;
    const channel = await this.db.channel.findFirst({ where: { id: channelId, userId }, select: { isMain: true } });
    if (!channel || channel.isMain) return;
    if (!opts.replaced) await this.setScope(userId, ref, "channels");
    await this.setChannel(userId, channelId, ref, true);
  }

  /** An item was deleted: its rule and every channel's row go with it. */
  async forget(userId: string, ref: AccessRef): Promise<void> {
    await this.db.$transaction([
      this.db.accessRule.deleteMany({ where: { userId, kind: ref.kind, refId: ref.id } }),
      this.db.channelAccess.deleteMany({ where: { userId, kind: ref.kind, refId: ref.id } }),
    ]);
  }

  /**
   * The refs that aren't this user's (unknown skill / connector ids, toolkits the catalog doesn't
   * know or no catalog at all). Empty = all valid.
   */
  async invalid(userId: string, refs: readonly AccessRef[], appKnown: AppCheck | null): Promise<AccessRef[]> {
    const skillIds = refs.filter((r) => r.kind === "skill").map((r) => r.id);
    const connectorIds = refs.filter((r) => r.kind === "connector").map((r) => r.id);
    const [skills, connectors] = await Promise.all([
      skillIds.length ? this.db.skill.findMany({ where: { userId, id: { in: skillIds } }, select: { id: true } }) : [],
      connectorIds.length ? this.db.customConnector.findMany({ where: { userId, id: { in: connectorIds } }, select: { id: true } }) : [],
    ]);
    const known = new Set([...skills.map((s) => `skill:${s.id}`), ...connectors.map((c) => `connector:${c.id}`)]);
    const bad: AccessRef[] = [];
    for (const ref of refs) {
      if (ref.kind === "app") {
        const ok = TOOLKIT_SLUG.test(ref.id) && !!appKnown && (await appKnown(userId, ref.id).catch(() => false));
        if (!ok) bad.push(ref);
      } else if (!known.has(`${ref.kind}:${ref.id}`)) bad.push(ref);
    }
    return bad;
  }
}
