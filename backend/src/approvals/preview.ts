// What an approval card shows (L157, L182): emails as to / cc / subject / body / attachments,
// sign / delete / every other "ask" tool as labelled rows. Never raw JSON. Also which preview
// fields an edit by chat changed (Approval.changedFields: the card glows them for ~3 s).
// Rows: nested arguments open into rows of their own (a Notion page's title, its content); rows
// that name the thing come first, long text last and whole up to MAX_BODY.
import { convert } from "html-to-text";
import type { z } from "zod";
import type { ApprovalKind, ApprovalPreview } from "../contract/approvals.ts";

/** What builders hand in (z.input: fields with a default, such as M20's `browser`, may be left out). */
export type Preview = z.input<typeof ApprovalPreview>;
type Kind = Exclude<z.infer<typeof ApprovalKind>, "payment">;

export interface PreviewInput {
  kind: Kind;
  /** display name of the app ("Gmail") */
  app: string;
  /** human name of the tool ("Send email") */
  toolName: string;
  args: Record<string, unknown>;
}

const MAX_ROWS = 20;
/** A short value (an id, a name, a date): cut at a word with "…" past this. */
const MAX_VALUE = 500;
/** Long text (an email body, a page's content, anything with a line break). */
const MAX_BODY = 20_000;
/** How deep nested arguments open into rows of their own; deeper ones read as one line. */
const MAX_DEPTH = 4;
/** Plumbing arguments that mean nothing to the user. */
const HIDDEN = new Set(["user_id", "userId"]);
/** Labels of the rows that name the thing: shown first. */
const TITLE_LABELS = new Set(["Title", "Name", "Subject", "Summary"]);
/** A label ending in one of these words holds long text: shown last, kept up to MAX_BODY. */
const BODY_WORDS = new Set(["content", "body", "description", "text", "markdown", "message"]);

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === "string" && v.trim() ? v.split(/[,;]\s*/).filter(Boolean) : []);
const pick = (args: Record<string, unknown>, keys: string[]) => keys.map((k) => args[k]).find((v) => v !== undefined && v !== null && v !== "");

/** "recipient_email" -> "Recipient email"; "startDateTime" -> "Start date time". */
export function humanLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

