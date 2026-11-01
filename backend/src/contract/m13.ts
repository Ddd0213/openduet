// M13: realtime voice. The phone talks to Gemini Live or StepFun Realtime directly (audio never
// goes through the server); the server owns the call: the voice's instructions and tools, the
// hand-offs to OpenDuet, the transcript and the call's one line in the chat. Semantics:
// .pi/handoff/m13-contract.md.
import { z } from "zod";
import { Id, IsoDate } from "./common.ts";
import { DICTATION_DEFAULTS, DictationSettings, UpdateDictationSettingsRequest, VoiceProvider, VoiceProviderPreset } from "./m27voice.ts";
import { Message } from "./messages.ts";

export const VoiceEngine = z.enum(["gemini", "stepfun"]);
export const CallLineFrom = z.enum(["user", "voice"]);

/** A transcript line, as the phone heard it. `id` is the phone's (a line is kept once per id). */
export const CallLine = z.object({
  id: z.string().min(1).max(64),
  from: CallLineFrom,
  text: z.string().max(4000),
  at: IsoDate,
});

export const Call = z.object({
  id: Id,
  channelId: Id,
  engine: VoiceEngine,
  /** the ModelEntry (purpose realtime) and the id sent to the provider */
  modelEntryId: Id,
  modelId: z.string(),
  voice: z.string(),
  status: z.enum(["open", "ended"]),
  startedAt: IsoDate,
  endedAt: IsoDate.nullable(),
  seconds: z.number().int().min(0),
  /** a few words from the background model in the user's language; "" until the call ends */
  title: z.string(),
});

/** One function the voice model can call (the phone declares them to the provider as they are). */
export const VoiceToolName = z.enum(["send_to_assistant", "assistant_status", "stop_assistant", "search_memory"]);
export const LEGACY_VOICE_TOOL_NAMES = {
  send_to_claude: "send_to_assistant",
  claude_status: "assistant_status",
  stop_claude: "stop_assistant",
} as const;
const InputVoiceToolName = z.preprocess((value) => typeof value === "string" ? LEGACY_VOICE_TOOL_NAMES[value as keyof typeof LEGACY_VOICE_TOOL_NAMES] ?? value : value, VoiceToolName);

export const VoiceTool = z.object({
  name: VoiceToolName,
  description: z.string(),
  /** JSON Schema of the arguments */
  parameters: z.record(z.string(), z.unknown()),
});

/**
 * How the phone connects. Gemini: a one-use token (`token`, minted per start with the vault key;
 * the key never leaves the server). StepFun: there's no short-lived credential, so it's the key
 * itself (`key`): keep it in memory only, never on disk or in the Keychain, drop it on hang-up.
 */
export const VoiceCredential = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("token"), value: z.string(), expiresAt: IsoDate }),
  z.object({ kind: z.literal("key"), value: z.string() }),
]);

/** POST /api/calls (start, or again with callId to resume / reconnect the same call). */
export const StartCallRequest = z.object({
  channelId: Id,
  /** resume: the open call (a fresh credential, and "this call so far" in the instructions) */
  callId: Id.optional(),
  /** a realtime ModelEntry; default: the voice settings' model */
  modelId: Id.optional(),
  voice: z.string().max(64).optional(),
  /** the phone's language, for speaking before the user has */
  language: z.string().max(16).optional(),
}).strict();
export const StartCallResponse = z.object({
  call: Call,
  /** the provider's model id and the WebSocket URL to open (StepFun: with ?model=) */
  model: z.string(),
  url: z.string(),
  credential: VoiceCredential,
  instructions: z.string(),
  tools: z.array(VoiceTool),
});

/** POST /api/calls/:id/lines: the transcript as it's spoken -> 204. */
export const CallLinesRequest = z.object({ lines: z.array(CallLine).min(1).max(100) }).strict();
/** POST /api/calls/:id/tool: one of the voice's tool calls; lines not sent yet go with it. */
export const CallToolRequest = z.object({
  name: InputVoiceToolName,
  arguments: z.record(z.string(), z.unknown()).default({}),
  lines: z.array(CallLine).max(100).default([]),
}).strict();
/** The tool's answer, for the voice model (a failure is an answer too). */
export const CallToolResponse = z.object({ result: z.string() });
/** POST /api/calls/:id/end -> the call's line in the chat (kind call). Ending twice is fine. */
export const EndCallRequest = z.object({
  seconds: z.number().int().min(0).max(86_400),
  lines: z.array(CallLine).max(100).default([]),
}).strict();

/** GET /api/calls/:id: the whole conversation (opened from the call's line). */
export const CallDetail = z.object({
  call: Call,
  lines: z.array(CallLine),
  /** what the call handed to OpenDuet and OpenDuet's replies in those turns (hidden in the chat), oldest first */
  messages: z.array(Message),
});

/** The voice settings (Everything → Voice). */
export const VoiceSettings = z.object({
  /** a realtime ModelEntry (Gemini or StepFun provider), or null */
  modelId: Id.nullable(),
  voice: z.string().nullable(),
  /**
   * the voices each engine offers. M27: stepfun is the mainland list (stepfun:cn); a provider's
   * own list (its region's) is VoiceProvider.voices
   */
  voices: z.object({ gemini: z.array(z.string()), stepfun: z.array(z.string()) }),
  /** a realtime model whose provider has a key (also Me.features.voice) */
  configured: z.boolean(),
  /** M27 (m27voice.ts): the user's Gemini / StepFun providers, oldest first, each with its key state */
  providers: z.array(VoiceProvider).default([]),
  /** M27: what adding a Gemini / StepFun provider needs (its regions) */
  presets: z.array(VoiceProviderPreset).default([]),
  /** M27: the composer microphone's recognizer */
  dictation: DictationSettings.default(DICTATION_DEFAULTS),
});
/** PUT /api/voice-settings -> VoiceSettings */
export const UpdateVoiceSettingsRequest = z.object({
  modelId: Id.nullable(),
  voice: z.string().max(64).nullable(),
  /** M27: the recognizer's fields that change (m27voice.ts UpdateDictationSettingsRequest) */
  dictation: UpdateDictationSettingsRequest,
}).partial().strict();

/**
 * SSE `call` event: what the voice should say. reply = OpenDuet's final reply (shortened for
 * speech), notice = a card waiting for the user ("…needs your approval on the card") or a failure,
 * progress = OpenDuet's activity (at most one per 15 s). `seq` rises through the call; skip repeats.
 */
export const CallCue = z.object({
  callId: Id,
  kind: z.enum(["reply", "notice", "progress"]),
  text: z.string(),
  seq: z.number().int(),
});
