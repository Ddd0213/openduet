// M27: saved dictation choices and an in-memory recording, with no runs, events or file writes.
import type { User } from "@prisma/client";
import type { z } from "zod";
import { TranscriptionLanguage, voiceEndpointsOf, type DictationSettings, type UpdateDictationSettingsRequest, type VoiceProvider } from "../contract/m27voice.ts";
import type { Db } from "../db.ts";
import { HttpError } from "../http.ts";
import { LlmError, transcribe, type Fetch } from "../llm/index.ts";
import { log } from "../log.ts";
import { VOICE_PROVIDER_KINDS, type RealtimeModels } from "../models/realtime.ts";
import { providerOf } from "../models/resolver.ts";
import { hostOf } from "../models/net.ts";
import { readWav } from "./wav.ts";

export function dictationOf(user: User, providers: readonly VoiceProvider[]): DictationSettings {
  const provider = providers.find((p) => p.id === user.dictationProviderId);
  return { engine: user.dictationEngine === "cloud" ? "cloud" : "device", onDeviceOnly: user.dictationOnDevice,
    providerId: provider?.id ?? null, modelId: user.dictationModelId,
    cloudReady: !!provider && provider.status !== "failed" && provider.key.set && !!user.dictationModelId };
}
const invalid = (field: string, reason: string) => new HttpError(400, "validation_failed", `${field}: ${reason}`, field);

/** Only sent fields are written; a provider change additionally clears its old model. */
export async function dictationUpdate(db: Db, user: User, input: z.infer<typeof UpdateDictationSettingsRequest>) {
  const providerId = input.providerId !== undefined ? input.providerId : user.dictationProviderId;
  const provider = providerId ? await db.modelProvider.findFirst({ where: { id: providerId, userId: user.id, kind: { in: [...VOICE_PROVIDER_KINDS] } } }) : null;
  if (input.providerId && !provider) throw invalid("dictation.providerId", "not a Gemini or StepFun provider");
  if (input.modelId && !provider) throw invalid("dictation.modelId", "choose a provider first");
  const clearModel = input.providerId === null || (input.providerId !== undefined && input.providerId !== user.dictationProviderId && input.modelId === undefined);
  return {
    ...(input.engine !== undefined ? { dictationEngine: input.engine } : {}),
    ...(input.onDeviceOnly !== undefined ? { dictationOnDevice: input.onDeviceOnly } : {}),
    ...(input.providerId !== undefined ? { dictationProviderId: input.providerId } : {}),
    ...(clearModel ? { dictationModelId: null } : input.modelId !== undefined ? { dictationModelId: input.modelId } : {}),
  };
}

export class Dictation {
  constructor(private readonly deps: { db: Db; realtime: RealtimeModels; fetch: Fetch }) {}

  async run(userId: string, file: File | null, rawLanguage: string | File | null): Promise<{ text: string }> {
    const began = performance.now();
    let kind: string | null = null, seconds: number | null = null, outcome = "validation_failed";
    try {
      if (!file || !file.size) throw invalid("file", "send a WAV recording");
      const audio = new Uint8Array(await file.arrayBuffer());
      seconds = readWav(audio).seconds;
      const user = await this.deps.db.user.findUniqueOrThrow({ where: { id: userId } });
      const provider = user.dictationProviderId ? await this.deps.db.modelProvider.findFirst({ where: { id: user.dictationProviderId, userId, kind: { in: [...VOICE_PROVIDER_KINDS] } } }) : null;
      kind = provider?.kind ?? null;
      const tag = rawLanguage === null ? (user.language === "zh-Hans" ? "zh" : "en") : rawLanguage;
      const parsed = TranscriptionLanguage.safeParse(tag);
      if (!parsed.success) throw invalid("language", "send a BCP 47 language tag");
      const language = parsed.data.split("-")[0]!.toLowerCase();
      const endpoints = provider ? voiceEndpointsOf(provider.kind, provider.region === "intl" ? "intl" : null) : null;
      if (endpoints?.transcriptionLanguages && !endpoints.transcriptionLanguages.includes(language)) throw invalid("language", `StepFun can't transcribe ${language}`);
      const notConfigured = () => new HttpError(400, "not_configured", "Cloud dictation isn't set up: choose a provider and a model in Voice.");
      if (!provider || provider.status === "failed" || !user.dictationModelId || !endpoints) throw notConfigured();
      const key = await this.deps.realtime.providerKey(userId, provider.id);
      if (!key) throw notConfigured();
      let text: string;
      try {
        text = await transcribe({ provider: providerOf(provider), modelId: user.dictationModelId, key,
          transcription: endpoints.transcription, transcriptionPath: endpoints.transcriptionPath }, audio, { language, fetch: this.deps.fetch });
      } catch (error) {
        const name = provider.kind === "stepfun" ? "StepFun" : "Google", host = hostOf(provider.baseUrl);
        const code = error instanceof LlmError ? error.code : "network";
        const reason = code === "auth" ? "refused the key" : code === "timeout" ? "didn't answer in time" : code === "rate_limit" ? "is rate-limiting dictation" : code === "invalid_response" ? "answered without a readable transcription" : error instanceof LlmError && error.status ? `answered ${error.status}` : "couldn't be reached";
        throw new HttpError(502, "transcription_failed", `${name} ${reason} (${host}).`);
      }
      outcome = "ok";
      return { text };
    } catch (error) {
      outcome = error instanceof HttpError ? error.code : "internal";
      throw error;
    } finally {
      log.info("dictation", { kind, bytes: file?.size ?? 0, seconds, outcome, ms: Math.round(performance.now() - began) });
    }
  }
}
