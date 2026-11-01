// Official Chat Completions adapter. reasoning_content/reasoning are explicitly
// checked compatibility-gateway extensions, not fields in the official SDK types.
// Chat Completions has native web_search_options but no native web_fetch API.
import OpenAI from "openai";
import type { ChatCompletionAssistantMessageParam, ChatCompletionContentPart, ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";
import { z } from "zod";
import { InvalidModelResponse, UnsupportedRequest } from "../errors.ts";
import type { AdapterContext, ContentBlock, LlmEvent, LlmRequest, StopReason, ToolUseBlock } from "../types.ts";
import { UsageTracker } from "../usage.ts";
import { argumentsOf, checkRequest, identity, mintCallId, openaiReasoning, parse, sameModel, secureFetch, silentLogger, stopReason } from "./common.ts";
import { ThinkSplitter, type ThinkPiece } from "./think.ts";
function messages(request: LlmRequest, ctx: AdapterContext): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [{ role: "system", content: request.system }];
  for (const message of request.messages) {
    if (message.role === "assistant") {
      const text = message.content.filter(b => b.type === "text").map(b => b.text).join("");
      const calls = ctx.model.capabilities.tools ? message.content.filter(b => b.type === "tool_use").map(b => ({ type: "function" as const, id: b.id, function: { name: b.name, arguments: JSON.stringify(b.input) } })) : [];
      const thinking = ctx.model.capabilities.thinking ? message.content.filter(b => b.type === "thinking" && sameModel(b.origin, ctx) && b.redacted === undefined).map(b => b.type === "thinking" ? b.text : "").join("") : "";
      const assistant: ChatCompletionAssistantMessageParam & { reasoning_content?: string } = {
        role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}), ...(thinking ? { reasoning_content: thinking } : {}),
      };
      if (text || calls.length || thinking) result.push(assistant);
    } else {
      // Every tool reply must directly follow the assistant's tool_calls, so tool-result
      // images (tool messages can't carry them) and ordinary parts share ONE user
      // message pushed after all of this turn's tool messages.
      const parts: ChatCompletionContentPart[] = [];
      for (const block of message.content) {
        if (block.type === "text") parts.push({ type: "text", text: block.text });
        if (block.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${block.mediaType};base64,${block.data}` } });
        if (block.type === "audio") parts.push({ type: "input_audio", input_audio: { data: block.data, format: block.format } });
        if (block.type === "tool_result" && ctx.model.capabilities.tools) {
          result.push({ role: "tool", tool_call_id: block.toolUseId, content: (block.isError ? "[Tool error]\n" : "") + block.content.filter(b => b.type === "text").map(b => b.text).join("\n") });
          for (const b of block.content) if (b.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
        }
      }
      if (parts.length) result.push({ role: "user", content: parts });
    }
  }
  return result;
}
export function openaiParams(request: LlmRequest, ctx: AdapterContext): ChatCompletionCreateParamsStreaming {
  checkRequest(request, ctx);
  if (ctx.model.capabilities.serverWebTools && request.serverTools?.includes("web_fetch")) throw new UnsupportedRequest();
  const tools = ctx.model.capabilities.tools ? (request.tools ?? []).map(t => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } })) : [];
  return {
    model: ctx.model.id, messages: messages(request, ctx), stream: true, stream_options: { include_usage: true },
    // Older compatible gateways accept max_tokens; reasoning models require the newer field.
    ...(ctx.model.capabilities.thinking
      ? { max_completion_tokens: Math.min(request.maxTokens ?? ctx.model.maxOutputTokens, ctx.model.maxOutputTokens) }
      : { max_tokens: Math.min(request.maxTokens ?? ctx.model.maxOutputTokens, ctx.model.maxOutputTokens) }),
    ...(tools.length ? { tools } : {}),
    // M12: the thinking level as reasoning_effort (gemini: "none" for off).
    ...openaiReasoning(request, ctx.provider, ctx.model),
    ...(ctx.model.capabilities.serverWebTools && request.serverTools?.includes("web_search") ? { web_search_options: {} } : {}),
  };
}
const callDelta = z.object({ index: z.number().int().nonnegative(), id: z.string().optional(), type: z.string().optional(), function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional() });
const chunkSchema = z.object({
  choices: z.array(z.object({ index: z.number().int().nonnegative(), finish_reason: z.string().nullable().optional(), delta: z.object({
    content: z.string().nullable().optional(), refusal: z.string().nullable().optional(),
    reasoning_content: z.string().nullable().optional(), reasoning: z.string().nullable().optional(), tool_calls: z.array(callDelta).optional(),
  }) })), usage: z.unknown().optional(),
});
export async function* streamOpenai(request: LlmRequest, ctx: AdapterContext): AsyncIterable<LlmEvent> {
  const params = openaiParams(request, ctx);
  const client = new OpenAI({ apiKey: ctx.apiKey, baseURL: ctx.provider.baseUrl, maxRetries: 0, timeout: ctx.timeoutMs, fetch: secureFetch(ctx), logLevel: "off", logger: silentLogger });
  const stream = await client.chat.completions.create(params, { signal: request.signal });
  const content: ContentBlock[] = [];
  const calls = new Map<number, { id: string; name: string; args: string; block?: ToolUseBlock }>();
  const usage = new UsageTracker();
  // M14: a leading <think>…</think> in the reply text is the model's reasoning, never bubble text.
  const think = new ThinkSplitter();
  let reason: StopReason = "other", ended = false, droppedTools = 0;
  function* emit(pieces: ThinkPiece[]): Generator<LlmEvent> {
    for (const piece of pieces) {
      const last = content.at(-1);
      if (piece.type === "text") {
        if (last?.type === "text") last.text += piece.text;
        else content.push({ type: "text", text: piece.text });
        yield { type: "text_delta", text: piece.text };
      } else {
        // Kept for the run record; replayed only when the model has the thinking capability.
        if (last?.type === "thinking") last.text += piece.text;
        else content.push({ type: "thinking", text: piece.text, origin: identity(ctx) });
        yield { type: "thinking_delta", text: piece.text };
      }
    }
  }
  try {
    for await (const raw of stream) {
      const chunk = parse(chunkSchema, raw);
      usage.openai(chunk.usage);
      const choice = chunk.choices.find(c => c.index === 0);
      if (!choice) continue;
      const delta = choice.delta;
      if (ended && (delta.content || delta.tool_calls?.length)) throw new InvalidModelResponse();
      if (delta.content) yield* emit(think.push(delta.content));
      const thinking = ctx.model.capabilities.thinking ? delta.reasoning_content ?? delta.reasoning : undefined;
      if (thinking) yield* emit([{ type: "thinking", text: thinking }]);
      if (delta.refusal) {
        content.push({ type: "text", text: delta.refusal });
        yield { type: "text_delta", text: delta.refusal };
        reason = "refusal";
      }
      for (const call of delta.tool_calls ?? []) {
        if (call.type && call.type !== "function") throw new InvalidModelResponse();
        let pending = calls.get(call.index);
        if (!pending) { pending = { id: "", name: "", args: "" }; calls.set(call.index, pending); }
        // The first non-empty id wins: some gateways resend it on every fragment.
        if (call.id && !pending.id) pending.id = call.id;
        if (call.function?.name) pending.name += call.function.name;
        if (call.function?.arguments) pending.args += call.function.arguments;
      }
      // Some gateways repeat the final chunk (the second one carrying usage): its tool calls are
      // taken once, at the first finish_reason; usage was already read above.
      if (choice.finish_reason && !ended) {
        ended = true;
        yield* emit(think.end());
        if (reason !== "refusal") reason = stopReason(choice.finish_reason);
        for (const [, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
          if (call.block) throw new InvalidModelResponse();
          // A call cut off by the length limit (no name yet, or unparseable arguments) is dropped.
          // Elsewhere: no name = an invalid response; no id = one of ours; arguments that aren't one
          // JSON object = the call is kept, flagged invalid, and answered by the runtime with an error.
          if (!call.name) {
            if (reason === "max_tokens") { droppedTools++; continue; }
            throw new InvalidModelResponse("tool_call");
          }
          const input = argumentsOf(call.args);
          if (!input && reason === "max_tokens") { droppedTools++; continue; }
          call.id ||= mintCallId();
          call.block = { type: "tool_use", id: call.id, name: call.name, input: input ?? {} };
          content.push(call.block);
          yield { type: "tool_call", id: call.id, name: call.name, input: call.block.input, ...(input ? {} : { invalid: "arguments" as const }) };
        }
      }
    }
    if (!ended) {
      // A stream that stops without a finish_reason but with a complete text answer (and no tool
      // call still being assembled) is an ordinary end of turn; anything else stays invalid.
      yield* emit(think.end());
      if (calls.size || !content.some(b => b.type === "text" && b.text.trim())) throw new InvalidModelResponse("no_finish");
      if (reason !== "refusal") reason = "end_turn";
    }
    yield { type: "usage", ...usage.finish(request, content) };
    yield { type: "done", stopReason: reason, message: { role: "assistant", content }, model: identity(ctx), ...(droppedTools ? { droppedTools } : {}) };
  } finally { stream.controller.abort(); }
}
