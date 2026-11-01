// M27 contract B: voice settings apart from models, StepFun's region, optional cloud dictation.
// New leaf shapes and tables only; what M27 adds to older shapes (ModelProvider.region and the
// create / update requests, RemoteModel.transcription in m12.ts; VoiceSettings.providers / presets
// / dictation and UpdateVoiceSettingsRequest.dictation in m13.ts) is declared next to those shapes
// and points back here. Semantics: docs/API.md "## M27 voice".
//
// Additive, so an app built before M27 keeps decoding: every new response field has a default, the
// models API still lists realtime entries, and the old voice-settings fields keep their meaning.
import { z } from "zod";
import { Id } from "./common.ts";
import { SecretInfo } from "./m11.ts";

// ---------------------------------------------------------------- regions and addresses

/**
 * A provider's site. cn = mainland China, intl = international. Only kinds in REGIONS_OF have one;
 * the others read null. A value this build doesn't know reads null in the app.
 */
export const ProviderRegion = z.enum(["cn", "intl"]);
export type ProviderRegion = z.infer<typeof ProviderRegion>;

/** The provider kinds the Voice page shows (the same values as m13 VoiceEngine). */
export const VoiceProviderKind = z.enum(["gemini", "stepfun"]);
export type VoiceProviderKind = z.infer<typeof VoiceProviderKind>;

/** The regions a kind offers, first = the default for existing rows; a kind not listed has none. */
export const REGIONS_OF: Readonly<Partial<Record<string, readonly ProviderRegion[]>>> = {
  stepfun: ["cn", "intl"],
};

/**
 * How a kind's cloud dictation goes on the wire (llm/ picks the request shape from this, not from
 * the vendor's name):
 * - chat_audio: a chat completion with an `input_audio` part (wav, base64) through llm stream();
 * - asr_sse: POST {chat base}{transcriptionPath} JSON {audio:{data, input:{transcription:{model,
 *   language}, format:{type:"wav"}}}} answered as SSE; the text is `transcript.text.done`.text.
 */
export const TranscriptionWire = z.enum(["chat_audio", "asr_sse"]);
export type TranscriptionWire = z.infer<typeof TranscriptionWire>;

/**
 * The `language` values StepFun's /v1/audio/asr/sse documents (ja, ko, fr, es in preview). Without
 * one it assumes English, so the server always sends one.
 */
export const STEPFUN_ASR_LANGUAGES: readonly string[] = ["zh", "en", "ja", "ko", "fr", "es"];

export interface VoiceEndpoints {
  /** the chat / model-list base a new provider of this kind and region gets (presets.ts baseUrl) */
  chatBaseUrl: string;
  /** the realtime WebSocket StartCallResponse.url is built on (StepFun: + ?model=<id>) */
  realtimeUrl: string;
  transcription: TranscriptionWire;
  /** asr_sse only: appended to the provider's chat base URL */
  transcriptionPath: string | null;
  /** the languages (primary subtag) its dictation takes; null = any (passed as a hint) */
  transcriptionLanguages: readonly string[] | null;
}

/**
 * The fixed addresses per kind and region (key: "<kind>" for a kind without regions, else
 * "<kind>:<region>"). The user never types one. Read from StepFun's and Google's public docs on
 * 2026-10-29 (URLs in docs/API.md "## M27 voice"): platform.stepfun.com (cn) and platform.stepfun.ai
 * (intl) document the same paths on api.stepfun.com / api.stepfun.ai.
 */
