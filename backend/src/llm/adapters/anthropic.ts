// Official Messages SDK adapter; native server tools stay opaque for replay.
import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, ImageBlockParam, TextBlockParam, MessageCreateParamsStreaming, MessageParam, ToolUnion } from "@anthropic-ai/sdk/resources/messages/messages";
import { z } from "zod";
import { InvalidModelResponse, UnsupportedRequest } from "../errors.ts";
import type { AdapterContext, ContentBlock, LlmEvent, LlmRequest, TextBlock, ImageBlock, StopReason } from "../types.ts";
import { UsageTracker } from "../usage.ts";
import { anthropicThinking, argumentsOf, checkRequest, identity, mintCallId, parse, parseArguments, record, sameModel, secureFetch, silentLogger, stopReason, toolInput } from "./common.ts";
const cache = { type: "ephemeral" as const };
const nativeTypes = new Set(["server_tool_use", "web_search_tool_result", "web_fetch_tool_result"]);
function plain(block: TextBlock | ImageBlock): TextBlockParam | ImageBlockParam {
  return block.type === "text" ? { type: "text", text: block.text } : { type: "image", source: { type: "base64", media_type: block.mediaType, data: block.data } };
}
function blocks(content: ContentBlock[], ctx: AdapterContext): ContentBlockParam[] {
  return content.flatMap((block): ContentBlockParam[] => {
    switch (block.type) {
      case "text": case "image": return [plain(block)];
      case "audio": throw new UnsupportedRequest();
      case "tool_use": return ctx.model.capabilities.tools ? [{ type: "tool_use", id: block.id, name: block.name, input: block.input }] : [];
      case "tool_result": return ctx.model.capabilities.tools ? [{ type: "tool_result", tool_use_id: block.toolUseId, content: block.content.map(plain), ...(block.isError !== undefined ? { is_error: block.isError } : {}) }] : [];
      case "thinking":
        if (!ctx.model.capabilities.thinking || !sameModel(block.origin, ctx)) return [];
        if (block.redacted !== undefined) return [{ type: "redacted_thinking", data: block.redacted }];
        return block.signature !== undefined ? [{ type: "thinking", thinking: block.text, signature: block.signature }] : [];
      case "provider_data":
        // Only this adapter emits these opaque blocks; never forward to another model.
        return ctx.model.capabilities.serverWebTools && sameModel(block.origin, ctx) && nativeTypes.has(String(block.data.type)) ? [structuredClone(block.data) as unknown as ContentBlockParam] : [];
    }
  });
}
export function anthropicParams(request: LlmRequest, ctx: AdapterContext): MessageCreateParamsStreaming {
  checkRequest(request, ctx);
  const messages: MessageParam[] = request.messages.flatMap(message => {
    const content = blocks(message.content, ctx);
    return content.length ? [{ role: message.role, content }] : [];
  });
  const tools: ToolUnion[] = ctx.model.capabilities.tools ? (request.tools ?? []).map(tool => ({
    name: tool.name, description: tool.description, input_schema: { ...tool.inputSchema, type: "object" },
  })) : [];
  if (ctx.model.capabilities.serverWebTools) {
    if (request.serverTools?.includes("web_search")) tools.push({ name: "web_search", type: "web_search_20250305" });
    if (request.serverTools?.includes("web_fetch")) tools.push({ name: "web_fetch", type: "web_fetch_20250910" });
  }
  // M14: a call without tools (the runtime's wrap-up) over a history that has tool_use /
  // tool_result blocks: the Messages API wants a tools list then, so one inert tool is declared.
  if (!tools.length && ctx.model.capabilities.tools && messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === "tool_use" || b.type === "tool_result"))) {
    tools.push({ name: "no_tools_available", description: "No tools are available for this reply. Never call this; answer in text.", input_schema: { type: "object", properties: {} } });
  }
  if (ctx.model.capabilities.promptCaching) {
    // Three breakpoints total: system, the tool prefix, and the last cacheable block.
    const lastTool = tools.at(-1);
    if (lastTool) lastTool.cache_control = cache;
    const lastMessage = messages.at(-1);
    if (lastMessage && Array.isArray(lastMessage.content)) {
      const block = lastMessage.content.findLast(b => b.type !== "thinking" && b.type !== "redacted_thinking");
      if (block) Object.assign(block, { cache_control: cache });
    }
  }
  // M12: the thinking level (effort / budget) and, for a budget, max_tokens above it.
  const thinking = anthropicThinking(request, ctx.model, Math.min(request.maxTokens ?? ctx.model.maxOutputTokens, ctx.model.maxOutputTokens));
  return {
    model: ctx.model.id, stream: true,
    max_tokens: thinking.maxTokens,
    system: [{ type: "text", text: request.system, ...(ctx.model.capabilities.promptCaching ? { cache_control: cache } : {}) }],
    messages, ...(tools.length ? { tools } : {}),
    ...(thinking.fields.thinking ? { thinking: thinking.fields.thinking } : {}),
    ...(thinking.fields.output_config ? { output_config: thinking.fields.output_config } : {}),
  };
}
const envelope = z.object({ type: z.string(), index: z.number().int().nonnegative().optional() }).passthrough();
const start = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  // Anthropic-compatible gateways (DeepSeek, GLM ...) omit the signature; keep the block anyway
  // (as "") so the turn still replays its reasoning, which some of them require for tool loops.
  z.object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string().default("") }),
  z.object({ type: z.literal("redacted_thinking"), data: z.string() }),
  // M14: a compatible gateway may leave the id out (it gets one of ours) or the input (= {}).
  z.object({ type: z.literal("tool_use"), id: z.string().optional(), name: z.string().min(1), input: record.optional() }),
]);
const deltaSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({ type: z.literal("thinking_delta"), thinking: z.string() }),
  z.object({ type: z.literal("signature_delta"), signature: z.string() }),
  z.object({ type: z.literal("input_json_delta"), partial_json: z.string() }),
  z.object({ type: z.literal("citations_delta") }),
]);
export async function* streamAnthropic(request: LlmRequest, ctx: AdapterContext): AsyncIterable<LlmEvent> {
  const params = anthropicParams(request, ctx);
  const client = new Anthropic({ apiKey: ctx.apiKey, baseURL: ctx.provider.baseUrl, maxRetries: 0, timeout: ctx.timeoutMs, fetch: secureFetch(ctx), logLevel: "off", logger: silentLogger });
  const stream = await client.messages.create(params, { signal: request.signal });
  // `cut`: a tool call whose JSON doesn't parse. Only a max_tokens stop explains that (the call was
  // cut off); it's then dropped from the message, otherwise it stays an invalid response.
  const pending = new Map<number, { block: ContentBlock; json: string; stopped: boolean; cut?: boolean }>();
  const usage = new UsageTracker();
  let reason: StopReason = "other", ended = false;
  try {
    for await (const raw of stream) {
      const event = parse(envelope, raw);
      if (event.type === "message_start") {
        const message = parse(z.object({ usage: z.unknown().optional() }), event.message);
        usage.anthropic(message.usage);
      } else if (event.type === "message_delta") {
        const delta = parse(z.object({ stop_reason: z.string().nullable().optional() }), event.delta);
        reason = stopReason(delta.stop_reason);
        usage.anthropic(event.usage);
      } else if (event.type === "content_block_start") {
        if (event.index === undefined || pending.has(event.index)) throw new InvalidModelResponse("block_index");
        const native = parse(z.object({ type: z.string() }).passthrough(), event.content_block);
        let block: ContentBlock;
        if (nativeTypes.has(native.type)) {
          if (native.type === "server_tool_use") parse(z.object({ id: z.string().min(1), name: z.string().min(1), input: record }), native);
          else parse(z.object({ tool_use_id: z.string().min(1), content: z.union([record, z.array(record)]) }), native);
          block = { type: "provider_data", data: native, origin: identity(ctx) };
        } else {
          const b = parse(start, native);
          if (b.type === "text") block = { type: "text", text: b.text };
          else if (b.type === "thinking") block = { type: "thinking", text: b.thinking, signature: b.signature, origin: identity(ctx) };
          else if (b.type === "redacted_thinking") block = { type: "thinking", text: "", redacted: b.data, origin: identity(ctx) };
          else block = { type: "tool_use", id: b.id || mintCallId(), name: b.name, input: toolInput(b.input ?? {}) };
        }
        pending.set(event.index, { block, json: "", stopped: false });
        if (block.type === "text" && block.text) yield { type: "text_delta", text: block.text };
        if (block.type === "thinking" && block.text) yield { type: "thinking_delta", text: block.text };
      } else if (event.type === "content_block_delta") {
        const p = event.index !== undefined ? pending.get(event.index) : undefined;
        if (!p || p.stopped) throw new InvalidModelResponse("delta_block");
        const delta = parse(deltaSchema, event.delta);
        if (delta.type === "text_delta" && p.block.type === "text") {
          p.block.text += delta.text;
          if (delta.text) yield { type: "text_delta", text: delta.text };
        } else if (delta.type === "thinking_delta" && p.block.type === "thinking") {
          p.block.text += delta.thinking;
          if (delta.thinking) yield { type: "thinking_delta", text: delta.thinking };
        } else if (delta.type === "signature_delta" && p.block.type === "thinking") p.block.signature = (p.block.signature ?? "") + delta.signature;
        else if (delta.type === "input_json_delta" && (p.block.type === "tool_use" || p.block.type === "provider_data")) p.json += delta.partial_json;
        else if (delta.type !== "citations_delta") throw new InvalidModelResponse("delta_type");
      } else if (event.type === "content_block_stop") {
        const p = event.index !== undefined ? pending.get(event.index) : undefined;
        if (!p || p.stopped) throw new InvalidModelResponse("stop_block");
        p.stopped = true;
        if (p.block.type === "tool_use") {
          // Empty streamed arguments keep the start block's input ({} by default).
          if (p.json.trim()) {
            const input = argumentsOf(p.json);
            if (input) p.block.input = input;
            else { p.cut = true; p.block.input = {}; }
          }
          if (!p.cut) yield { type: "tool_call", id: p.block.id, name: p.block.name, input: p.block.input };
        } else if (p.block.type === "provider_data" && p.json) p.block.data.input = parseArguments(p.json);
      } else if (event.type === "message_stop") ended = true;
      else throw new InvalidModelResponse("event_type");
    }
    const truncated = reason === "max_tokens";
    if (!ended || [...pending.values()].some(p => !p.stopped && !(truncated && p.block.type === "tool_use"))) throw new InvalidModelResponse("incomplete");
    const sorted = [...pending.entries()].sort(([a], [b]) => a - b).map(([, p]) => p);
    // M14: arguments that aren't one JSON object, outside a max_tokens stop: the call is kept with
    // input {} and flagged invalid; the runtime answers it with an error result.
    if (!truncated) {
      for (const p of sorted) {
        if (p.cut && p.block.type === "tool_use") yield { type: "tool_call", id: p.block.id, name: p.block.name, input: p.block.input, invalid: "arguments" };
      }
    }
    const dropped = (p: (typeof sorted)[number]) => truncated && p.block.type === "tool_use" && (p.cut === true || !p.stopped);
    const content = sorted.filter(p => !dropped(p)).map(p => p.block);
    const droppedTools = sorted.filter(dropped).length;
    yield { type: "usage", ...usage.finish(request, content) };
    yield { type: "done", stopReason: reason, message: { role: "assistant", content }, model: identity(ctx), ...(droppedTools ? { droppedTools } : {}) };
  } finally { stream.controller.abort(); }
}
