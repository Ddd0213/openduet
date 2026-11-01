// M12 thinking levels (contract §4, §9): the adapter mapping for every protocol x format x level
// (anthropic effort / budget incl. the cap, openai effort, gemini's "none", format none), the clamp
// (nearestSupportedThinkingLevel) and the levels models.dev publishes (thinkingLevelsFromModelsDev).
import { describe, expect, test } from "bun:test";
import { THINKING_LEVELS, type ThinkingLevel } from "../../src/contract/m12.ts";
import { anthropicParams } from "../../src/llm/adapters/anthropic.ts";
import { openaiParams } from "../../src/llm/adapters/openai.ts";
import { nearestSupportedThinkingLevel, thinkingFormatFromModelsDev, thinkingLevelsFromModelsDev, type AdapterContext, type LlmRequest, type Model, type Provider } from "../../src/llm/index.ts";

const ALL: ThinkingLevel[] = [...THINKING_LEVELS];
const request = (thinkingLevel?: ThinkingLevel, extra: Partial<LlmRequest> = {}): LlmRequest => ({
  role: "chat", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], ...(thinkingLevel ? { thinkingLevel } : {}), ...extra,
});
const model = (format: "effort" | "budget" | "none", levels: ThinkingLevel[] = ALL, maxOutputTokens = 64000): Model => ({
  id: "m", provider: "p", label: "M", contextWindow: 200000, maxOutputTokens,
  capabilities: { tools: true, vision: false, thinking: levels.some((l) => l !== "off"), serverWebTools: false, promptCaching: false },
  thinkingLevels: levels, thinkingFormat: format,
});
const ctx = (m: Model, protocol: "anthropic" | "openai", provider: Partial<Provider> = {}): AdapterContext => ({
  provider: { id: "p", protocol, baseUrl: "https://gw.invalid", ...provider }, model: m, apiKey: "k", timeoutMs: 1000,
});
const anthropic = (m: Model, level?: ThinkingLevel, extra?: Partial<LlmRequest>) => anthropicParams(request(level, extra), ctx(m, "anthropic")) as unknown as Record<string, unknown>;
const openai = (m: Model, level?: ThinkingLevel, provider?: Partial<Provider>) => openaiParams(request(level), ctx(m, "openai", provider)) as unknown as Record<string, unknown>;

