// M23 (#27, BriefInfo): what the server read for a brief or check-in before the model's turn. Gmail
// (sorted by triage.ts) and, for the brief, today's Google Calendar; every source that couldn't be
// read is recorded with why (not connected, its connection expired, the read failed). Never throws:
// a failure is a source it couldn't read, and the brief says so (brief.ts).
import { displayName } from "../composio/names.ts";
import type { ConnectorCatalog } from "../connectors/catalog.ts";
import type { Db } from "../db.ts";
import type { ModelResolver } from "../llm/index.ts";
import { log } from "../log.ts";
import { safeZone } from "../scheduler/slots.ts";
import { localMidnight } from "./gate.ts";
import { readEvents, readMail, type CalendarEvent, type InboxMail } from "./inbox.ts";
import { triage, triageCounts, type TriageMemo, type TriageModel, type TriagePerson, type TriageResult } from "./triage.ts";

export const GMAIL = "gmail";
export const CALENDAR = "googlecalendar";
/** Mail read per brief / check-in (Gmail returns the newest first). */
export const MAIL_MAX = { brief: 50, checkin: 25 } as const;
/** Triage model calls per run at most; the rest is unsorted (listed as needs you). */
export const MODEL_CALLS_MAX = { brief: 50, checkin: 25 } as const;
const HOUR = 60 * 60 * 1000;

export type ReadMode = "brief" | "checkin";
export type UncheckedReason = "not_connected" | "expired" | "read_failed";
export interface Unchecked { app: string; reason: UncheckedReason }
export interface SortedMail { mail: InboxMail; result: TriageResult }

export interface ServerReads {
  mode: ReadMode;
  /** the window mail was read from */
  since: string;
  /** null when Gmail wasn't read (see unchecked) */
  mail: SortedMail[] | null;
  /** the window held more than was read (Gmail's estimate) */
  mailCapped: { read: number; about: number } | null;
  /** brief only: today's events; null when the calendar wasn't read (see unchecked) */
  events: CalendarEvent[] | null;
  /** sources it couldn't read, Gmail first; the brief's TextPayload.brief.unchecked */
  unchecked: Unchecked[];
  /** ids of the emails (and threads) and events read: a suggestion may name only these (or what the run read) */
  readIds: Set<string>;
  /** display names */
  apps: { mail: string; calendar: string };
}

/** In-memory model verdicts per user and email (a check-in doesn't sort what the brief sorted). */
export class TriageMemos {
  private readonly rows = new Map<string, { at: number; result: TriageResult }>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 3 * 24 * HOUR, private readonly max = 5000) {}

  for(userId: string): TriageMemo {
    return {
      get: (id) => {
        const row = this.rows.get(`${userId}\u0000${id}`);
        return row && this.now() - row.at < this.ttlMs ? row.result : undefined;
      },
      set: (id, result) => {
        const key = `${userId}\u0000${id}`;
        this.rows.delete(key);
        this.rows.set(key, { at: this.now(), result });
        while (this.rows.size > this.max) this.rows.delete(this.rows.keys().next().value!);
      },
    };
  }
}

/**
 * Where the mail window starts. The brief: since the last brief (between 12 and 72 hours back, so a
 * Monday brief covers the weekend; 24 hours the first time). A check-in: since the last check-in or
 * brief, at most 24 hours back (the brief already put the morning's mail in front of the user).
 */
export async function windowStart(db: Db, userId: string, runId: string, mode: ReadMode, now: Date): Promise<Date> {
  const last = await db.run.findFirst({
    where: { userId, id: { not: runId }, kind: { in: mode === "brief" ? ["brief"] : ["checkin", "brief"] }, status: { in: ["completed", "resolved"] } },
    orderBy: { createdAt: "desc" }, select: { startedAt: true, createdAt: true },
  });
  const t = now.getTime();
  const from = last ? (last.startedAt ?? last.createdAt).getTime() : t - 24 * HOUR;
  return mode === "brief" ? new Date(Math.min(t - 12 * HOUR, Math.max(t - 72 * HOUR, from))) : new Date(Math.min(t, Math.max(t - 24 * HOUR, from)));
}

