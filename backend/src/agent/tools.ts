import { z } from "zod";
import { IsoDate, type StatusKey } from "../contract/common.ts";
import type { Db } from "../db.ts";
import type { Tool, ToolUseBlock, ToolResultBlock } from "../llm/index.ts";
import { QUICK_REPLY_MAX, QUICK_REPLY_MAX_CHARS, QUICK_REPLY_MIN } from "../contract/m23.ts";
import { createPastChatsSearch } from "../search/past-chats.ts";
import { webFetch, type WebFetchDeps, type WebFetchResult } from "../web/fetch.ts";
import { webSearch, type SearchConfig } from "../web/search.ts";
import { decideReplies, NO_RULES, pendingApproval, type ReplyTurn } from "./replies.ts";
import type { TurnInput } from "./types.ts";
import { builtinOffered, isBuiltin, SEARCH_NAMES, searchProviders, type BuiltinConfig } from "../builtins/config.ts";
import { weather, WeatherInput } from "../builtins/weather.ts";
import { exchangeRate, ExchangeInput } from "../builtins/rates.ts";
import { readFeed, FeedInput } from "../builtins/feed.ts";

// M11: remember (and forget, propose_soul_change) moved to the memory provider (src/memory/); their
// status keys stay here so a call reads "checking_memory" wherever it is routed.
export const TOOL_STATUS = {
  remember: "checking_memory", forget: "checking_memory", search_past_chats: "checking_memory",
  web_search: "searching_web", web_fetch: "reading_now", set_reminder: "checking", cancel_reminder: "checking",
  weather: "looking_up", exchange_rate: "looking_up", read_feed: "reading_now",
  quick_replies: "thinking", send_feedback: "checking",
} as const satisfies Record<string, StatusKey>;

const short = z.string().trim().min(1).max(1000);
const schemas = {
  search_past_chats: z.object({ query: short }).strict(),
  web_search: z.object({ query: short }).strict(),
  web_fetch: z.object({ url: z.string().max(8192).pipe(z.url({ protocol: /^https?$/ })) }).strict(),
  weather: WeatherInput, exchange_rate: ExchangeInput, read_feed: FeedInput,
  // M23: checked leniently; the rules (agent/replies.ts) drop the options that break them.
  quick_replies: z.object({ options: z.array(z.string().max(200)).min(1).max(10), text: z.string().max(2000).optional().default("") }).strict(),
  set_reminder: z.object({ at: IsoDate, text: z.string().trim().min(1).max(4000) }).strict(),
  // M29: which reminders, by a piece of their text and / or their time; `all` takes every match.
  cancel_reminder: z.object({ text: z.string().trim().min(1).max(200).optional(), at: IsoDate.optional(), all: z.boolean().optional() }).strict(),
  send_feedback: z.object({ text: z.string().trim().min(1).max(4000) }).strict(),
};
/** M23: what the model is shown (the limits); the call itself is checked by `schemas`. */
const shownSchemas: Partial<Record<keyof typeof schemas, z.ZodType>> = {
  quick_replies: z.object({ options: z.array(z.string().min(1).max(QUICK_REPLY_MAX_CHARS)).min(QUICK_REPLY_MIN).max(QUICK_REPLY_MAX), text: z.string().max(2000).optional() }).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  search_past_chats: "Search this user's past chat messages; returns channel names and ISO timestamps.",
  // M20: the search service and the sites are third parties; they see every query and URL.
  web_search: "Search the web for up to five sources with titles, URLs and snippets. The search service is a third party: never put private information in the query (names with personal details, email addresses, account numbers, codes, anything from the user's mail or files).",
  // M23 W4 (user's case 2026-10-28): the first choice for reading a link; said before the browser's tools are.
  web_fetch: "Read a web page or PDF from its link (GET only) and get its text: use this first to read, summarise or quote a link. It's quick, doesn't wake the browser, and works while the user has taken over the browser. A PDF link returns its text. Use the browser (computer_navigate) only when the page needs a sign-in or JavaScript (this returns little or no text then), or to click, fill in or post. The site is a third party: never put private information in the URL (names with personal details, email addresses, account numbers, codes, anything from the user's mail or files).",
  weather: "Look up a city or place's current weather and up to seven forecast days. Sends the place name and language to Open-Meteo geocoding, then coordinates and units to Open-Meteo's forecast service (or the server's configured Open-Meteo). Never send private information. Ambiguous places require asking the user. Temperature defaults to the user's region, wind is km/h with Celsius or mph with Fahrenheit; precipitation is mm. In the reply credit [Weather data by Open-Meteo.com](https://open-meteo.com/) and link the [CC BY 4.0 licence](https://creativecommons.org/licenses/by/4.0/). Free API is non-commercial only.",
  exchange_rate: "Get Frankfurter's European Central Bank reference exchange rates, latest working day or a specified date, and multiply an amount locally. Sends only currency codes and date to api.frankfurter.dev, never the amount or private data. Mid-market reference rates, not a bank's buy/sell rate; not for trading.",
  read_feed: "Read an RSS or Atom feed from its public URL, newest first, with short plain-text summaries. GET goes directly to the feed's own site (including redirects), not a third-party reader. Never put private data in the URL. In background turns only hosts returned by this turn's web_search may be read.",
  quick_replies: `Offer ${QUICK_REPLY_MIN}-${QUICK_REPLY_MAX} one-tap answers to a question with a few clear answers, after you've written your full answer; the question is in your reply (or in \`text\`) and the chips show under it. Each at most ${QUICK_REPLY_MAX_CHARS} characters, in the user's words (a tap sends it as their message), not repeated in your text. Not for open questions, and never to confirm sending, paying, signing or deleting (call that tool: its approval card asks). Not shown in a turn that used web_search or while an approval card waits. Ends this turn and waits for the user.`,
  set_reminder: "Set a reminder in this channel for a future ISO timestamp with an explicit timezone offset.",
  cancel_reminder: "Cancel a reminder you set that hasn't gone off yet, when the user no longer wants it or wants it moved (cancel it, then set_reminder the new time). Name it by text (a piece of the reminder's text, case-insensitive) and / or at (its time, ISO with an explicit offset; matches within a minute); all: true cancels every match (all alone: every pending one; called with nothing, it only lists them). Looks in this channel first, then the user's other channels. One match is cancelled; several without all come back as candidates to ask which; none returns the pending ones. Say a reminder is cancelled only when this tool's result lists it.",
  send_feedback: "Save the user's feedback and thank them.",
};
type Name = keyof typeof schemas;
export function functionTools(nativeWeb: boolean, settings: BuiltinConfig | boolean): Tool[] {
  // Boolean accepted for existing callers; the runtime always supplies its real config.
  const config: BuiltinConfig = typeof settings === "boolean" ? { BUILTIN_CONNECTORS_OFF: settings ? [] : ["web_search"] } : settings;
  return (Object.keys(schemas) as Name[])
    .filter(name => !(nativeWeb && (name === "web_fetch" || name === "web_search")) && (!isBuiltin(name) || builtinOffered(name, config)))
    .map(name => ({ name, description: descriptions[name] + (name === "web_search" ? ` Queries go to ${searchProviders(config).map(p => SEARCH_NAMES[p]).join(", then on failure ")}.` : ""), inputSchema: z.toJSONSchema(shownSchemas[name] ?? schemas[name], { io: "input" }) }));
}