describe("anthropic adapter", () => {
  test("effort: off sends no thinking; every other level adaptive + output_config.effort (minimal -> low)", () => {
    const want: Record<ThinkingLevel, string | null> = { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
    for (const level of ALL) {
      const body = anthropic(model("effort"), level);
      if (want[level] === null) {
        expect(body.thinking).toBeUndefined();
        expect(body.output_config).toBeUndefined();
      } else {
        expect(body.thinking).toEqual({ type: "adaptive" });
        expect(body.output_config).toEqual({ effort: want[level] });
      }
      expect(body.max_tokens).toBe(64000);
    }
  });

  test("budget: off sends nothing; budget_tokens per level, max_tokens above the budget", () => {
    const want: Record<ThinkingLevel, number | null> = { off: null, minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 62976 };
    for (const level of ALL) {
      const body = anthropic(model("budget"), level, { maxTokens: 2000 });
      if (want[level] === null) {
        expect(body.thinking).toBeUndefined();
        expect(body.max_tokens).toBe(2000);
      } else {
        // max 63999 is capped at maxOutputTokens - 1024 = 62976
        expect(body.thinking).toEqual({ type: "enabled", budget_tokens: want[level] });
        expect(body.max_tokens as number).toBeGreaterThan(want[level]!);
        expect(body.max_tokens as number).toBeLessThanOrEqual(64000);
      }
      expect(body.output_config).toBeUndefined();
    }
  });

  test("budget: capped at maxOutputTokens - 1024; below 1024 after the cap = no thinking", () => {
    const small = model("budget", ALL, 8192);
    expect(anthropic(small, "high")).toMatchObject({ thinking: { type: "enabled", budget_tokens: 7168 }, max_tokens: 8192 });
    expect(anthropic(small, "minimal")).toMatchObject({ thinking: { type: "enabled", budget_tokens: 1024 } });
    const tiny = anthropic(model("budget", ALL, 2000), "max");
    expect(tiny.thinking).toBeUndefined();
    expect(tiny.max_tokens).toBe(2000);
  });

  test("format none and a model without levels send nothing", () => {
    for (const level of ALL) {
      expect(anthropic(model("none"), level).thinking).toBeUndefined();
      expect(anthropic(model("effort", []), level).thinking).toBeUndefined();
    }
  });

  test("the level is clamped onto the model's levels; the legacy thinking switch means medium", () => {
    const some = model("effort", ["off", "low", "high"]);
    expect(anthropic(some, "medium").output_config).toEqual({ effort: "high" });
    expect(anthropic(some, "max").output_config).toEqual({ effort: "high" });
    expect(anthropic(some, "minimal").output_config).toEqual({ effort: "low" });
    expect(anthropicParams(request(undefined, { thinking: true }), ctx(some, "anthropic")).output_config).toEqual({ effort: "high" });
  });
});

describe("openai adapter", () => {
  test("effort: reasoning_effort is the level's name; off leaves it out", () => {
    for (const level of ALL) expect(openai(model("effort"), level).reasoning_effort).toBe(level === "off" ? undefined : level);
  });

  test('gemini (reasoningOff none) sends "none" for off', () => {
    expect(openai(model("effort"), "off", { reasoningOff: "none" }).reasoning_effort).toBe("none");
    expect(openai(model("effort"), "high", { reasoningOff: "none" }).reasoning_effort).toBe("high");
  });

  test("format none sends nothing (also for gemini)", () => {
    for (const level of ALL) {
      expect(openai(model("none"), level).reasoning_effort).toBeUndefined();
      expect(openai(model("none", []), level, { reasoningOff: "none" }).reasoning_effort).toBeUndefined();
    }
  });
});

describe("nearestSupportedThinkingLevel", () => {
  test("exact, then up, then down, then off", () => {
    expect(nearestSupportedThinkingLevel("medium", ["off", "low", "medium", "high"])).toBe("medium");
    expect(nearestSupportedThinkingLevel("minimal", ["off", "low", "high"])).toBe("low");
    expect(nearestSupportedThinkingLevel("medium", ["low", "high"])).toBe("high");
    expect(nearestSupportedThinkingLevel("max", ["low", "medium"])).toBe("medium");
    expect(nearestSupportedThinkingLevel("off", ["low", "high"])).toBe("low");
    expect(nearestSupportedThinkingLevel("high", [])).toBe("off");
    expect(nearestSupportedThinkingLevel("high", undefined)).toBe("off");
  });
});

describe("models.dev levels and format", () => {
  test("thinkingLevelsFromModelsDev", () => {
    expect(thinkingLevelsFromModelsDev(false, [{ type: "effort", values: ["low", "high"] }])).toEqual([]);
    expect(thinkingLevelsFromModelsDev(true, undefined)).toEqual(["low", "medium", "high"]);
    expect(thinkingLevelsFromModelsDev(true, [])).toEqual(["low", "medium", "high"]);
    expect(thinkingLevelsFromModelsDev(true, [{ type: "toggle" }])).toEqual(["off", "medium"]);
    expect(thinkingLevelsFromModelsDev(true, [{ type: "budget_tokens", min: 1024, max: 32000 }])).toEqual(["off", "medium"]);
    expect(thinkingLevelsFromModelsDev(true, [{ type: "effort", values: ["high", "none", "minimal", "bogus", null] }])).toEqual(["off", "minimal", "high"]);
    expect(thinkingLevelsFromModelsDev(true, [{ type: "effort", values: ["xhigh", "max"] }, { type: "toggle" }])).toEqual(["off", "medium", "xhigh", "max"]);
    expect(thinkingLevelsFromModelsDev(true, [{ nothing: true }])).toEqual(["low", "medium", "high"]);
  });

  test("thinkingFormatFromModelsDev: none without levels; anthropic budget only with budget_tokens and no effort values", () => {
    expect(thinkingFormatFromModelsDev([], [{ type: "budget_tokens" }], "anthropic")).toBe("none");
    expect(thinkingFormatFromModelsDev(["off", "medium"], [{ type: "budget_tokens" }], "anthropic")).toBe("budget");
    expect(thinkingFormatFromModelsDev(["off", "low", "high"], [{ type: "budget_tokens" }, { type: "effort", values: ["low", "high"] }], "anthropic")).toBe("effort");
    expect(thinkingFormatFromModelsDev(["low", "medium", "high"], undefined, "anthropic")).toBe("effort");
    expect(thinkingFormatFromModelsDev(["off", "medium"], [{ type: "budget_tokens" }], "openai")).toBe("effort");
  });
});