type Connection = "active" | "expired" | "none" | "unknown";

async function connection(catalog: ConnectorCatalog | null, userId: string, toolkit: string): Promise<Connection> {
  if (!catalog) return "none";
  try {
    const mine = (await catalog.accounts(userId)).filter((a) => a.toolkit === toolkit);
    if (mine.some((a) => a.status === "active")) return "active";
    return mine.some((a) => a.status === "expired") ? "expired" : "none";
  } catch {
    return "unknown";
  }
}

/** Not connected (a failed connection never worked either), expired, or the listing failed (Composio unreachable). */
const reasonOf = (c: Connection): UncheckedReason => (c === "expired" ? "expired" : c === "unknown" ? "read_failed" : "not_connected");

const ADDRESS = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** The address most of the mail was sent to (stands in when the Gmail account's own address isn't known). */
export function inboxOwner(mail: readonly { to: string[]; cc: string[] }[]): string {
  const counts = new Map<string, number>();
  for (const m of mail) {
    for (const recipient of [...m.to, ...m.cc]) {
      const address = ADDRESS.exec(recipient)?.[0]?.toLowerCase();
      if (address) counts.set(address, (counts.get(address) ?? 0) + 1);
    }
  }
  let best = "";
  for (const [address, n] of counts) if (!best || n > (counts.get(best) ?? 0)) best = address;
  return best;
}

/** Whose inbox: the user's name, the Gmail account's address, their About-you document (for who matters to them). */
async function personOf(db: Db, catalog: ConnectorCatalog, userId: string, mail: readonly InboxMail[]): Promise<TriagePerson> {
  const [user, doc] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { name: true, firstName: true } }),
    db.memory.findFirst({ where: { userId, channelId: null, kind: "document", archivedAt: null }, orderBy: { updatedAt: "desc" }, select: { text: true } }),
  ]);
  let email = "";
  try {
    const account = (await catalog.accounts(userId)).find((a) => a.toolkit === GMAIL && a.status === "active");
    email = ADDRESS.exec(account?.label ?? "")?.[0]?.toLowerCase() ?? "";
  } catch { /* the most common recipient below */ }
  return { name: user?.name.trim() || user?.firstName.trim() || "", email: email || inboxOwner(mail), ...(doc?.text.trim() ? { about: doc.text } : {}) };
}

/** The user's utility model (else their default; models/resolver.ts), or null. */
async function triageModel(resolver: ModelResolver | null | undefined, userId: string): Promise<TriageModel | null> {
  if (!resolver) return null;
  try {
    const resolved = await resolver.resolve({ userId, channelId: null, role: "utility" });
    return resolved ? { llm: resolved.llm, id: resolved.model.id, thinkingLevel: resolved.thinkingLevel } : null;
  } catch (error) {
    log.warn("triage model unavailable", { userId, error: { name: (error as Error).name } });
    return null;
  }
}

export interface ReadDeps { db: Db; catalog: ConnectorCatalog | null; resolver?: ModelResolver | null; memos: TriageMemos }
export interface ReadInput {
  userId: string;
  runId: string;
  mode: ReadMode;
  now: Date;
  signal?: AbortSignal;
  /** the header pill while a read runs */
  status?: (key: "searching_email" | "checking_calendar") => Promise<void>;
}

const failed = (what: string, input: ReadInput) => (error: unknown) => {
  log.warn(`${what} read failed`, { userId: input.userId, runId: input.runId, error: { name: (error as Error)?.name ?? "Error" } });
  return { ok: false as const, kind: "unavailable" };
};

