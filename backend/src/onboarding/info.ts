// GET /api/onboarding (L77): page 2's chips from the user's real setup (connected apps by display
// name, channels, skills); with fewer than three, common toolkits of the server's Composio catalog
// fill the rows. Page 5's Slack row: whether the user has a connected Slack account.
// POST /api/onboarding/complete: sets onboardedAt once and starts the first-day scan.
import type { User } from "@prisma/client";
import type { z } from "zod";
import type { ConnectorCatalog } from "../connectors/catalog.ts";
import type { OnboardingChip, OnboardingInfo } from "../contract/auth.ts";
import { displayName } from "../composio/names.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";

type Chip = z.infer<typeof OnboardingChip>;

/** Below this many chips the catalog fills in; filling stops at FILL_TO. */
export const MIN_CHIPS = 3;
export const FILL_TO = 6;
/** The catalog toolkits tried first when filling (the apps the spec names), then the rest in catalog order. */
export const COMMON_TOOLKITS = ["gmail", "googlecalendar", "googledrive", "slack", "notion", "googledocs", "github", "hubspot", "stripe"];

export async function onboardingInfo(db: Db, catalog: ConnectorCatalog | null, userId: string): Promise<z.infer<typeof OnboardingInfo>> {
  const chips: Chip[] = [];
  let slack = false;
  const shown = new Set<string>();
  if (catalog) {
    try {
      const active = (await catalog.accounts(userId)).filter((a) => a.status === "active");
      slack = active.some((a) => a.toolkit === "slack");
      for (const toolkit of new Set(active.map((a) => a.toolkit))) {
        chips.push({ kind: "app", label: await catalog.name(toolkit), toolkit });
        shown.add(toolkit);
      }
    } catch (error) {
      log.warn("onboarding: connected accounts unavailable", { error: { name: (error as Error).name } });
    }
  }
  const channels = await db.channel.findMany({ where: { userId, archived: false, isMain: false }, orderBy: { createdAt: "asc" }, select: { name: true } });
  for (const channel of channels) if (channel.name.trim()) chips.push({ kind: "channel", label: channel.name });
  const skills = await db.skill.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, select: { name: true } });
  for (const skill of skills) chips.push({ kind: "skill", label: skill.name });

  if (catalog && chips.length < MIN_CHIPS) {
    try {
      const toolkits = await catalog.toolkits();
      const rank = (slug: string) => { const i = COMMON_TOOLKITS.indexOf(slug); return i === -1 ? COMMON_TOOLKITS.length : i; };
      const ordered = toolkits.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t.slug) - rank(b.t.slug) || a.i - b.i).map(({ t }) => t);
      for (const toolkit of ordered) {
        if (chips.length >= FILL_TO) break;
        if (shown.has(toolkit.slug)) continue;
        chips.push({ kind: "app", label: displayName(toolkit.slug, toolkit.name), toolkit: toolkit.slug });
        shown.add(toolkit.slug);
      }
    } catch (error) {
      log.warn("onboarding: catalog unavailable", { error: { name: (error as Error).name } });
    }
  }
  return { chips, slack: { connected: slack } };
}

export interface FirstDayStarter {
  /** queues the first-day scan; false = not started (the server is shutting down) */
  startFirstDayScan(userId: string, onboardedAt: Date): Promise<boolean>;
}

/**
 * Marks the user onboarded the first time only (a conditional update, so two parallel calls can't
 * both start a scan) and starts the first-day scan in the background. Later calls change nothing.
 */
export async function completeOnboarding(db: Db, scans: FirstDayStarter, userId: string): Promise<{ user: User; scanStarted: boolean }> {
  const at = new Date();
  const claimed = await db.user.updateMany({ where: { id: userId, onboardedAt: null }, data: { onboardedAt: at } });
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (claimed.count !== 1 || !user.onboardedAt) return { user, scanStarted: false };
  let started = false;
  try {
    started = await scans.startFirstDayScan(userId, user.onboardedAt);
  } finally {
    // Not queued (shutting down, or it threw): undo the claim so the next call starts the scan.
    if (!started) await db.user.updateMany({ where: { id: userId, onboardedAt: at }, data: { onboardedAt: null } });
  }
  if (!started) return { user: await db.user.findUniqueOrThrow({ where: { id: userId } }), scanStarted: false };
  return { user, scanStarted: true };
}