export const VOICE_ENDPOINTS: Readonly<Record<"gemini" | "stepfun:cn" | "stepfun:intl", VoiceEndpoints>> = {
  gemini: {
    chatBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    realtimeUrl: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
    transcription: "chat_audio",
    transcriptionPath: null,
    transcriptionLanguages: null,
  },
  "stepfun:cn": {
    chatBaseUrl: "https://api.stepfun.com/v1",
    realtimeUrl: "wss://api.stepfun.com/v1/realtime",
    transcription: "asr_sse",
    transcriptionPath: "/audio/asr/sse",
    transcriptionLanguages: STEPFUN_ASR_LANGUAGES,
  },
  "stepfun:intl": {
    chatBaseUrl: "https://api.stepfun.ai/v1",
    realtimeUrl: "wss://api.stepfun.ai/v1/realtime",
    transcription: "asr_sse",
    transcriptionPath: "/audio/asr/sse",
    transcriptionLanguages: STEPFUN_ASR_LANGUAGES,
  },
};

/**
 * The addresses of a voice kind in a region (a StepFun row with no region reads as cn, what it
 * used before M27); null for a kind that has no voice endpoints.
 */
export function voiceEndpointsOf(kind: string, region: ProviderRegion | null): VoiceEndpoints | null {
  if (kind === "gemini") return VOICE_ENDPOINTS.gemini;
  if (kind === "stepfun") return VOICE_ENDPOINTS[region === "intl" ? "stepfun:intl" : "stepfun:cn"];
  return null;
}

/**
 * The region a new provider of `kind` gets when the request has none: from User.region (M25,
 * X-Region): "CN" -> cn, any other country -> intl, unknown (null) -> cn (the site every install
 * used before M27). null for kinds without regions.
 */
export function defaultProviderRegion(kind: string, userRegion: string | null): ProviderRegion | null {
  if (!REGIONS_OF[kind]) return null;
  if (!userRegion) return "cn";
  return userRegion.toUpperCase() === "CN" ? "cn" : "intl";
}

/**
 * The realtime voices per kind and region, first = the default. gemini and stepfun:cn are M13's
 * lists unchanged (VoiceSettings.voices). stepfun:intl is the international site's documented list:
 * its realtime endpoint refuses other names with 400, so the mainland names aren't offered there.
 */
export const REALTIME_VOICES: Readonly<Record<keyof typeof VOICE_ENDPOINTS, readonly string[]>> = {
  gemini: ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"],
  "stepfun:cn": ["qingchunshaonv", "wenrounansheng", "linjiajiejie"],
  "stepfun:intl": ["soft-spoken-gentleman", "magnetic-voiced-male", "vibrant-youth", "lively-girl", "livelybreezy-female", "elegantgentle-female", "zixinnansheng"],
};

export function realtimeVoicesOf(kind: string, region: ProviderRegion | null): readonly string[] {
  if (kind === "gemini") return REALTIME_VOICES.gemini;
  if (kind === "stepfun") return REALTIME_VOICES[region === "intl" ? "stepfun:intl" : "stepfun:cn"];
  return [];
}
// ---------------------------------------------------------------- the Voice page

/** A realtime ModelEntry of a voice provider, as the Voice page's model row lists it. */
export const VoiceModelRow = z.object({ id: Id, modelId: z.string(), label: z.string() });

/**
 * One of the user's Gemini / StepFun providers (VoiceSettings.providers). The same ModelProvider row
 * the Models page shows: one key serves its chat and its voice models. No address: it follows
 * `kind` and `region` (VOICE_ENDPOINTS).
 */
export const VoiceProvider = z.object({
  id: Id,
  kind: VoiceProviderKind,
  name: z.string(),
  /** stepfun: cn | intl; gemini: null */
  region: ProviderRegion.nullable(),
  /** never the key itself: whether it's set and its last 4 characters */
  key: SecretInfo,
  /** the last check (ModelProvider.status / error) */
  status: z.enum(["active", "failed"]),
  error: z.string().nullable(),
  /** its realtime voices in its region, first = the default */
  voices: z.array(z.string()),
  /** its realtime ModelEntries (purpose realtime), oldest first */
  realtimeModels: z.array(VoiceModelRow),
});
export type VoiceProvider = z.infer<typeof VoiceProvider>;

/** A region a kind offers and the host it talks to (shown next to the region's name). */
export const VoiceRegionOption = z.object({ region: ProviderRegion, host: z.string() });