type Json = Record<string, unknown>;
/** 0: names the thing, 1: another short value, 2: long text. */
type Ranked = { label: string; value: string; rank: 0 | 1 | 2 };
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
/** The entries a card shows: no blanks, no plumbing ("user_id": "me"). */
const shown = (o: Json) => Object.entries(o).filter(([k, v]) => v !== null && v !== undefined && v !== "" && !(HIDDEN.has(k) && (v === "me" || v === "")));
/** "Pages" + "Title" -> "Pages title". */
const join = (parent: string, label: string) => `${parent} ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
/** Multi-line text loses blank lines on top and trailing space; one line is trimmed. */
const tidy = (text: string) => (text.includes("\n") ? text.replace(/^\s*\n/, "").trimEnd() : text.trim());

/** At most `max` characters, cut at a line break or a word with "…"; mid-word only without spaces (CJK). */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let head = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  if (/\s/.test(text.charAt(head.length))) return `${head.trimEnd()}…`;
  const line = head.lastIndexOf("\n");
  const word = head.search(/\s\S*$/);
  const cut = line > max * 0.8 ? line : word > max * 0.6 ? word : head.length;
  return `${head.slice(0, cut).trimEnd()}…`;
}

/** A rich-text piece (Notion, Slack): its words are its plain text. */
const isRichText = (v: unknown): boolean =>
  isRecord(v) && (typeof v.plain_text === "string" || (isRecord(v.text) && typeof v.text.content === "string") || (v.type === "text" && typeof v.text === "string"));

/** A property's value as plain text: rich text, a select's name, a typed wrapper's payload. */
function plainText(v: unknown, depth = 0): string {
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (depth > MAX_DEPTH) return "";
  if (Array.isArray(v)) return v.map((x) => plainText(x, depth + 1)).filter(Boolean).join(v.every(isRichText) ? "" : ", ");
  if (!isRecord(v)) return "";
  for (const key of ["plain_text", "content", "text", "name", "title", "value"]) {
    const text = v[key] === undefined || v[key] === null ? "" : plainText(v[key], depth + 1);
    if (text) return text;
  }
  // A typed wrapper ({ type: "select", select: {…} }) or one key ({ number: 3 }).
  const typed = typeof v.type === "string" ? v[v.type] : undefined;
  if (typed !== undefined && typed !== null) return plainText(typed, depth + 1);
  const rest = shown(v).filter(([k]) => k !== "type");
  const only = rest.length === 1 ? rest[0] : undefined;
  return only ? plainText(only[1], depth + 1) : "";
}

/** One line: "a, b" for a list, "Use default: No; Minutes: 10" for a small object. */
function inline(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.every(isRichText) ? plainText(v) : v.map((x) => inline(x, depth + 1)).filter(Boolean).join(", ");
  if (isRecord(v) && depth < 2) {
    if (isRichText(v)) return plainText(v);
    return shown(v).map(([k, x]) => { const text = inline(x, depth + 1); return text ? `${humanLabel(k)}: ${text}` : ""; }).filter(Boolean).join("; ");
  }
  return "…";
}
/** An object that opens into rows of its own: it holds an object, a list of objects or long text. */
function structured(o: Json): boolean {
  if (isRichText(o)) return false;
  return shown(o).some(([, v]) =>
    isRecord(v) || (Array.isArray(v) && v.some(isRecord) && !v.every(isRichText)) || (typeof v === "string" && v.includes("\n")))
    || inline(o).length > MAX_VALUE;
}

/** A Notion title property, whatever it is named ({ type: "title", title: [...] }). */
const isTitleProperty = (v: unknown) => isRecord(v) && (v.type === "title" || Array.isArray(v.title));

/**
 * Rows in argument order with their rank. A nested row is labelled by its own key; when that label
 * is taken (or the row sits in one of several list items) the parent's label goes first.
 */
function collect(args: Json, skip: readonly string[]): (Ranked & { order: number })[] {
  const rows: (Ranked & { order: number })[] = [];
  const top = shown(args).filter(([k]) => !skip.includes(k));
  const reserved = new Set(top.map(([k]) => humanLabel(k)));
  const taken = new Set<string>();
  const claim = (label: string) => {
    let out = label;
    for (let n = 2; taken.has(out); n += 1) out = `${label} ${n}`;
    taken.add(out);
    return out;
  };
  const labelFor = (base: string, parent: string | null, qualify: boolean) =>
    parent !== null && (qualify || reserved.has(base) || taken.has(base)) ? join(parent, base) : base;
  const add = (base: string, label: string, text: string, title: boolean) => {
    const value = tidy(text);
    if (!value) return;
    const lastWord = base.slice(base.lastIndexOf(" ") + 1).toLowerCase();
    const long = value.includes("\n") || BODY_WORDS.has(lastWord);
    const rank = title || TITLE_LABELS.has(base) ? 0 : long ? 2 : 1;
    rows.push({ label: claim(label), value: clip(value, long ? MAX_BODY : MAX_VALUE), rank, order: rows.length });
  };
  /** A `properties` object: one row per property, read as plain text. */
  const properties = (props: Json, parent: string, qualify: boolean) => {
    for (const [key, value] of shown(props)) {
      const base = humanLabel(key);
      add(base, labelFor(base, parent, qualify), plainText(value) || inline(value), isTitleProperty(value));
    }
  };
  /** One argument: a row, or rows of its own (an object with structure, a list of such objects). */
  const visit = (value: unknown, base: string, parent: string | null, qualify: boolean, depth: number) => {
    const label = labelFor(base, parent, qualify);
    // A list holding exactly one object stands for that object (pages: [{…}]).
    const item = Array.isArray(value) && value.length === 1 && isRecord(value[0]) ? value[0] : value;
    if (depth < MAX_DEPTH && isRecord(item) && structured(item)) {
      for (const [key, child] of shown(item)) {
        if (key === "properties" && isRecord(child)) properties(child, label, qualify);
        else visit(child, humanLabel(key), label, qualify, depth + 1);
      }
      return;
    }
    if (depth < MAX_DEPTH && Array.isArray(item) && !item.every(isRichText) && item.some((x) => isRecord(x) && structured(x))) {
      // Several objects: "Pages 1 title", "Pages 2 title", ...
      item.forEach((x, i) => visit(x, `${label} ${i + 1}`, null, true, depth + 1));
      return;
    }
    add(base, label, inline(item), false);
  };
  for (const [key, value] of top) {
    if (key === "properties" && isRecord(value)) properties(value, "Properties", false);
    else visit(value, humanLabel(key), null, false, 0);
  }
  return rows;
}

/**
 * Every meaningful argument as labelled rows (L182: generic cards show labelled rows, never raw
 * JSON): the ones naming the thing first, then the other short ones, then long text.
 */
export function rowsOf(args: Record<string, unknown>, skip: readonly string[] = []): { label: string; value: string }[] {
  const rows = collect(args, skip)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ label, value }) => ({ label, value }));
  if (rows.length <= MAX_ROWS) return rows;
  return [...rows.slice(0, MAX_ROWS - 1), { label: "More", value: `${rows.length - MAX_ROWS + 1} more fields` }];
}

// Gmail and Outlook argument names, as Composio publishes them (M20: recipients.ts reads them too).
export const TO = ["recipient_email", "to", "to_email", "recipients", "to_recipients"];
export const EXTRA_TO = ["extra_recipients"];
export const CC = ["cc", "cc_emails", "cc_recipients"];
export const BCC = ["bcc", "bcc_emails", "bcc_recipients"];
const SUBJECT = ["subject"];
const BODY = ["body", "message_body", "content", "text"];
const ATTACH = ["attachment", "attachments"];
const EMAIL_KEYS = new Set([...TO, ...EXTRA_TO, ...CC, ...BCC, ...SUBJECT, ...BODY, ...ATTACH, "is_html", "user_id", "thread_id", "message_id", "in_reply_to"]);

function attachments(v: unknown): { name: string; mime: string; fileId: null }[] {
  const items = Array.isArray(v) ? v : v ? [v] : [];
  return items.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [{ name: item.split(/[\\/]/).pop() || item, mime: "application/octet-stream", fileId: null }];
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const name = str(o.name) || str(o.filename) || str(o.file_name) || "attachment";
      return [{ name, mime: str(o.mimetype) || str(o.mime_type) || str(o.mime) || "application/octet-stream", fileId: null }];
    }
    return [];
  });
}

/** The card for a stored call. An email with bcc, or with arguments we can't show, falls back to rows. */
export function buildPreview(input: PreviewInput): { kind: Kind; preview: Preview } {
  const { kind, app, toolName, args } = input;
  if (kind === "email") {
    const to = [...list(pick(args, TO)), ...list(pick(args, EXTRA_TO))];
    const bcc = list(pick(args, BCC));
    const unknown = Object.keys(args).some((k) => !EMAIL_KEYS.has(k) && args[k] !== undefined && args[k] !== null && args[k] !== "");
    if (to.length && !bcc.length && !unknown) {
      const rawBody = str(pick(args, BODY));
      const body = args.is_html === true ? convert(rawBody, { wordwrap: false }) : rawBody;
      return { kind, preview: { kind: "email", app, to, cc: list(pick(args, CC)), subject: str(pick(args, SUBJECT)), body: body.slice(0, MAX_BODY), attachments: attachments(pick(args, ATTACH)) } };
    }
    return { kind: "action", preview: { kind: "action", app, toolName, rows: rowsOf(args) } };
  }
  if (kind === "sign" || kind === "delete") {
    const title = str(pick(args, ["title", "name", "subject", "file_name", "filename", "document_name", "email_subject"])) || toolName;
    return { kind, preview: { kind, app, title: clip(title, MAX_VALUE), rows: rowsOf(args) } };
  }
  return { kind: "action", preview: { kind: "action", app, toolName, rows: rowsOf(args) } };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The preview fields an edit changed: top-level names ("subject", "body", "to"), and for row cards
 * "rows.<label>" per changed row ("title" too for sign / delete).
 */
export function changedFields(before: Preview, after: Preview): string[] {
  if (before.kind !== after.kind) return Object.keys(after).filter((k) => k !== "kind");
  if (after.kind === "email" && before.kind === "email") {
    return (["to", "cc", "subject", "body", "attachments"] as const).filter((k) => !same(before[k], after[k]));
  }
  const out: string[] = [];
  const b = before as Record<string, unknown>, a = after as Record<string, unknown>;
  for (const key of ["title", "toolName", "amount", "currency", "merchant", "description"]) if (key in a && !same(b[key], a[key])) out.push(key);
  if ("rows" in a) {
    const old = new Map(((b.rows ?? []) as { label: string; value: string }[]).map((r) => [r.label, r.value]));
    const now = (a.rows as { label: string; value: string }[]);
    for (const row of now) if (old.get(row.label) !== row.value) out.push(`rows.${row.label}`);
    for (const label of old.keys()) if (!now.some((r) => r.label === label)) out.push(`rows.${label}`);
  }
  return out;
}
