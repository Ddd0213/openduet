// M27: dictation stays in the model layer. One overall deadline, no raw provider errors or logs.
import { z } from "zod";
import { TRANSCRIPTION_TIMEOUT_MS, type TranscriptionWire } from "../contract/m27voice.ts";
import { LlmError, type LlmErrorCode } from "./errors.ts";
import { createLlm } from "./stream.ts";
import type { Fetch, Model, Provider } from "./types.ts";
import { createModelFetch } from "./net.ts";

export interface TranscriptionTarget {
  transcription: TranscriptionWire;
  provider: Provider;
  modelId: string;
  key: string;
  transcriptionPath: string | null;
}
export interface TranscriptionOptions { language: string; signal?: AbortSignal; fetch?: Fetch }

function failure(target: TranscriptionTarget, code: LlmErrorCode, status?: number): LlmError {
  return new LlmError({ providerId: target.provider.id, modelId: target.modelId, attempts: 1,
    kind: code === "timeout" ? "timeout" : code === "config" ? "config" : status !== undefined ? "http" : "network", code, status });
}

/** Also bounds a non-cooperative mocked transport; cleanup never delays the deadline. */
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Aborted"));
    if (signal.aborted) { void promise.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

export async function transcribe(target: TranscriptionTarget, audio: Uint8Array, options: TranscriptionOptions): Promise<string> {
  const deadline = AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const data = Buffer.from(audio).toString("base64");
  try {
    if (signal.aborted) throw failure(target, "timeout");
    if (target.transcription === "asr_sse") return await asr(target, data, options.language, createModelFetch({ fetch: options.fetch }), signal);
    const model: Model = {
      id: target.modelId, provider: target.provider.id, label: target.modelId, contextWindow: 128_000, maxOutputTokens: 8192,
      capabilities: { tools: false, vision: false, thinking: false, serverWebTools: false, promptCaching: false },
      thinkingLevels: ["off"], thinkingFormat: "effort",
    };
    const llm = createLlm({ providers: [target.provider], models: [model],
      roles: { chat: [model.id], task: [model.id], proactive: [model.id], utility: [model.id] }, timeoutMs: TRANSCRIPTION_TIMEOUT_MS },
      { env: {}, apiKey: () => target.key, fetch: options.fetch, report: () => {} });
    let text = "", done = false;
    for await (const event of llm.stream({ role: "utility", thinkingLevel: "off", tools: [], signal,
      system: `Transcribe the audio exactly in the spoken language and script. Output only the transcription, with no comments. Output nothing when nothing was said. Language hint: ${options.language}.`,
      messages: [{ role: "user", content: [{ type: "audio", format: "wav", data }] }],
    })) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "done") {
        if (event.stopReason !== "end_turn") throw failure(target, "invalid_response");
        done = true;
      }
    }
    if (!done) throw failure(target, "invalid_response");
    return text.trim();
  } catch (error) {
    if (signal.aborted) throw failure(target, "timeout");
    if (error instanceof LlmError) throw error;
    throw failure(target, "network");
  }
}

const eventShape = z.object({ type: z.string().optional(), text: z.string().optional() });
const RESPONSE_BYTES = 1024 * 1024;
async function asr(target: TranscriptionTarget, data: string, language: string, transport: Fetch, signal: AbortSignal): Promise<string> {
  if (!target.transcriptionPath) throw failure(target, "config");
  const headers = new Headers(target.provider.headers);
  headers.delete("x-api-key");
  headers.set("Authorization", `Bearer ${target.key}`);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "text/event-stream");
  const response = await bounded(transport(`${target.provider.baseUrl}${target.transcriptionPath}`, {
    method: "POST", redirect: "error", signal, headers,
    body: JSON.stringify({ audio: { data, input: { transcription: { model: target.modelId, language, enable_itn: true }, format: { type: "wav" } } } }),
  }), signal);
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw failure(target, response.status === 401 || response.status === 403 ? "auth" : response.status === 429 ? "rate_limit" : "http", response.status);
  }
  if (!response.body) throw failure(target, "invalid_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "", event = "", lines: string[] = [], bytes = 0, text: string | undefined;
  const dispatch = () => {
    if (!lines.length) {
      if (event === "error") throw failure(target, "invalid_response");
      event = ""; return;
    }
    let raw: unknown;
    try { raw = JSON.parse(lines.join("\n")); } catch { throw failure(target, "invalid_response"); }
    const parsed = eventShape.safeParse(raw);
    if (!parsed.success) throw failure(target, "invalid_response");
    const type = event || parsed.data.type;
    if (type === "error" || parsed.data.type === "error") throw failure(target, "invalid_response");
    if (type === "transcript.text.done") {
      if (parsed.data.text === undefined) throw failure(target, "invalid_response");
      text = parsed.data.text;
    }
    event = ""; lines = [];
  };
  const line = (value: string) => {
    if (!value) dispatch();
    else if (value.startsWith("event:")) event = value.slice(6).trim();
    else if (value.startsWith("data:")) lines.push(value.slice(5).replace(/^ /, ""));
  };
  try {
    while (true) {
      const chunk = await bounded(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > RESPONSE_BYTES) throw failure(target, "invalid_response");
      pending += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, end).replace(/\r$/, ""));
        pending = pending.slice(end + 1);
      }
    }
    pending += decoder.decode();
    if (pending) line(pending.replace(/\r$/, ""));
    dispatch();
    if (text === undefined) throw failure(target, "invalid_response");
    return text.trim();
  } finally {
    void reader.cancel().catch(() => {});
  }
}
