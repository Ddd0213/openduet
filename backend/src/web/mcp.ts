// Small read-only MCP search client. No arbitrary server, auth, tools/list or server-initiated calls.
import { z } from "zod";
import { abortable, HttpStatusError, readBody, ServiceUnavailable, type HttpDeps } from "./http.ts";
import type { SearchHit } from "./search.ts";

const Answer = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional(),
});
const Result = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional().default([]), structuredContent: z.unknown().optional() });
const Hits = z.object({ results: z.array(z.object({ title: z.string(), url: z.url({ protocol: /^https?$/ }), excerpts: z.array(z.string()).optional(), text: z.string().optional(), content: z.string().optional(), snippet: z.string().optional() })) });

/** A finite JSON response or SSE stream: stop on our answer, not on connection close. */
async function answer(response: Response, id: number, signal: AbortSignal): Promise<z.infer<typeof Answer>> {
  if (!/text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
    const value = Answer.parse(JSON.parse(new TextDecoder().decode(await readBody(response, signal))));
    if (value.id !== id) throw new ServiceUnavailable("Mismatched MCP response");
    return value;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceUnavailable("Empty MCP response");
  const decoder = new TextDecoder();
  let buffer = "", size = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      size += part.value?.byteLength ?? 0;
      if (size > 2 * 1024 * 1024) throw new ServiceUnavailable("MCP response too large");
      buffer += decoder.decode(part.value, { stream: !part.done });
      // Split on blank lines, including CRLF across chunk boundaries.
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        const value = Answer.safeParse(JSON.parse(data));
        if (value.success && value.data.id === id) return value.data;
      }
      if (part.done) throw new ServiceUnavailable("No MCP answer");
    }
  } finally { void reader.cancel().catch(() => {}); }
}

export async function mcpSearch(provider: "exa" | "parallel", query: string, deps: HttpDeps, signal: AbortSignal): Promise<SearchHit[]> {
  const url = provider === "exa" ? "https://mcp.exa.ai/mcp" : "https://search.parallel.ai/mcp";
  let session: string | null = null, sequence = 0;
  const post = async (method: string, params?: unknown, notification = false) => {
    const id = ++sequence;
    const response = await abortable((deps.fetch ?? fetch)(url, {
      method: "POST", redirect: "error", signal,
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "MCP-Protocol-Version": "2025-03-26", ...(session ? { "Mcp-Session-Id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }),
    }), signal);
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new HttpStatusError(response.status); }
    session = response.headers.get("Mcp-Session-Id") ?? session;
    if (notification) { void response.body?.cancel().catch(() => {}); return undefined; }
    const data = await answer(response, id, signal);
    if (data.error) throw new ServiceUnavailable("MCP search failed");
    return data.result;
  };
  await post("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "OpenDuet", version: "1.0" } });
  await post("notifications/initialized", undefined, true);
  const raw = Result.parse(await post("tools/call", {
    name: provider === "exa" ? "web_search_exa" : "web_search",
    arguments: provider === "exa" ? { query, numResults: 5 } : { objective: query, search_queries: [query] },
  }));
  if (raw.isError) throw new ServiceUnavailable("MCP search failed");
  const text = raw.content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
  let structured = raw.structuredContent;
  if (structured === undefined) { try { structured = JSON.parse(text); } catch { /* Exa sends labelled text. */ } }
  if (structured !== undefined) {
    return Hits.parse(structured).results.map(r => ({ title: r.title, url: r.url, snippet: r.excerpts?.join("\n") ?? r.snippet ?? r.text ?? r.content ?? "" }));
  }
  if (provider !== "exa") throw new ServiceUnavailable("Invalid search results");
  const results: SearchHit[] = [];
  // Parse the full answer before applying SearchHit caps. Labels are not model instructions.
  for (const match of text.matchAll(/^Title:[ \t]*([^\n]*)\nURL:[ \t]*(https?:\/\/[^\s]+)\n([\s\S]*?)(?=\n(?:---\s*\n+)?Title:|(?![\s\S]))/gm)) {
    if (z.url({ protocol: /^https?$/ }).safeParse(match[2]).success) results.push({ title: match[1]!, url: match[2]!, snippet: match[3]!.replace(/^(?:Published(?: Date)?|Author):[^\n]*\n/gm, "").replace(/^(?:Highlights|Text):\s*/, "").trim() });
  }
  if (!results.length && !/no (?:search )?results (?:found|available)/i.test(text)) throw new ServiceUnavailable("Invalid search results");
  return results;
}