/** A page with less readable text than this (whitespace collapsed) gets the "may need the browser" note. */
export const THIN_PAGE_CHARS = 200;
/** M29 cancel_reminder: `at` matches a reminder within this much; at most this many are listed. */
export const REMINDER_MATCH_MS = 60_000;
export const REMINDER_LIST_MAX = 20;
export const THIN_PAGE_NOTE = "This page has very little text: it may need JavaScript or a sign-in. If its content matters, open it in the browser (computer_navigate) if you have it, or tell the user you couldn't read it.";
export const EMPTY_PDF_NOTE = "This PDF has little or no text layer (it may be scanned images). Tell the user you couldn't read its text.";

/** M23 W4: web_fetch's result, with a note for the model when the text is too thin to use. */
export function fetchedWithNote(result: WebFetchResult): WebFetchResult & { note?: string } {
  if (result.isError) return result;
  if (result.text.replace(/\s+/g, " ").trim().length >= THIN_PAGE_CHARS) return result;
  return { ...result, note: result.format === "pdf" ? EMPTY_PDF_NOTE : THIN_PAGE_NOTE };
}

export interface ToolDeps extends WebFetchDeps { db: Db; config: SearchConfig & { DATABASE_URL: string }; now: () => Date }
export function createToolExecutor(deps: ToolDeps) {
  const past = createPastChatsSearch(deps.db, deps.config.DATABASE_URL);
  /** `replies`: the turn so far, for the quick-reply rules (agent/replies.ts); none = no turn rules. */
  return async (call: ToolUseBlock, input: TurnInput, offered: Tool[], replies: ReplyTurn = { rules: NO_RULES, searched: false, approvalWaiting: false }): Promise<{ result: ToolResultBlock; endTurn: boolean }> => {
    const reply = (data: unknown, isError = false, endTurn = false) => ({ result: { type: "tool_result" as const, toolUseId: call.id, content: [{ type: "text" as const, text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) }, endTurn });
    if (!offered.some(tool => tool.name === call.name)) return reply({ error: "Tool is not available" }, true);
    const name = call.name as Name;
    if (!schemas[name].safeParse(call.input).success) return reply({ error: "Invalid tool arguments" }, true);
    switch (name) {
      case "search_past_chats": return reply({ results: await past.search(input.userId, schemas.search_past_chats.parse(call.input).query) });
      case "web_search": {
        const result = await webSearch(schemas.web_search.parse(call.input).query, deps.config, { fetch: deps.fetch, signal: input.signal });
        return reply(result, !!result.isError);
      }
      case "web_fetch": {
        const result = await webFetch(schemas.web_fetch.parse(call.input).url, { fetch: deps.fetch, lookup: deps.lookup, signal: input.signal });
        return reply(fetchedWithNote(result), !!result.isError);
      }
      case "weather": {
        const profile = await deps.db.user.findUniqueOrThrow({ where: { id: input.userId }, select: { language: true, region: true } });
        const result = await weather(call.input, profile, deps.config, { fetch: deps.fetch, signal: input.signal });
        return reply(result, "isError" in result && result.isError);
      }
      case "exchange_rate": {
        const result = await exchangeRate(call.input, deps.config, { fetch: deps.fetch, signal: input.signal });
        return reply(result, "isError" in result && result.isError);
      }
      case "read_feed": {
        const result = await readFeed(call.input, deps.config, { fetch: deps.fetch, lookup: deps.lookup, signal: input.signal });
        return reply(result, "isError" in result && result.isError);
      }
      case "quick_replies": {
        // M23 W4: the rules decide (agent/replies.ts). No card: nothing is posted (its text neither)
        // and the turn goes on, so the model writes its answer / question as plain text.
        const { options, text } = schemas.quick_replies.parse(call.input);
        const decision = await decideReplies(options, replies, () => pendingApproval(deps.db, input, deps.now()));
        if (!decision.show) return reply({ shown: false, reason: decision.reason, note: decision.note }, true);
        await input.sink.upsertMessage({ role: "assistant", kind: "quick_replies", text, payload: { options: decision.options } });
        return reply({ waitingForChoice: true, options: decision.options }, false, true);
      }
      case "set_reminder": {
        const { at, text } = schemas.set_reminder.parse(call.input);
        if (new Date(at).getTime() <= deps.now().getTime()) return reply({ error: "Reminder time must be in the future" }, true);
        await deps.db.reminder.create({ data: { userId: input.userId, channelId: input.channelId, at: new Date(at), text } });
        await input.sink.upsertMessage({ role: "system", kind: "system", payload: { phrase: { key: "system.reminder_set", params: { at: { type: "datetime", value: at } } } } });
        return reply({ saved: true });
      }
      case "cancel_reminder": {
        // M29: only reminders that haven't gone off (firedAt null); this channel first, then the user's
        // others (one set during a call may sit in another thread). Each delete re-checks firedAt, so a
        // reminder firing meanwhile is reported as already sent, never both sent and "cancelled".
        const { text, at, all } = schemas.cancel_reminder.parse(call.input);
        const needle = text?.toLocaleLowerCase();
        const time = at ? new Date(at).getTime() : null;
        const matches = (r: { text: string; at: Date }) =>
          (!needle || r.text.toLocaleLowerCase().includes(needle)) && (time === null || Math.abs(r.at.getTime() - time) <= REMINDER_MATCH_MS);
        const pending = (channelId?: string) => deps.db.reminder.findMany({
          where: { userId: input.userId, firedAt: null, ...(channelId ? { channelId } : {}) }, orderBy: { at: "asc" },
        });
        const shown = (r: { id: string; text: string; at: Date; channelId: string }) => ({ id: r.id, text: r.text, at: r.at.toISOString(), inThisChannel: r.channelId === input.channelId });
        const list = async () => (await pending()).slice(0, REMINDER_LIST_MAX).map(shown);
        // Nothing named: nothing is cancelled, the pending ones come back to ask about.
        if (!needle && time === null && !all) return reply({ cancelled: [], note: "Name the reminder by text or at (or all: true).", pending: await list() }, true);
        let found = (await pending(input.channelId)).filter(matches);
        if (!found.length) found = (await pending()).filter(matches);
        if (!found.length) return reply({ cancelled: [], note: "No pending reminder matches.", pending: await list() }, true);
        if (found.length > 1 && !all) return reply({ cancelled: [], note: "Several reminders match: ask the user which one (or call again with all: true).", candidates: found.slice(0, REMINDER_LIST_MAX).map(shown) }, true);
        const cancelled: typeof found = [];
        const alreadySent: typeof found = [];
        for (const r of found) {
          const gone = await deps.db.reminder.deleteMany({ where: { id: r.id, userId: input.userId, firedAt: null } });
          (gone.count ? cancelled : alreadySent).push(r);
        }
        for (const r of cancelled) {
          await input.sink.upsertMessage({ role: "system", kind: "system", payload: { phrase: { key: "system.reminder_cancelled", params: { at: { type: "datetime", value: r.at.toISOString() } } } } });
        }
        return reply({ cancelled: cancelled.map(shown), ...(alreadySent.length ? { alreadySent: alreadySent.map(shown) } : {}) }, cancelled.length === 0);
      }
      case "send_feedback": {
        await deps.db.feedback.create({ data: { userId: input.userId, text: schemas.send_feedback.parse(call.input).text } });
        await input.sink.upsertMessage({ role: "system", kind: "system", payload: { phrase: { key: "system.feedback_thanks" } } });
        return reply({ saved: true });
      }
    }
  };
}
