// M13: the voices each realtime engine offers (one constant, easy to extend) and the tools the
// voice model gets (the phone declares them to the provider exactly as given).
import type { z } from "zod";
import type { VoiceEngine, VoiceTool } from "../contract/m13.ts";
import { REALTIME_VOICES, realtimeVoicesOf, type ProviderRegion } from "../contract/m27voice.ts";

export type Engine = z.infer<typeof VoiceEngine>;

/** Each engine's voices; the first is the engine's default. */
export const VOICES: Readonly<Record<Engine, readonly string[]>> = {
  gemini: REALTIME_VOICES.gemini,
  stepfun: REALTIME_VOICES["stepfun:cn"],
};

export const voicesOf = (engine: Engine, region: ProviderRegion | null = null): readonly string[] => realtimeVoicesOf(engine, region);
export const defaultVoice = (engine: Engine, region: ProviderRegion | null = null): string => voicesOf(engine, region)[0]!;
export const isVoiceOf = (engine: Engine, voice: string, region: ProviderRegion | null = null): boolean => voicesOf(engine, region).includes(voice);
export const anyEngineHas = (voice: string): boolean => Object.values(REALTIME_VOICES).some((list) => list.includes(voice));

/** The VoiceSettings.voices shape. */
export const voiceLists = () => ({ gemini: [...VOICES.gemini], stepfun: [...VOICES.stepfun] });

export const VOICE_TOOLS: z.infer<typeof VoiceTool>[] = [
  {
    name: "send_to_assistant",
    description: "Pass the user's request to OpenDuet, which does the work. Use it for anything the user wants done, looked up, written or changed. Write the request in full sentences; the user's own words are attached for you.",
    parameters: { type: "object", properties: { text: { type: "string", description: "What to ask OpenDuet, in full sentences." } }, required: ["text"] },
  },
  {
    name: "assistant_status",
    description: "Check whether OpenDuet is working on something in this channel, what it's doing, whether a card waits for approval and the start of its latest reply.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "stop_assistant",
    description: "Stop what OpenDuet is doing in this channel, when the user asks to stop or cancel it.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "search_memory",
    description: "Look something up in what OpenDuet remembers for this channel (facts about the user and this channel).",
    parameters: { type: "object", properties: { query: { type: "string", description: "A few words to look for." } }, required: ["query"] },
  },
];
