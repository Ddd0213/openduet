// M23: proactive quality and chat interaction. New leaf shapes only; the fields they add to older
// shapes (MemoryFact, Suggestion, the two suggestion cards, the text message) are declared next to
// those shapes and point back here.
//
// Additive, so an app built before M23 keeps decoding: every new field is nullable with a null
// default. Semantics: docs/API.md "## M23".
import { z } from "zod";
import { AppName, IsoDate } from "./common.ts";

/**
 * Where something OpenDuet wrote in the background came from: a memory it saved from an email, an
 * Up next suggestion it made from a calendar event. For display only ("From Gmail · Oct 28,
 * Re: Q4 budget"); the server keeps the opaque email / event id to itself.
 */
export const SourceRef = z.object({
  /** the app it was read from ("Gmail", "Google Calendar"); null for the chat itself */
  app: AppName.nullable(),
  kind: z.enum(["email", "event", "doc", "chat", "web"]),
  /** the email subject, event title, page title; "" when there is none */
  title: z.string().max(200),
  /** when the email was received / the event starts / the message was sent; null when unknown */
  at: IsoDate.nullable(),
});
export type SourceRef = z.infer<typeof SourceRef>;

/**
 * The morning brief's text message (TextPayload.brief): the sources it tried to read and couldn't
 * (an app not connected, a read that failed), so the app can say "Couldn't check Gmail" instead of
 * the brief reading as "nothing new". The brief's own text says it too.
 */
export const BriefInfo = z.object({
  /** app names, e.g. ["Gmail"]; empty when every source was read */
  unchecked: z.array(AppName),
});
export type BriefInfo = z.infer<typeof BriefInfo>;

/** Up next never offers again a suggestion with the same normalised title hidden this recently. */
export const HIDDEN_SUGGESTION_DAYS = 14;
/** Quick replies: how many, and how long each may be (characters; a Chinese character counts as one). */
export const QUICK_REPLY_MIN = 2;
export const QUICK_REPLY_MAX = 3;
export const QUICK_REPLY_MAX_CHARS = 24;
