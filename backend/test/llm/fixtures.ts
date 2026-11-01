// Hand-written SSE fixtures matching the two pinned SDKs' wire formats.
import { loadModelConfig, type Capabilities, type Fetch, type LlmEvent, type LlmRequest, type ModelSettings } from "../../src/llm/index.ts";
export const env = { TEST_KEY: "test-secret-never-log", LLM_API_KEY: "shortcut-secret" };
export const caps: Capabilities = { tools: true, vision: false, thinking: false, serverWebTools: false, promptCaching: false };
export const settings: ModelSettings = { MODELS_FILE: "./models.json", LLM_PROTOCOL: undefined, LLM_BASE_URL: undefined, LLM_MODEL: undefined, LLM_AUTH_HEADER: undefined, LLM_CAPABILITIES: [], MODEL_CHAT: "test-model", MODEL_TASK: undefined, MODEL_PROACTIVE: undefined, MODEL_UTILITY: undefined, LLM_TIMEOUT_SECONDS: 1, LLM_ALLOW_INSECURE_HOSTS: [] };
export const request: LlmRequest = { role: "chat", system: "Be helpful.", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
export function rawConfig(protocol: "anthropic" | "openai" = "openai", capabilities = caps) {
  return { providers: [{ id: "test-provider", protocol, baseUrl: "https://gateway.invalid/v1/", apiKeyEnv: "TEST_KEY" }], models: [{ id: "test-model", provider: "test-provider", label: "Test", contextWindow: 128000, maxOutputTokens: 8192, capabilities }] };
}
export function registry(protocol: "anthropic" | "openai" = "openai", capabilities = caps) {
  const raw = rawConfig(protocol, capabilities);
  if (!capabilities.tools) raw.models.push({ ...raw.models[0]!, id: "tools-model", capabilities: caps });
  return loadModelConfig({ ...settings, MODEL_CHAT: capabilities.tools ? "test-model" : "tools-model", MODEL_UTILITY: "test-model" }, env, () => JSON.stringify(raw));
}
export const sse = (data: unknown, event?: string): string => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
export const response = (body: string): Response => new Response(body, { headers: { "content-type": "text/event-stream" } });
export const a = (type: string, value: object = {}) => sse({ type, ...value }, type);
export const aStart = (usage: object | undefined = { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 }) => a("message_start", { message: { id: "msg_test", type: "message", role: "assistant", model: "test-model", content: [], stop_reason: null, stop_sequence: null, ...(usage ? { usage } : {}) } });
export const aEnd = (reason = "end_turn", usage: object | undefined = { output_tokens: 7 }) => a("message_delta", { delta: { stop_reason: reason, stop_sequence: null }, ...(usage ? { usage } : {}) }) + a("message_stop");
export function anthropicText(usage = true) { return aStart(usage ? undefined : {}) + a("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + a("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello " } }) + a("content_block_delta", { index: 0, delta: { type: "text_delta", text: "世界" } }) + a("content_block_stop", { index: 0 }) + aEnd("end_turn", usage ? undefined : {}); }
export function anthropicTool(args = ['{"time', 'zone":"UTC"}']) { return aStart() + a("content_block_start", { index: 0, content_block: { type: "tool_use", id: "call_test", name: "get_time", input: {} } }) + args.map(partial_json => a("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json } })).join("") + a("content_block_stop", { index: 0 }) + aEnd("tool_use"); }
export const o = (delta: object, finish_reason: string | null = null, index = 0) => sse({ id: "chatcmpl_test", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index, delta, finish_reason }] });
export const oUsage = () => sse({ id: "chatcmpl_test", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [], usage: { prompt_tokens: 11, completion_tokens: 9, total_tokens: 20 } });
export function openaiText(usage = true) { return o({ role: "assistant", content: "" }) + o({ content: "Hello " }) + o({ content: "世界" }) + o({}, "stop") + (usage ? oUsage() : "") + sse("[DONE]"); }
export function openaiTool(args = ['{"time', 'zone":"UTC"}']) { return o({ role: "assistant", tool_calls: [{ index: 0, id: "call_test", type: "function", function: { name: "get_time", arguments: args[0] } }] }) + args.slice(1).map(arguments_ => o({ tool_calls: [{ index: 0, function: { arguments: arguments_ } }] })).join("") + o({}, "tool_calls") + oUsage() + sse("[DONE]"); }
export async function collect(events: AsyncIterable<LlmEvent>) { const result: LlmEvent[] = []; for await (const event of events) result.push(structuredClone(event)); return result; }
export interface Captured { url: string; body: Record<string, any>; headers: Headers; init: RequestInit }
export function fakeFetch(body: string | ((request: Captured, index: number) => Response | Promise<Response>)): { fetch: Fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  return { calls, fetch: Object.assign(async (input: string | Request | URL, init?: RequestInit) => {
    const captured = { url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers), init: init ?? {} };
    calls.push(captured);
    return typeof body === "string" ? response(body) : body(captured, calls.length - 1);
  }, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] }) };
}
