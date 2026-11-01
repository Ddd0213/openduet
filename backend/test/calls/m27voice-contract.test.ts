// M27 contract B: the fixed voice addresses agree with what calls / presets use today (mainland
// StepFun is unchanged), the region rule, the voice lists per region, and the additive shapes
// (an M13-shaped VoiceSettings still parses with defaults; region / transcription default).
import { describe, expect, test } from "bun:test";
import { STEPFUN_REALTIME_URL, GEMINI_LIVE_URL } from "../../src/calls/credentials.ts";
import { VOICES } from "../../src/calls/voices.ts";
import { VoiceEngine, VoiceSettings, UpdateVoiceSettingsRequest } from "../../src/contract/m13.ts";
import { CreateModelProviderRequest, ModelProvider, RemoteModel, UpdateModelProviderRequest } from "../../src/contract/m12.ts";
import {
  defaultProviderRegion, DICTATION_DEFAULTS, ProviderRegion, REALTIME_VOICES, realtimeVoicesOf, REGIONS_OF, TranscriptionLanguage,
  VOICE_ENDPOINTS, voiceEndpointsOf, VoiceProviderKind,
} from "../../src/contract/m27voice.ts";
import { PRESETS } from "../../src/models/presets.ts";

describe("M27 voice contract", () => {
  test("the voice kinds are the realtime engines", () => {
    expect(VoiceProviderKind.options).toEqual(VoiceEngine.options);
    expect(ProviderRegion.options).toEqual(["cn", "intl"]);
    expect(REGIONS_OF.stepfun).toEqual(["cn", "intl"]);
    expect(REGIONS_OF.gemini).toBeUndefined();
  });

  test("mainland StepFun and Gemini keep today's addresses; international is api.stepfun.ai", () => {
    expect(VOICE_ENDPOINTS["stepfun:cn"].chatBaseUrl).toBe(PRESETS.stepfun.baseUrl);
    expect(VOICE_ENDPOINTS["stepfun:cn"].realtimeUrl).toBe(STEPFUN_REALTIME_URL);
    expect(VOICE_ENDPOINTS.gemini.chatBaseUrl).toBe(PRESETS.gemini.baseUrl);
    expect(VOICE_ENDPOINTS.gemini.realtimeUrl).toBe(GEMINI_LIVE_URL);
    expect(VOICE_ENDPOINTS["stepfun:intl"]).toMatchObject({ chatBaseUrl: "https://api.stepfun.ai/v1", realtimeUrl: "wss://api.stepfun.ai/v1/realtime" });
    expect(voiceEndpointsOf("stepfun", null)).toBe(VOICE_ENDPOINTS["stepfun:cn"]);
    expect(voiceEndpointsOf("stepfun", "intl")).toBe(VOICE_ENDPOINTS["stepfun:intl"]);
    expect(voiceEndpointsOf("gemini", null)).toBe(VOICE_ENDPOINTS.gemini);
    expect(voiceEndpointsOf("openai", null)).toBeNull();
    for (const key of ["stepfun:cn", "stepfun:intl"] as const) {
      expect(VOICE_ENDPOINTS[key]).toMatchObject({ transcription: "asr_sse", transcriptionPath: "/audio/asr/sse" });
    }
    expect(VOICE_ENDPOINTS.gemini).toMatchObject({ transcription: "chat_audio", transcriptionPath: null, transcriptionLanguages: null });
  });

  test("a new StepFun provider's region comes from User.region (unknown: cn); Gemini has none", () => {
    expect(defaultProviderRegion("stepfun", "CN")).toBe("cn");
    expect(defaultProviderRegion("stepfun", "cn")).toBe("cn");
    expect(defaultProviderRegion("stepfun", "US")).toBe("intl");
    expect(defaultProviderRegion("stepfun", "HK")).toBe("intl");
    expect(defaultProviderRegion("stepfun", null)).toBe("cn");
    expect(defaultProviderRegion("gemini", "US")).toBeNull();
    expect(defaultProviderRegion("openai", "CN")).toBeNull();
  });

  test("voices: M13's lists for Gemini and mainland StepFun, the international site's own list", () => {
    expect(REALTIME_VOICES.gemini).toEqual(VOICES.gemini);
    expect(REALTIME_VOICES["stepfun:cn"]).toEqual(VOICES.stepfun);
    expect(realtimeVoicesOf("stepfun", "intl")).toContain("lively-girl");
    expect(realtimeVoicesOf("stepfun", "intl")).not.toContain("qingchunshaonv");
    expect(realtimeVoicesOf("stepfun", null)).toEqual(VOICES.stepfun);
    expect(realtimeVoicesOf("custom", null)).toEqual([]);
  });

  test("additive: an M13 VoiceSettings parses with the defaults; region and transcription default", () => {
    const old = VoiceSettings.parse({ modelId: null, voice: null, voices: { gemini: [], stepfun: [] }, configured: false });
    expect(old.providers).toEqual([]);
    expect(old.presets).toEqual([]);
    expect(old.dictation).toEqual(DICTATION_DEFAULTS);
    const provider = ModelProvider.parse({
      id: "p1", kind: "openai", protocol: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", auth: null, key: { set: true, last4: "abcd" },
      headers: [], status: "active", error: null, imported: false, modelCount: 0, createdAt: "2026-11-02T08:00:00.000Z",
    });
    expect(provider.region).toBeNull();
    const row = RemoteModel.parse({
      modelId: "m", label: "m", contextWindow: 1, maxOutputTokens: 1, thinkingLevels: [], thinkingFormat: "none", tools: true, vision: false,
      realtime: false, source: "default", addedAs: null,
    });
    expect(row.transcription).toBe(false);
  });

  test("requests: region and dictation are optional, strict and validated", () => {
    expect(CreateModelProviderRequest.safeParse({ kind: "stepfun", key: "k", region: "intl" }).success).toBe(true);
    expect(CreateModelProviderRequest.safeParse({ kind: "stepfun", key: "k", region: "eu" }).success).toBe(false);
    expect(UpdateModelProviderRequest.safeParse({ region: "cn" }).success).toBe(true);
    expect(UpdateVoiceSettingsRequest.safeParse({ dictation: { engine: "cloud", providerId: "p", modelId: "m" } }).success).toBe(true);
    expect(UpdateVoiceSettingsRequest.safeParse({ dictation: { engine: "server" } }).success).toBe(false);
    expect(UpdateVoiceSettingsRequest.safeParse({ dictation: { url: "x" } }).success).toBe(false);
    expect(UpdateVoiceSettingsRequest.safeParse({ dictation: { modelId: "" } }).success).toBe(false);
    expect(UpdateVoiceSettingsRequest.safeParse({}).success).toBe(true);
  });

  test("the language field takes a BCP 47 tag", () => {
    for (const ok of ["zh", "zh-CN", "zh-Hans-CN", "en-US", "yue"]) expect(TranscriptionLanguage.safeParse(ok).success).toBe(true);
    for (const bad of ["", "z", "zh_CN", "中文", "en-US-"]) expect(TranscriptionLanguage.safeParse(bad).success).toBe(false);
  });
});
