// Display names (L168): apps are always named by their display name ("Google Calendar"), never
// by a toolkit slug ("googlecalendar"), in the UI, status/system lines and everything the model
// reads. Also the slug guards and assistant sheet category of a toolkit (L126).
import type { AccessCategory } from "../contract/connectors.ts";
import type { z } from "zod";

type Category = z.infer<typeof AccessCategory>;

/** Composio meta tools (search, multi-execute, workbench, bash ...) are never run through us. */
export const META_PREFIX = "COMPOSIO_";
export const TOOLKIT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const TOOL_SLUG = /^[A-Z0-9][A-Z0-9_]{1,127}$/;

export const isMetaTool = (slug: string) => slug.toUpperCase().startsWith(META_PREFIX);

/** Names we know better than a generic fallback (Composio's own name is used for the rest). */
const DISPLAY: Record<string, string> = {
  gmail: "Gmail", googlecalendar: "Google Calendar", googledrive: "Google Drive", googledocs: "Google Docs",
  googlesheets: "Google Sheets", googleslides: "Google Slides", googlemeet: "Google Meet", googletasks: "Google Tasks",
  slack: "Slack", notion: "Notion", github: "GitHub", gitlab: "GitLab", hubspot: "HubSpot", stripe: "Stripe",
  linear: "Linear", jira: "Jira", asana: "Asana", trello: "Trello", outlook: "Outlook", microsoft_teams: "Microsoft Teams",
  one_drive: "OneDrive", onedrive: "OneDrive", dropbox: "Dropbox", docusign: "DocuSign", zoom: "Zoom", discord: "Discord",
  salesforce: "Salesforce", figma: "Figma", airtable: "Airtable", calendly: "Calendly", shopify: "Shopify",
  intercom: "Intercom", zendesk: "Zendesk", whatsapp: "WhatsApp", telegram: "Telegram", twitter: "X", linkedin: "LinkedIn",
};

const CATEGORY: Record<string, Category> = {
  gmail: "mail", outlook: "mail",
  googlecalendar: "calendar", calendly: "calendar", outlook_calendar: "calendar",
  googledrive: "files", googledocs: "files", googlesheets: "files", googleslides: "files", dropbox: "files",
  one_drive: "files", onedrive: "files", notion: "files", box: "files",
  slack: "team_chat", microsoft_teams: "team_chat", discord: "team_chat",
  stripe: "payments", paypal: "payments", square: "payments",
};

/** Words kept as written when a tool name is put in sentence case. */
const KEEP = new Set(["Google", "Gmail", "Slack", "Notion", "GitHub", "Github", "HubSpot", "Stripe", "Linear", "Jira", "Outlook", "Drive", "Calendar", "Docs", "Sheets", "Zoom", "Teams", "Microsoft", "DocuSign", "Dropbox", "I"]);

function titleCase(words: string): string {
  return words.split(/[\s_-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

/** The app's display name for a toolkit slug; `known` is Composio's name when we have it. */
export function displayName(slug: string, known?: string | null): string {
  const key = slug.toLowerCase();
  return DISPLAY[key] ?? (known && known.trim() ? known.trim() : titleCase(key));
}

/** The toolkit a tool slug belongs to, by the longest matching toolkit prefix. */
export function toolkitOfSlug(slug: string, toolkits: readonly string[]): string | null {
  const upper = slug.toUpperCase();
  let best: string | null = null;
  for (const toolkit of toolkits) {
    const prefix = `${toolkit.toUpperCase()}_`;
    if (upper.startsWith(prefix) && (!best || toolkit.length > best.length)) best = toolkit;
  }
  return best;
}

/** "Send Email" -> "Send email"; falls back to the slug without its toolkit prefix. */
export function toolDisplayName(slug: string, name: string | null | undefined, toolkit: string | null): string {
  const raw = name && name.trim() ? name.trim() : (() => {
    const upper = slug.toUpperCase();
    const prefix = toolkit ? `${toolkit.toUpperCase()}_` : "";
    return (prefix && upper.startsWith(prefix) ? upper.slice(prefix.length) : upper).replace(/_/g, " ");
  })();
  const words = raw.split(/\s+/).filter(Boolean);
  return words.map((word, i) => {
    if (KEEP.has(word) || (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word) && name)) return word;
    const lower = word.toLowerCase();
    return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
  }).join(" ");
}

/** The "What OpenDuet has access to" row a toolkit belongs to, if any. */
export function categoryOf(slug: string, composioCategories: readonly string[] = []): Category | null {
  const known = CATEGORY[slug.toLowerCase()];
  if (known) return known;
  const text = composioCategories.join(" ").toLowerCase();
  if (/\b(e-?mail|mail)\b/.test(text)) return "mail";
  if (/\b(calendar|scheduling)\b/.test(text)) return "calendar";
  if (/\b(team chat|chat|messaging|communication)\b/.test(text)) return "team_chat";
  if (/\b(payments?|billing|finance|accounting)\b/.test(text)) return "payments";
  if (/\b(files?|documents?|storage|drive)\b/.test(text)) return "files";
  return null;
}

/** Replaces lowercase toolkit slugs in Composio's guidance text with display names. */
export function scrubSlugs(text: string, names: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [slug, name] of names) {
    if (slug.length < 3) continue;
    out = out.replace(new RegExp(`\\b${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), name);
  }
  return out;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const HANDLE = /^@?[\w.-]{2,64}$/;
/** Keys of connection data that may hold the account's address or handle (tokens are never read). */
const LABEL_KEYS = ["email", "emailAddress", "email_address", "user_email", "login", "username", "handle", "account_email"];

/** The account's real address or handle from Composio's connection data, if it carries one. */
export function accountLabelFrom(data: Record<string, unknown>): string | null {
  const sources = [data, ...["user", "profile", "account", "user_info"].map((k) => data[k]).filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v))];
  for (const source of sources) {
    for (const key of LABEL_KEYS) {
      const value = source[key];
      if (typeof value === "string" && (EMAIL.test(value) || (key !== "email" && HANDLE.test(value)))) return value;
    }
  }
  return null;
}

/** The first email-looking value under a known key in a read tool's answer (e.g. a Gmail profile). */
export function emailFrom(value: unknown, depth = 0): string | null {
  if (depth > 3 || !value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["emailAddress", "email", "email_address", "mail", "userPrincipalName"]) {
    const v = record[key];
    if (typeof v === "string" && EMAIL.test(v)) return v;
  }
  for (const v of Object.values(record)) {
    const found = emailFrom(v, depth + 1);
    if (found) return found;
  }
  return null;
}
