// ToolPolicy (L106, L167): the user's Ask / Always choice per tool, or for a whole toolkit ("All
// tools"), over the default from classify.ts. Enforced on the server for every call the agent
// makes; Composio meta tools never get a mode (they are refused before policy is looked at).
import type { z } from "zod";
import type { PolicyMode } from "../contract/connectors.ts";
import type { Db } from "../db.ts";
import { isMetaTool } from "../composio/names.ts";
import { classify, defaultMode, type ToolFacts } from "./classify.ts";
import { alwaysBlockedFor } from "./floor.ts";

export type Mode = z.infer<typeof PolicyMode>;

/** ToolPolicy.toolSlug of a toolkit-wide choice; tool slugs are uppercase, so this can't collide. */
export const toolkitKey = (toolkit: string) => `toolkit:${toolkit.toLowerCase()}`;

const asMode = (value: string | undefined): Mode | null => (value === "ask" || value === "always" ? value : null);

export class PolicyService {
  constructor(private readonly db: Db) {}

  /**
   * The modes of these tools for the user: tool row > toolkit row > default by classification.
   * M20 safety floor: "always" on a tool whose Always is blocked (policy/floor.ts: payments,
   * credentials, security settings, sends to other people) reads as "ask", wherever it came from
   * (a tool row or the toolkit's "All tools" stored before M20); nothing is migrated.
   */
  async modes(userId: string, tools: readonly ToolFacts[]): Promise<Map<string, Mode>> {
    const keys = [...new Set(tools.flatMap((t) => [t.slug, ...(t.toolkit ? [toolkitKey(t.toolkit)] : [])]))];
    const rows = keys.length ? await this.db.toolPolicy.findMany({ where: { userId, toolSlug: { in: keys } } }) : [];
    const stored = new Map(rows.map((r) => [r.toolSlug, r.mode]));
    const out = new Map<string, Mode>();
    for (const tool of tools) {
      if (isMetaTool(tool.slug)) { out.set(tool.slug, "ask"); continue; }
      const mode = asMode(stored.get(tool.slug))
        ?? (tool.toolkit ? asMode(stored.get(toolkitKey(tool.toolkit))) : null)
        ?? tool.defaultMode
        ?? defaultMode(classify(tool));
      out.set(tool.slug, mode === "always" && alwaysBlockedFor(tool) !== null ? "ask" : mode);
    }
    return out;
  }

  async mode(userId: string, tool: ToolFacts): Promise<Mode> {
    return (await this.modes(userId, [tool])).get(tool.slug) ?? "ask";
  }

  /** One tool's mode. */
  async setTool(userId: string, slug: string, mode: Mode): Promise<void> {
    if (isMetaTool(slug)) throw new Error("meta tools have no policy");
    await this.db.toolPolicy.upsert({ where: { userId_toolSlug: { userId, toolSlug: slug } }, create: { userId, toolSlug: slug, mode }, update: { mode } });
  }

  /**
   * "All tools": one mode for the whole toolkit; the per-tool choices of these tools are cleared.
   * An "always" here skips the floor / per-recipient tools: modes() reads them as "ask".
   */
  async setToolkit(userId: string, toolkit: string, mode: Mode, toolSlugs: readonly string[]): Promise<void> {
    const key = toolkitKey(toolkit);
    await this.db.$transaction([
      this.db.toolPolicy.deleteMany({ where: { userId, toolSlug: { in: [...toolSlugs] } } }),
      this.db.toolPolicy.upsert({ where: { userId_toolSlug: { userId, toolSlug: key } }, create: { userId, toolSlug: key, mode }, update: { mode } }),
    ]);
  }
}