/**
 * What adding a provider of a kind needs (VoiceSettings.presets): the regions to pick from (none =
 * no region row) and the one a new provider gets by default (defaultProviderRegion).
 */
export const VoiceProviderPreset = z.object({
  kind: VoiceProviderKind,
  regions: z.array(VoiceRegionOption),
  defaultRegion: ProviderRegion.nullable(),
});

// ---------------------------------------------------------------- dictation (the composer mic)

/** device = Apple's recognizer (SFSpeechRecognizer, the default); cloud = POST /api/transcriptions. */
export const DictationEngine = z.enum(["device", "cloud"]);
export type DictationEngine = z.infer<typeof DictationEngine>;

/** VoiceSettings.dictation (User.dictation* columns). */
export const DictationSettings = z.object({
  engine: DictationEngine,
  /** device engine only: Apple's recognizer must not send audio off the iPhone */
  onDeviceOnly: z.boolean(),
  /** cloud engine: a Gemini or StepFun ModelProvider id, and the model id sent to it */
  providerId: Id.nullable(),
  modelId: z.string().nullable(),
  /** the provider exists, is a voice kind, isn't failed, has a key, and a model id is set */
  cloudReady: z.boolean(),
});
export type DictationSettings = z.infer<typeof DictationSettings>;
export const DICTATION_DEFAULTS: DictationSettings = { engine: "device", onDeviceOnly: false, providerId: null, modelId: null, cloudReady: false };

/**
 * UpdateVoiceSettingsRequest.dictation: only the fields that change. providerId must be the user's
 * Gemini / StepFun provider (400 field `dictation.providerId`); a new providerId without modelId
 * clears modelId; modelId needs a provider (400 `dictation.modelId`). Not checked against the
 * provider's list (its ASR models may not be listed); a wrong id fails at transcription time.
 */
export const UpdateDictationSettingsRequest = z.object({
  engine: DictationEngine,
  onDeviceOnly: z.boolean(),
  providerId: Id.nullable(),
  modelId: z.string().trim().min(1).max(200).nullable(),
}).partial().strict();

// ---------------------------------------------------------------- POST /api/transcriptions

/** The upload: a WAV file, linear PCM 16-bit, 1-2 channels, 8000-48000 Hz (the app sends 16 kHz mono). */
export const TRANSCRIPTION_MAX_BYTES = 8 * 1024 * 1024;
/** from the WAV header (data bytes / byte rate); longer is 413 too_large */
export const TRANSCRIPTION_MAX_SECONDS = 120;
/** shorter is 400 validation_failed field `file` (the app doesn't send under 0.5 s) */
export const TRANSCRIPTION_MIN_SECONDS = 0.3;
export const TRANSCRIPTION_SAMPLE_RATES = { min: 8000, max: 48000 } as const;
/** how long the server waits for the provider */
export const TRANSCRIPTION_TIMEOUT_MS = 60_000;

/**
 * The multipart text field `language` (optional): a BCP 47 tag; only its primary subtag is used
 * ("zh-Hans-CN" -> zh). Default: User.language (zh-Hans -> zh, else en).
 */
export const TranscriptionLanguage = z.string().trim().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/).max(35);

/** 200: the recognized text, trimmed; "" when nothing was said. Not stored anywhere. */
export const TranscriptionResponse = z.object({ text: z.string() });
export type TranscriptionResponse = z.infer<typeof TranscriptionResponse>;

/**
 * Stable error codes of POST /api/transcriptions besides the shared ones (400 validation_failed
 * fields `file` / `language`, 413 too_large, 415 unsupported_type, 400 not_configured). Nothing is
 * stored either way.
 */
export const TranscriptionErrorCode = z.enum([
  /** 502: the provider refused or failed (key refused, rate limit, timeout, unreachable, no text);
   * the message is the server's plain words, never the provider's body */
  "transcription_failed",
]);
export type TranscriptionErrorCode = z.infer<typeof TranscriptionErrorCode>;
