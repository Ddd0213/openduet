// M13: how the phone connects to the voice provider (contract "Credentials").
// - gemini: a one-use token minted with the vault key (v1alpha/auth_tokens); the key stays here.
// - stepfun: there's no short-lived credential, so it's the key itself, answered only to its signed-in
//   owner over POST /api/calls. Never logged, never in an event, a run record or a message.
// Provider error bodies can echo request data, so a failed mint reports the status only.
import type { z } from "zod";
import type { VoiceCredential } from "../contract/m13.ts";
import { VOICE_ENDPOINTS, voiceEndpointsOf, type ProviderRegion } from "../contract/m27voice.ts";
import type { Fetch } from "../llm/index.ts";
import type { Engine } from "./voices.ts";

export const GEMINI_TOKEN_URL = "https://generativelanguage.googleapis.com/v1alpha/auth_tokens";
export const GEMINI_LIVE_URL = VOICE_ENDPOINTS.gemini.realtimeUrl;
export const STEPFUN_REALTIME_URL = VOICE_ENDPOINTS["stepfun:cn"].realtimeUrl;
/** the token's lifetime, and how soon a session must start with it */
export const TOKEN_TTL_MS = 30 * 60_000;
export const NEW_SESSION_MS = 60_000;
const MINT_TIMEOUT_MS = 15_000;

export type Credential = z.infer<typeof VoiceCredential>;
export type Minted = { ok: true; url: string; credential: Credential } | { ok: false; reason: string };

export interface CredentialDeps {
  fetch: Fetch;
  now: () => Date;
}

/** The WebSocket URL and credential for one start (or resume) of a call. */
export async function credentialFor(deps: CredentialDeps, engine: Engine, modelId: string, key: string, region: ProviderRegion | null = null): Promise<Minted> {
  if (engine === "stepfun") {
    return { ok: true, url: `${voiceEndpointsOf(engine, region)!.realtimeUrl}?model=${encodeURIComponent(modelId)}`, credential: { kind: "key", value: key } };
  }
  return mintGeminiToken(deps, key);
}

async function mintGeminiToken(deps: CredentialDeps, key: string): Promise<Minted> {
  const now = deps.now().getTime();
  const expireTime = new Date(now + TOKEN_TTL_MS).toISOString();
  const newSessionExpireTime = new Date(now + NEW_SESSION_MS).toISOString();
  let response: Response;
  try {
    response = await deps.fetch(GEMINI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ uses: 1, expireTime, newSessionExpireTime }),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      // the key header must never follow a redirect to another host
      redirect: "error",
    });
  } catch (error) {
    const name = (error as Error).name;
    return { ok: false, reason: name === "TimeoutError" ? "Google didn't answer in time." : "Couldn't reach Google." };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: `Google answered ${response.status} to the token request. Check the Gemini key.` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "Google's token answer wasn't readable." };
  }
  const name = body && typeof body === "object" ? (body as { name?: unknown }).name : undefined;
  if (typeof name !== "string" || !name) return { ok: false, reason: "Google's token answer had no token." };
  return { ok: true, url: GEMINI_LIVE_URL, credential: { kind: "token", value: name, expiresAt: expireTime } };
}
