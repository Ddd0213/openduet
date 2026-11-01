// M23 (#27, review-harness P1-1): the server reads the user's Gmail and Google Calendar itself
// before a brief or check-in reaches the model, through the Composio gateway (read tools only), so
// triage sorts the same mail the brief talks about and a read that failed is known in code, not
// left to the model to mention. The parsing is lenient: Composio's Gmail tools return flattened
// fields (messageId, sender, messageTimestamp, labelIds, messageText, preview) and, with the
// payload, Gmail's headers as [{name, value}]; whatever is missing reads as empty.
import type { ComposioGateway } from "../composio/gateway.ts";
import type { TriageMail } from "./triage.ts";

export const GMAIL_FETCH = "GMAIL_FETCH_EMAILS";
export const CALENDAR_LIST = "GOOGLECALENDAR_EVENTS_LIST";
/** The headers triage reads; the rest are dropped. */
const KEPT_HEADERS = ["list-unsubscribe", "list-id", "precedence", "auto-submitted", "x-auto-response-suppress"];
/** How much of each body is kept (triage reads at most BODY_LIMIT of it). */
const BODY_KEEP = 2000;

export interface InboxMail extends TriageMail { threadId: string }
export interface CalendarEvent { id: string; title: string; start: string; end: string; location: string | null }

export type Read<T> = { ok: true; items: T[]; estimate: number | null } | { ok: false; kind: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const clip = (text: string, max: number) => [...text].slice(0, max).join("");

/** "A <a@x>, \"B, Jr.\" <b@x>" -> two addresses; arrays and {email} objects too. */
export function addressList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(addressList);
  if (isObj(value)) return addressList(value.email ?? value.address ?? "");
  const text = str(value);
  const out: string[] = [];
  let depth = 0, quoted = false, current = "";
  for (const c of text) {
    if (c === "\"") quoted = !quoted;
    else if (c === "<") depth++;
    else if (c === ">") depth = Math.max(0, depth - 1);
    if (c === "," && !quoted && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Gmail's payload.headers ([{name, value}]) or a flat {name: value}, by lower-case name. */
function headersOf(raw: Obj): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (name: unknown, value: unknown) => { if (typeof name === "string" && name) out[name.toLowerCase()] = str(value); };
  const payload = isObj(raw.payload) ? raw.payload : null;
  for (const list of [payload?.headers, raw.headers]) {
    if (Array.isArray(list)) {
      for (const h of list) if (isObj(h)) add(h.name, h.value);
    } else if (isObj(list)) {
      for (const [name, value] of Object.entries(list)) add(name, value);
    }
  }
  return out;
}

function dateOf(raw: Obj, headers: Record<string, string>): string | null {
  const internal = Number(str(raw.internalDate));
  const candidates = [str(raw.messageTimestamp), str(raw.date), headers.date ?? "", Number.isFinite(internal) && internal > 0 ? new Date(internal).toISOString() : ""];
  for (const c of candidates) {
    const t = Date.parse(c);
    if (c && !Number.isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

/** The list in a tool result: `{messages}` / `{items}` at the top, under `data` / `response_data`, or the array itself. */
function listIn(data: unknown, key: string): { list: unknown[]; estimate: number | null } {
  const levels = [data, isObj(data) ? data.data : undefined, isObj(data) ? data.response_data : undefined];
  for (const level of levels) {
    if (Array.isArray(level)) return { list: level, estimate: null };
    if (isObj(level) && Array.isArray(level[key])) {
      const estimate = Number(level.resultSizeEstimate);
      return { list: level[key] as unknown[], estimate: Number.isFinite(estimate) && estimate >= 0 ? estimate : null };
    }
  }
  return { list: [], estimate: null };
}

/** Gmail fetch results as triage mail (entries without an id are dropped). */
export function parseMail(data: unknown): { items: InboxMail[]; estimate: number | null } {
  const { list, estimate } = listIn(data, "messages");
  const items = list.flatMap((entry): InboxMail[] => {
    if (!isObj(entry)) return [];
    const id = str(entry.messageId) || str(entry.id);
    if (!id) return [];
    const all = headersOf(entry);
    const headers = Object.fromEntries(Object.entries(all).filter(([name]) => KEPT_HEADERS.includes(name)));
    const preview = isObj(entry.preview) ? str(entry.preview.body) : str(entry.preview);
    const body = str(entry.messageText) || preview || str(entry.snippet) || str(entry.body);
    const labels = Array.isArray(entry.labelIds) ? entry.labelIds : Array.isArray(entry.labels) ? entry.labels : [];
    return [{
      id, threadId: str(entry.threadId),
      from: str(entry.sender) || str(entry.from) || (all.from ?? ""),
      to: addressList(entry.to || all.to || ""), cc: addressList(entry.cc || all.cc || ""),
      subject: str(entry.subject) || (all.subject ?? ""),
      date: dateOf(entry, all), headers, labels: labels.filter((l): l is string => typeof l === "string"),
      body: clip(body, BODY_KEEP),
    }];
  });
  return { items, estimate };
}

/** The inbox since `since`, newest first, at most `max` (Gmail search syntax: after: takes epoch seconds). */
export async function readMail(gateway: ComposioGateway, userId: string, since: Date, max: number): Promise<Read<InboxMail>> {
  const result = await gateway.execute(userId, GMAIL_FETCH, {
    query: `in:inbox after:${Math.floor(since.getTime() / 1000)}`, max_results: max, include_payload: true,
  });
  if (!result.ok) return { ok: false, kind: result.kind };
  const { items, estimate } = parseMail(result.data);
  return { ok: true, items: items.slice(0, max), estimate };
}

const timeOf = (value: unknown): string => {
  if (isObj(value)) return str(value.dateTime) || str(value.date);
  return str(value);
};

/** Calendar list results (cancelled events and entries without an id are dropped). */
export function parseEvents(data: unknown): CalendarEvent[] {
  const found = listIn(data, "items").list.length ? listIn(data, "items") : listIn(data, "events");
  return found.list.flatMap((entry): CalendarEvent[] => {
    if (!isObj(entry) || str(entry.status) === "cancelled") return [];
    const id = str(entry.id);
    if (!id) return [];
    return [{
      id, title: clip(str(entry.summary) || str(entry.title), 200), start: timeOf(entry.start), end: timeOf(entry.end),
      location: str(entry.location) ? clip(str(entry.location), 200) : null,
    }];
  });
}

/** Events between `from` and `to` on the primary calendar. */
export async function readEvents(gateway: ComposioGateway, userId: string, from: Date, to: Date): Promise<Read<CalendarEvent>> {
  const result = await gateway.execute(userId, CALENDAR_LIST, {
    calendarId: "primary", timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true,
  });
  if (!result.ok) return { ok: false, kind: result.kind };
  return { ok: true, items: parseEvents(result.data).slice(0, 50), estimate: null };
}
