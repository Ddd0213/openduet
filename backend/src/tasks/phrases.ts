// Server-built "Decisions and updates" rows are sent as phrase keys (the app renders them in its
// language). The model gets them rendered in English from en.json; the keys below that en.json
// doesn't have yet (requested from the main agent) fall back to the English kept here.
import en from "../i18n/en.json";
import type { Phrase } from "../contract/common.ts";

export const TASK_PHRASE = {
  pausedRestart: "task.paused_restart",
  pausedUsageLimit: "task.paused_usage_limit",
  approvalDone: "task.approval_done",
  approvalFailed: "task.approval_failed",
  approvalDeclined: "task.approval_declined",
  approvalExpired: "task.approval_expired",
} as const;

const FALLBACK: Record<string, string> = {
  "task.paused_restart": "Paused by a server restart. Reply to continue.",
  "task.paused_usage_limit": "Paused at the usage limit. Reply after {at} to continue.",
  "task.approval_done": "Approved and done: {summary}",
  "task.approval_failed": "Approved, but it didn't go through: {summary}",
  "task.approval_declined": "Declined: {summary}",
  "task.approval_expired": "The approval expired: {summary}",
};

/** English text of a phrase for the model's context; never sent to the app. */
export function renderPhrase(phrase: Phrase): string {
  if (phrase.text !== undefined) return phrase.text;
  const key = phrase.key ?? "";
  const template = (en.phrases as Record<string, string>)[key] ?? FALLBACK[key];
  if (!template) return key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const param = phrase.params?.[name];
    if (!param) return match;
    return "value" in param ? String(param.value) : `${param.seconds} s`;
  });
}
