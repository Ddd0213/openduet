// M22 (#47): the setup rows' view of the models module. The chat row: the user's default model when
// it's usable (purpose chat, tools, a provider with a key: models/rows.ts), with a fingerprint of
// its entry, provider and key rows so a change since the last check shows "not checked" again. The
// check: one tiny call through the resolver's llm.stream() (AGENT.md: models only via llm/), no
// tools, a few output tokens, stopped at the first event. Voice: the model calls would use.
import { LlmError, nearestSupportedThinkingLevel, type ModelResolver } from "../llm/index.ts";
import type { Db } from "../db.ts";
import { KEY_NAME, OWNER_KIND, usableChatEntry } from "../models/rows.ts";
import type { Outcome, SetupModels } from "./service.ts";

export const MODEL_TIMEOUT_MS = 20_000;
/** Enough for a reasoning model to start answering; the call stops at the first event anyway. */
export const PING_MAX_TOKENS = 32;
const PING_SYSTEM = "This is a connection check. Reply with one word.";

export interface SetupModelsDeps {
  db: Db;
  resolver: ModelResolver;
  /** the one-time models.json / LLM_* import (ModelService.ready) */
  ready: (userId: string) => Promise<void>;
  /** RealtimeModels.pick: the voice model calls would use */
  voice: (userId: string) => Promise<{ entry: { label: string } } | null>;
  timeoutMs?: number;
}

export function setupModels(deps: SetupModelsDeps): SetupModels {
  const { db } = deps;
  return {
    async chat(userId) {
      await deps.ready(userId);
      const user = await db.user.findUnique({ where: { id: userId }, select: { defaultModelId: true } });
      const entry = user?.defaultModelId ? await usableChatEntry(db, userId, user.defaultModelId) : null;
      if (!entry) return null;
      const [provider, secret] = await Promise.all([
        db.modelProvider.findFirst({ where: { id: entry.providerId, userId }, select: { updatedAt: true } }),
        db.vaultSecret.findFirst({ where: { userId, ownerKind: OWNER_KIND, ownerId: entry.providerId, name: KEY_NAME }, select: { updatedAt: true } }),
      ]);
      const fingerprint = [entry.id, entry.updatedAt.getTime(), provider?.updatedAt.getTime() ?? 0, secret?.updatedAt.getTime() ?? 0].join(":");
      return { label: entry.label, fingerprint, serverWebTools: entry.serverWebTools };
    },

    async ping(userId): Promise<Outcome> {
      const resolved = await deps.resolver.resolve({ userId, channelId: null, role: "chat" });
      if (!resolved) return { ok: false, detail: { key: "setup.model.missing" } };
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deps.timeoutMs ?? MODEL_TIMEOUT_MS);
      try {
        let answered = false;
        for await (const event of resolved.llm.stream({
          role: "chat", system: PING_SYSTEM, maxTokens: PING_MAX_TOKENS, signal: controller.signal,
          thinkingLevel: nearestSupportedThinkingLevel("off", resolved.model.thinkingLevels),
          messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
        })) {
          void event;
          // Any event: the provider took the key and the model answers.
          answered = true;
          break;
        }
        return answered ? { ok: true } : { ok: false, detail: { key: "system.model_invalid_response" } };
      } catch (error) {
        if (timedOut) return { ok: false, detail: { key: "system.model_timeout" } };
        if (error instanceof LlmError) return { ok: false, detail: error.toPhrase() };
        return { ok: false, detail: { key: "system.model_network" } };
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },

    async voice(userId) {
      const picked = await deps.voice(userId);
      return picked ? { label: picked.entry.label } : null;
    },
  };
}