/** Reads (and sorts) what this brief / check-in needs. Never throws. */
export async function readSources(deps: ReadDeps, input: ReadInput): Promise<ServerReads> {
  const { db, catalog } = deps;
  const { userId, mode, now } = input;
  const apps = { mail: displayName(GMAIL), calendar: displayName(CALENDAR) };
  const since = await windowStart(db, userId, input.runId, mode, now);
  const reads: ServerReads = { mode, since: since.toISOString(), mail: null, mailCapped: null, events: null, unchecked: [], readIds: new Set(), apps };

  const gmail = await connection(catalog, userId, GMAIL);
  if (gmail !== "active" || !catalog) reads.unchecked.push({ app: apps.mail, reason: reasonOf(gmail) });
  else {
    await input.status?.("searching_email");
    const read = await readMail(catalog.gateway, userId, since, MAIL_MAX[mode]).catch(failed("inbox", input));
    if (!read.ok) reads.unchecked.push({ app: apps.mail, reason: "read_failed" });
    else {
      const results = !read.items.length ? [] : await triage(read.items, {
        person: await personOf(db, catalog, userId, read.items), model: await triageModel(deps.resolver, userId), now, maxModelCalls: MODEL_CALLS_MAX[mode], memo: deps.memos.for(userId), ...(input.signal ? { signal: input.signal } : {}),
      });
      reads.mail = read.items.map((mail, i) => ({ mail, result: results[i]! }));
      if (read.estimate !== null && read.items.length >= MAIL_MAX[mode] && read.estimate > read.items.length) reads.mailCapped = { read: read.items.length, about: read.estimate };
      for (const m of read.items) for (const id of [m.id, m.threadId]) if (id) reads.readIds.add(id);
      log.info("mail triaged", { userId, runId: input.runId, mode, mail: read.items.length, ...triageCounts(results) });
    }
  }

  if (mode === "brief") {
    const cal = await connection(catalog, userId, CALENDAR);
    if (cal !== "active" || !catalog) reads.unchecked.push({ app: apps.calendar, reason: reasonOf(cal) });
    else {
      await input.status?.("checking_calendar");
      const user = await db.user.findUnique({ where: { id: userId }, select: { timezone: true } });
      const from = localMidnight(now, safeZone(user?.timezone ?? "UTC"));
      const to = new Date(from.getTime() + 24 * HOUR);
      const read = await readEvents(catalog.gateway, userId, from, to).catch(failed("calendar", input));
      if (!read.ok) reads.unchecked.push({ app: apps.calendar, reason: "read_failed" });
      else {
        reads.events = read.items;
        for (const e of read.items) reads.readIds.add(e.id);
      }
    }
  }
  return reads;
}

/** A source an add_up_next names, as SourceInput (suggestions/source.ts) after parsing. */
export interface NamedSource { app?: string; kind: "email" | "event" | "doc" | "web"; id: string; title: string; at?: string }

const isoOf = (value: string | null | undefined): string | undefined => {
  const t = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};
const clip = (text: string, max: number) => [...text].slice(0, max).join("");

/**
 * A named source this server read (an email or thread of the triaged mail, an event of today's
 * calendar): its app, title and time from the read, not from the model. Null when the server didn't
 * read it (suggestions/create.ts then looks in the run's own record).
 */
export function serverSource(reads: ServerReads | null | undefined, named: NamedSource): (NamedSource & { title: string }) | null {
  if (!reads || !reads.readIds.has(named.id)) return null;
  const mail = reads.mail?.find((m) => m.mail.id === named.id || m.mail.threadId === named.id)?.mail;
  if (mail) return { app: reads.apps.mail, kind: "email", id: named.id, title: clip(mail.subject, 500), ...(isoOf(mail.date) ? { at: isoOf(mail.date)! } : {}) };
  const event = reads.events?.find((e) => e.id === named.id);
  if (event) return { app: reads.apps.calendar, kind: "event", id: named.id, title: clip(event.title, 500), ...(isoOf(event.start) ? { at: isoOf(event.start)! } : {}) };
  return null;
}
