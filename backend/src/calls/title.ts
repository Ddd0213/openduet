// M13: the call's title: one utility-model call through M12's resolver (no JSON asked for), at
// most 60 characters, in User.language. No model, nothing said, a failure or an empty answer:
// the fallback "Voice call" / 「语音通话」 (i18n call.untitled).
import en from "../i18n/en.json";
import zh from "../i18n/zh-Hans.json";
import type { ModelResolver } from "../llm/index.ts";
import { log } from "../log.ts";
import { clip, spoken } from "./text.ts";

export const TITLE_MAX = 60;
const TRANSCRIPT_MAX = 6_000;
const TITLE_TIMEOUT_MS = 20_000;

export function untitled(language: string): string {
  const table = (language === "zh-Hans" ? zh.phrases : en.phrases) as Record<string, string>;
  return table["call.untitled"] ?? "Voice call";
}

/** Chat already labels the call; strip either language's legacy fallback without changing detail titles. */
export function chatTitle(title: string): string {
  const value = title.trim();
  return value === untitled("en") || value === untitled("zh-Hans") ? "" : title;
}

const SYSTEM = [
  "You name a finished voice call between a user and their assistant, like a short chat title.",
  "Answer with the title only: a few words, at most 60 characters, no quotes, no punctuation at the end, no JSON, no explanation.",
  "Write it in the language given. Name what the call was about ('Reorder brake pads', 'Plan for Friday'), never 'Voice call'.",
].join("\n");

export interface TitleInput {
  userId: string;
  language: string;
  lines: { from: string; text: string }[];
}

export async function titleFor(deps: { resolver: ModelResolver | null }, input: TitleInput): Promise<string> {
  const fallback = untitled(input.language);
  const said = input.lines.filter((l) => spoken(l.text));
  if (!said.length || !deps.resolver) return fallback;
  let transcript = "";
  for (const line of said) {
    const next = `${line.from === "user" ? "User" : "Assistant"}: ${spoken(line.text)}\n`;
    if (transcript.length + next.length > TRANSCRIPT_MAX) break;
    transcript += next;
  }
  try {
    const model = await deps.resolver.resolve({ userId: input.userId, channelId: null, role: "utility" });
    if (!model) return fallback;
    const language = input.language === "zh-Hans" ? "Simplified Chinese (zh-Hans)" : "English (en)";
    let answer = "";
    for await (const event of model.llm.stream({
      role: "utility", system: SYSTEM, maxTokens: 60, signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
      messages: [{ role: "user", content: [{ type: "text", text: `Language: ${language}\n\nThe call:\n${transcript || "(nothing)"}` }] }],
      ...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}),
    })) {
      if (event.type === "text_delta") answer += event.text;
      else if (event.type === "done") {
        if (!answer) answer = event.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        break;
      }
    }
    return cleanTitle(answer) || fallback;
  } catch (error) {
    log.warn("call title failed", { error: { name: (error as Error).name } });
    return fallback;
  }
}

/** The first line, without quotes, markdown or a trailing period, at most 60 characters. */
export function cleanTitle(answer: string): string {
  const first = spoken(answer.split("\n").find((l) => l.trim()) ?? "")
    .replace(/^(title|标题)\s*[:：]\s*/i, "")
    .replace(/[.。]+$/, "")
    .replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g, "")
    .replace(/[.。]+$/, "")
    .trim();
  return clip(first, TITLE_MAX);
}
