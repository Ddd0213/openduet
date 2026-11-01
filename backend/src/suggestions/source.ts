// M23: where something the assistant wrote in the background came from (an Up next suggestion, a memory
// fact): the email / event / doc / page it read. Stored as JSON next to the row (Suggestion.sourceRef,
// Memory.sourceRef) with the opaque id; the API only ever sends the public part (SourceRef in
// contract/m23.ts: app, kind, title, at), never the id.
//
// "Read this turn" is decided from the run's own record (RunStep, runs/steps.ts): a step of this
// run that ended ok, of the same app (an app tool through execute_app_tools; for kind "web" a page
// read with web_fetch / the browser), whose stored input or output contains the id. The model can
// name a source; it can't make one up.
import { z } from "zod";
import { SourceRef } from "../contract/m23.ts";
import type { Db } from "../db.ts";
import { COMPUTER_APP } from "../runs/describe.ts";

/** The source a tool names: the app's display name, what it is, its id in that app, its title, its time. */
export const SourceInput = z.object({
  /** the app's display name as the app tools return it ("Gmail"); leave out for a web page */
  app: z.string().trim().min(1).max(60).optional(),
  kind: z.enum(["email", "event", "doc", "web"]),
  /** the email / event / doc id from the tool result (a web page: its URL) */
  id: z.string().trim().min(1).max(512),
  /** the email subject, event title, doc or page title */
  title: z.string().trim().max(500).default(""),
  /** when the email was received / the event starts (ISO 8601 with offset) */
  at: z.iso.datetime({ offset: true }).optional(),
}).strict();
export type SourceInput = z.input<typeof SourceInput>;

/** What the database keeps (JSON): the public SourceRef plus the server-only id. */
export interface StoredSource {
  app: string | null;
  kind: "email" | "event" | "doc" | "chat" | "web";
  id: string;
  title: string;
  at: string | null;
}

const Stored = z.object({
  app: z.string().nullable().catch(null),
  kind: z.enum(["email", "event", "doc", "chat", "web"]),
  id: z.string().catch(""),
  title: z.string().catch(""),
  at: z.string().nullable().catch(null),
});

/** The tools whose step records a page read (kind "web"). */
const PAGE_TOOLS = ["web_fetch", "computer_navigate", "computer_read"];
/** Ids shorter than this are too likely to appear in any output by chance; they never count as read. */
export const MIN_SOURCE_ID = 6;
/** Step writes are queued (runs/steps.ts), so a read that just finished may still be on its way. */
const READ_RETRIES = [0, 40, 120];

const clipChars = (text: string, max: number) => {
  const chars = [...text.trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

/** A named source as stored: title clipped to the contract's 200, app as given (or null for the web). */
export function toStored(source: z.output<typeof SourceInput>, app: string | null = source.app ?? null): StoredSource {
  return { app: source.kind === "web" ? null : app, kind: source.kind, id: source.id.trim(), title: clipChars(source.title, 200), at: source.at ?? null };
}

export function storeSource(source: StoredSource | null): string | null {
  return source ? JSON.stringify(source) : null;
}

/** The stored source (null when absent or unreadable). */
export function parseStored(raw: string | null | undefined): StoredSource | null {
  if (!raw) return null;
  try {
    const parsed = Stored.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The public part for the API (no id); null when absent or it doesn't match the contract. */
export function publicSourceRef(raw: string | null | undefined): SourceRef | null {
  const stored = parseStored(raw);
  if (!stored) return null;
  const at = stored.at && z.iso.datetime({ offset: true }).safeParse(stored.at).success ? new Date(stored.at).toISOString() : null;
  const parsed = SourceRef.safeParse({ app: stored.app && stored.app.trim() ? stored.app : null, kind: stored.kind, title: clipChars(stored.title, 200), at });
  return parsed.success ? parsed.data : null;
}

const sameApp = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const noSlash = (url: string) => url.replace(/\/+$/, "");

/**
 * Whether this run read the source: the app's display name as the record has it ("Gmail"; null for
 * a page), or undefined when it didn't. An id shorter than MIN_SOURCE_ID never counts.
 */
export async function readInRun(db: Db, runId: string, source: Pick<StoredSource, "app" | "kind" | "id">): Promise<{ app: string | null } | undefined> {
  const id = source.id.trim();
  if ([...id].length < MIN_SOURCE_ID) return undefined;
  const web = source.kind === "web";
  const needles = web ? [...new Set([id, noSlash(id)])].filter((n) => n.length >= MIN_SOURCE_ID) : [id];
  for (const wait of READ_RETRIES) {
    if (wait) await Bun.sleep(wait);
    const steps = await db.runStep.findMany({
      where: { runId, kind: "tool", status: "ok", ...(web ? { tool: { in: PAGE_TOOLS } } : { app: { not: null } }) },
      select: { app: true, input: true, output: true },
    });
    for (const step of steps) {
      if (!web) {
        if (!step.app || step.app === COMPUTER_APP) continue;
        if (source.app && !sameApp(step.app, source.app)) continue;
      }
      const text = `${step.input ?? ""}\n${step.output ?? ""}`;
      if (needles.some((n) => text.includes(n))) return { app: web ? null : step.app };
    }
  }
  return undefined;
}
