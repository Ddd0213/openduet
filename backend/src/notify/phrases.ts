// Fixed notification text. The app renders the `notification` event's Phrase itself (String
// Catalog); remote pushes are rendered here in User.language. Keys are looked up in
// src/i18n/*.json first and fall back to the copy below until the main agent adds them there.
import type { z } from "zod";
import type { Phrase, PhraseParam } from "../contract/common.ts";
import en from "../i18n/en.json";
import zh from "../i18n/zh-Hans.json";

export const NOTIFY_TITLE = "notify.title";
export const NOTIFY_TASK_READY = "notify.task_ready";
export const NOTIFY_TASK_NEEDS_INPUT = "notify.task_needs_input";
/** M18: a task finished on its own (resolved); its result is in the chat */
export const NOTIFY_TASK_DONE = "notify.task_done";
export const NOTIFY_APPROVAL = "notify.approval";
export const NOTIFY_APPROVAL_GENERIC = "notify.approval_generic";
export const NOTIFY_TEST = "notify.test";
export const NOTIFY_OPEN_APP = "notify.open_app";
// M29: a run stopped while the user isn't looking (notify/run-end.ts, Make, tasks, routines).
export const NOTIFY_REPLY = "notify.reply";
export const NOTIFY_MESSAGE = "notify.message";
export const NOTIFY_FORM = "notify.form";
export const NOTIFY_CONNECT = "notify.connect";
export const NOTIFY_SIGN_IN = "notify.sign_in";
export const NOTIFY_FAILED = "notify.failed";
export const NOTIFY_TASK_FAILED = "notify.task_failed";
export const NOTIFY_ROUTINE_FAILED = "notify.routine_failed";
export const NOTIFY_ROUTINE_PAUSED = "notify.routine_paused";
export const NOTIFY_ARTIFACT_READY = "notify.artifact_ready";
export const NOTIFY_ARTIFACT_FAILED = "notify.artifact_failed";
export const NOTIFY_USAGE_LIMIT = "notify.usage_limit";

/** English + Chinese for keys the i18n files may not have yet (also listed in the M4-B report). */
export const NOTIFY_FALLBACK: Record<"en" | "zh-Hans", Record<string, string>> = {
  en: {
    [NOTIFY_TITLE]: "OpenDuet",
    [NOTIFY_TASK_READY]: "{title} is ready for review.",
    [NOTIFY_TASK_NEEDS_INPUT]: "{title} needs your input.",
    [NOTIFY_TASK_DONE]: "{title} is done.",
    [NOTIFY_APPROVAL]: "Waiting for your approval: {title}",
    [NOTIFY_APPROVAL_GENERIC]: "Something is waiting for your approval.",
    [NOTIFY_TEST]: "This is a test notification from your server.",
    [NOTIFY_OPEN_APP]: "Launch OpenDuet to see it.",
    [NOTIFY_REPLY]: "OpenDuet replied to you.",
    [NOTIFY_MESSAGE]: "OpenDuet sent you a message.",
    [NOTIFY_FORM]: "OpenDuet has a question for you.",
    [NOTIFY_CONNECT]: "Connect {name} to continue.",
    [NOTIFY_SIGN_IN]: "Sign in to {name} to continue.",
    [NOTIFY_FAILED]: "OpenDuet couldn't finish. Open it to see why.",
    [NOTIFY_TASK_FAILED]: "{title} didn't work out. Take a look.",
    [NOTIFY_ROUTINE_FAILED]: "Scheduled task {title} ran into an error.",
    [NOTIFY_ROUTINE_PAUSED]: "Scheduled task {title} kept failing and is paused.",
    [NOTIFY_ARTIFACT_READY]: "{title} is ready.",
    [NOTIFY_ARTIFACT_FAILED]: "{title} couldn't be made.",
    [NOTIFY_USAGE_LIMIT]: "You've hit your usage limit, so OpenDuet stopped for now.",
  },
  "zh-Hans": {
    [NOTIFY_TITLE]: "OpenDuet",
    [NOTIFY_TASK_READY]: "「{title}」待你审阅。",
    [NOTIFY_TASK_NEEDS_INPUT]: "「{title}」等你处理。",
    [NOTIFY_TASK_DONE]: "「{title}」做好了。",
    [NOTIFY_APPROVAL]: "等你批准：{title}",
    [NOTIFY_APPROVAL_GENERIC]: "有一项操作等你批准。",
    [NOTIFY_TEST]: "这是来自你服务器的测试通知。",
    [NOTIFY_OPEN_APP]: "打开 OpenDuet 查看。",
    [NOTIFY_REPLY]: "OpenDuet 回复了你。",
    [NOTIFY_MESSAGE]: "OpenDuet 给你发了一条消息。",
    [NOTIFY_FORM]: "OpenDuet 有问题要问你。",
    [NOTIFY_CONNECT]: "需要你连接 {name}。",
    [NOTIFY_SIGN_IN]: "需要你登录 {name}。",
    [NOTIFY_FAILED]: "OpenDuet 没能完成，点开看原因。",
    [NOTIFY_TASK_FAILED]: "「{title}」没做成，需要你看看。",
    [NOTIFY_ROUTINE_FAILED]: "定时任务「{title}」出错了。",
    [NOTIFY_ROUTINE_PAUSED]: "定时任务「{title}」连续出错，已暂停。",
    [NOTIFY_ARTIFACT_READY]: "「{title}」可以看了。",
    [NOTIFY_ARTIFACT_FAILED]: "「{title}」没做成。",
    [NOTIFY_USAGE_LIMIT]: "用量到上限了，OpenDuet 先停下了。",
  },
};

/** M29: a text param, the shape every notify.* placeholder uses. */
export const textParam = (value: string) => ({ type: "text" as const, value });

type Lang = "en" | "zh-Hans";
const lang = (value: string): Lang => (value === "zh-Hans" ? "zh-Hans" : "en");

function template(key: string, language: Lang): string {
  const tables: Record<Lang, Record<string, string>> = { en: en.phrases, "zh-Hans": zh.phrases };
  return tables[language][key] ?? NOTIFY_FALLBACK[language][key] ?? tables.en[key] ?? NOTIFY_FALLBACK.en[key] ?? key;
}

function formatParam(param: z.infer<typeof PhraseParam>, language: Lang, timeZone: string): string {
  const locale = language === "zh-Hans" ? "zh-Hans-CN" : "en-US";
  switch (param.type) {
    case "text": return param.value;
    case "number": return new Intl.NumberFormat(locale).format(param.value);
    case "datetime":
    case "relative_datetime": {
      const options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
      try {
        return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(param.value));
      } catch {
        return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(param.value));
      }
    }
    case "duration": {
      const minutes = Math.max(1, Math.round(param.seconds / 60));
      return language === "zh-Hans" ? `${minutes} 分钟` : `${minutes} min`;
    }
  }
}

/** Server-side text of a Phrase for a remote push, in the user's language and timezone. */
export function renderPhrase(phrase: Phrase, language: string, timeZone: string): string {
  if (phrase.text !== undefined) return phrase.text;
  const l = lang(language);
  const params = phrase.params ?? {};
  return template(phrase.key ?? "", l).replace(/\{(\w+)\}/g, (whole, name: string) => {
    const param = params[name];
    return param ? formatParam(param, l, timeZone) : whole;
  });
}
