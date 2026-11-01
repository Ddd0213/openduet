// M18c: interest findings in check-ins (share_finding). At most one a day per user, counted in the
// daily proactive cap (the run posts, so it's "completed"), never at proactivity low. What the
// model sees of earlier findings comes from their RunStep rows (tool share_finding, status ok).
import type { Db } from "../db.ts";
import { asProactivity, localMidnight } from "./gate.ts";

export const FINDING_TOOL = "share_finding";
/** How many earlier findings the check-in instructions list (newest first). */
export const RECENT_FINDINGS = 7;
/** How much of an earlier finding's text they show. */
export const FINDING_CLIP = 200;
/** Resolved tasks updated within this long still count as something the user follows. */
export const FOLLOWS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const FOLLOWS_MAX = 20;

const OPEN = ["working", "needs_input", "ready_for_review", "scheduled"];

/** Why share_finding can't post now (null = it may), from the user's level and today's findings. */
export async function findingRefusal(db: Db, userId: string, runId: string, now: Date): Promise<string | null> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { proactivity: true, timezone: true } });
  if (asProactivity(user.proactivity) === "low") return "The user asked to hear from you only when something needs them (level low); a finding never does. Share nothing.";
  const today = await db.runStep.count({
    where: {
      tool: FINDING_TOOL, status: "ok", runId: { not: runId },
      run: { userId, kind: "checkin", startedAt: { gte: localMidnight(now, user.timezone) } },
    },
  });
  if (today > 0) return "You already shared a finding today; at most one a day. Share nothing more today.";
  return null;
}

const clip = (text: string, max: number) => {
  const chars = [...text.trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

/** The text of the user's newest findings (newest first); a step whose input doesn't parse is skipped. */
export async function recentFindings(db: Db, userId: string): Promise<string[]> {
  const steps = await db.runStep.findMany({
    where: { tool: FINDING_TOOL, status: "ok", run: { userId } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: RECENT_FINDINGS, select: { input: true },
  });
  return steps.flatMap((step) => {
    try {
      const value: unknown = JSON.parse(step.input ?? "");
      const text = value !== null && typeof value === "object" ? (value as Record<string, unknown>).text : undefined;
      return typeof text === "string" && text.trim() ? [clip(text, FINDING_CLIP)] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Titles of what the user follows: non-archived tasks and scheduled tasks, open ones plus resolved
 * ones updated in the last 14 days, newest first, deduplicated, at most 20.
 */
export async function followedTitles(db: Db, userId: string, now: Date): Promise<string[]> {
  const rows = await db.task.findMany({
    where: {
      userId, archivedAt: null,
      OR: [{ status: { in: OPEN } }, { status: "resolved", updatedAt: { gte: new Date(now.getTime() - FOLLOWS_WINDOW_MS) } }],
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: FOLLOWS_MAX * 3, select: { title: true },
  });
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const { title } of rows) {
    const key = title.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    titles.push(title.trim());
    if (titles.length === FOLLOWS_MAX) break;
  }
  return titles;
}

/** A link title for [title](url): brackets and backslashes escaped. */
const linkTitle = (title: string) => title.replace(/[\\[\]]/g, (c) => `\\${c}`);
/** A link target for [title](url): parentheses and spaces percent-encoded, so "(...)" in a URL can't end the link early. */
const linkUrl = (url: string) => url.replace(/[() ]/g, (c) => ({ "(": "%28", ")": "%29", " ": "%20" })[c]!);

/** The posted text: the finding, a blank line, then "Sources: [a](u) · [b](v)". */
export function findingText(text: string, sources: { title: string; url: string }[], label: string): string {
  return `${text}\n\n${label} ${sources.map((s) => `[${linkTitle(s.title)}](${linkUrl(s.url)})`).join(" · ")}`;
}
