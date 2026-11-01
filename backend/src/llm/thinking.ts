// M12 thinking levels: PI-Desktop's ladder (off / minimal / low / medium / high / xhigh / max), the
// clamp onto what a model supports (nearestSupportedThinkingLevel: walk up, then down, then off) and
// the levels models.dev publishes (thinkingLevelsFromModelsDev). Re-implemented after
// PI-Desktop packages/shared/src/thinking-levels.ts and apps/desktop/electron/main/models-dev-catalog.ts.
import { THINKING_LEVELS, type ThinkingLevel } from "../contract/m12.ts";
import type { LlmRequest, Model, ThinkingFormat } from "./types.ts";

export { THINKING_LEVELS };
export type { ThinkingLevel };

/** models.dev's "reasoning": true without options: these three (no "off"). */
const DEFAULT_PUBLISHED: readonly ThinkingLevel[] = ["low", "medium", "high"];
/** A models.json model with capabilities.thinking (and every imported one). */
export const LEGACY_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];

/** The given levels, deduplicated, in ladder order. */
export function ladder(levels: Iterable<ThinkingLevel>): ThinkingLevel[] {
  const set = new Set(levels);
  return THINKING_LEVELS.filter((level) => set.has(level));
}

/** Clamp a requested level onto a model's levels: walk up first, then down, then off. */
export function nearestSupportedThinkingLevel(requested: ThinkingLevel, levels: readonly ThinkingLevel[] | undefined): ThinkingLevel {
  const supported = new Set(levels ?? []);
  if (supported.size === 0) return "off";
  if (supported.has(requested)) return requested;
  const at = THINKING_LEVELS.indexOf(requested);
  for (let i = at; i < THINKING_LEVELS.length; i++) if (supported.has(THINKING_LEVELS[i]!)) return THINKING_LEVELS[i]!;
  for (let i = at - 1; i >= 0; i--) if (supported.has(THINKING_LEVELS[i]!)) return THINKING_LEVELS[i]!;
  return "off";
}

function normalizeValue(value: unknown): ThinkingLevel | undefined {
  if (value === "none") return "off";
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value) ? (value as ThinkingLevel) : undefined;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * The levels a models.dev record publishes: none without `reasoning`; a `toggle` or `budget_tokens`
 * option adds off + medium; `values` (effort names, "none" = off) add themselves; reasoning with no
 * usable option = low / medium / high.
 */
export function thinkingLevelsFromModelsDev(reasoning: boolean, options: unknown): ThinkingLevel[] {
  if (!reasoning) return [];
  const levels = new Set<ThinkingLevel>();
  if (Array.isArray(options)) {
    for (const option of options) {
      const entry = record(option);
      const type = typeof entry?.type === "string" ? entry.type.trim() : "";
      if (type === "toggle" || type === "budget_tokens") {
        levels.add("off");
        levels.add("medium");
      }
      if (Array.isArray(entry?.values)) {
        for (const value of entry.values) {
          const level = normalizeValue(value);
          if (level) levels.add(level);
        }
      }
    }
  }
  return levels.size > 0 ? ladder(levels) : [...DEFAULT_PUBLISHED];
}

/**
 * The wire format for a models.dev record: none without levels; the anthropic protocol uses
 * `budget` when the options publish a budget_tokens type and no effort values, else `effort`;
 * the openai protocol always `effort`.
 */
export function thinkingFormatFromModelsDev(levels: readonly ThinkingLevel[], options: unknown, protocol: "anthropic" | "openai"): ThinkingFormat {
  if (!levels.length) return "none";
  if (protocol === "openai") return "effort";
  const list = Array.isArray(options) ? options.map(record) : [];
  const budget = list.some((o) => o?.type === "budget_tokens");
  const effort = list.some((o) => Array.isArray(o?.values) && o.values.some((v) => normalizeValue(v) !== undefined && v !== "none"));
  return budget && !effort ? "budget" : "effort";
}

/** A model's levels and format; models.json models derive them from capabilities.thinking. */
export function thinkingOf(model: Model): { levels: ThinkingLevel[]; format: ThinkingFormat; legacy: boolean } {
  if (model.thinkingFormat !== undefined) {
    const levels = ladder(model.thinkingLevels ?? []);
    return { levels, format: levels.length ? model.thinkingFormat : "none", legacy: false };
  }
  return model.capabilities.thinking
    ? { levels: [...LEGACY_THINKING_LEVELS], format: "effort", legacy: true }
    : { levels: [], format: "none", legacy: true };
}

/** The level a request asks for (thinkingLevel, else the legacy switch), clamped onto the model. */
export function requestedLevel(request: Pick<LlmRequest, "thinking" | "thinkingLevel">, levels: readonly ThinkingLevel[]): ThinkingLevel {
  const asked = request.thinkingLevel ?? (request.thinking ? "medium" : "off");
  return nearestSupportedThinkingLevel(asked, levels);
}
