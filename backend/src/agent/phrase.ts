import en from "../i18n/en.json";
import zh from "../i18n/zh-Hans.json";

export type PhraseKey = keyof typeof en.phrases;

/** Fixed assistant copy, not the structured system lines rendered by the app. */
export function phrase(key: PhraseKey, lang: string): string {
  return (lang === "zh-Hans" ? zh : en).phrases[key];
}

export function agentPhrases(lang: string): Record<string, string> {
  return Object.fromEntries(Object.keys(en.phrases).filter(key => key.startsWith("agent.")).map(key => [key, phrase(key as PhraseKey, lang)]));
}
