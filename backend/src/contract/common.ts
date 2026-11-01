// Shared building blocks of the API contract. docs/API.md describes every route;
// these zod schemas are the source of truth and validate requests in the routes.
import { z } from "zod";

export const Id = z.string().min(1).max(64);
/** Protocol value for the assistant role; input readers also accept M28's legacy "claude". */
export const AssistantOutput = z.literal("assistant");
export const AssistantInput = z.preprocess((value) => value === "claude" ? "assistant" : value, AssistantOutput);
export type AssistantValue = z.infer<typeof AssistantOutput>;

/** Normalize assistant protocol fields in legacy JSON without changing user text or display labels. */
const ASSISTANT_PROTOCOL_KEYS = new Set(["role", "by", "source", "controller", "startedBy", "actor"]);
export function normalizeAssistantProtocol(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeAssistantProtocol);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    ASSISTANT_PROTOCOL_KEYS.has(key) && item === "claude" ? "assistant" : normalizeAssistantProtocol(item),
  ]));
}

/** ISO 8601 timestamp, e.g. "2026-10-25T08:47:00.000Z". The app formats it in the user's locale. */
export const IsoDate = z.iso.datetime({ offset: true });

export const Language = z.enum(["en", "zh-Hans"]);
export type Language = z.infer<typeof Language>;

/** Local wall-clock time; the app formats it with the iPhone's 12/24-hour setting. */
export const LocalTime = z.object({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

/**
 * A parameter of server-built text. Dates and durations stay structured so the app
 * formats them in its own language and clock style.
 */
export const PhraseParam = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), value: z.string() }),
  z.object({ type: z.literal("number"), value: z.number() }),
  /** date and time, e.g. "Oct 26 at 10:00 AM" */
  z.object({ type: z.literal("datetime"), value: IsoDate }),
  /** weekday or date plus time relative to now, e.g. "Thursday at 11:00 AM" */
  z.object({ type: z.literal("relative_datetime"), value: IsoDate }),
  z.object({ type: z.literal("duration"), seconds: z.number().nonnegative() }),
]);

/**
 * Text shown in the UI. Server-built text is a key plus parameters (rendered by the app
 * in its language, see backend/src/i18n/ and the app's String Catalog); text the model
 * wrote is sent as written. Exactly one of `key` / `text` is set.
 */
export const Phrase = z
  .object({
    key: z.string().min(1).optional(),
    params: z.record(z.string(), PhraseParam).optional(),
    text: z.string().optional(),
  })
  .refine((p) => (p.key === undefined) !== (p.text === undefined), {
    message: "exactly one of key or text",
  });
export type Phrase = z.infer<typeof Phrase>;

/** Every non-2xx JSON response. `code` is stable; the app maps it to localized text. */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    field: z.string().optional(),
  }),
});

/** Recurring schedule as structured data (never a preformatted time string). */
export const Schedule = z.object({
  cadence: z.enum(["daily", "weekdays", "weekly", "hourly", "once"]),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  /** 0 = Sunday ... 6 = Saturday, for "weekly" */
  weekday: z.number().int().min(0).max(6).optional(),
  /** for "once" */
  at: IsoDate.optional(),
});

/**
 * M9: the app's hand-drawn line icon set (ios/OpenDuet/Components/DuetIcon). Cards OpenDuet
 * writes (form, card, task suggestions) pick one by key; the app draws it in the card's tint.
 */
export const CardIcon = z.enum([
  "lightbulb", "doc", "dashboard", "slides", "webpage", "design", "checklist", "task", "calendar",
  "clock", "mail", "chat", "person", "people", "folder", "file", "link", "search", "globe", "chart",
  "money", "cart", "gift", "pin", "house", "plane", "book", "code", "sparkle", "heart", "star",
  "bell", "warning", "check", "question", "pencil", "music", "camera",
]);
export type CardIcon = z.infer<typeof CardIcon>;
/** M9: a card's tint; the app maps each to a light / dark colour pair of its palette. */
export const CardTint = z.enum(["orange", "blue", "green", "purple", "amber", "red", "grey"]);
export type CardTint = z.infer<typeof CardTint>;

/** A connector's display name ("Google Calendar"), never the Composio slug. */
export const AppName = z.string().min(1);

/** Status pill keys. The app shows them in its language; they also drive the mascot morph. */
export const StatusKey = z.enum([
  "thinking", // "Thinking it through"
  "checking_memory", // "Checking memory"
  "searching_email", // "Searching your email"
  "checking_files", // "Checking recent files"
  "checking_calendar", // "Checking your calendar"
  "searching_web", // "Searching the web"
  "looking_up", // "Looking something up"
  "writing_draft", // "Writing a draft"
  "starting_task", // "Starting a task"
  "working_tasks", // "Working on your tasks"
  "working", // "Working on it"
  "checking", // "Checking"
  "reading_now", // "Reading now"
  "working_browser", // "Working in your browser"
  "waking_workspace", // "Waking Claude's workspace"
]);
export type StatusKey = z.infer<typeof StatusKey>;
