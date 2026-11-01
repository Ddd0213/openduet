// Offline-testable diagnostics. Importing this module never starts checks.
import { z } from "zod";
import { ConfigError, loadConfig } from "../config.ts";
import { createLlm, LlmError, loadModelConfig, ModelConfigError, MODEL_ROLES, type LlmOptions, type LlmRequest, type ModelConfig, type RegisteredLlm } from "../llm/index.ts";
// A valid 1x1 red PNG; visual checks require a reply, not exact colour recognition.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const TimeInput = z.object({ timezone: z.string().min(1) }).strict();
export interface CheckRow { model: string; provider: string; protocol: string; reachable: boolean; streaming: boolean; toolCalls: boolean; usageReported: boolean; vision: boolean | "n/a"; passed: boolean }
async function probe(llm: RegisteredLlm, request: LlmRequest): Promise<{ text: boolean; tool: boolean; usage: boolean }> {
  let text = false, tool = false, usage = false, done = false;
  for await (const event of llm.stream(request)) {
    if (event.type === "text_delta" && event.text.trim()) text = true;
    if (event.type === "tool_call" && event.name === "get_time" && TimeInput.safeParse(event.input).success) tool = true;
    if (event.type === "usage") usage = !event.estimated;
    if (event.type === "done") done = true;
  }
  return { text: text && done, tool: tool && done, usage: usage && done };
}
export async function checkModels(models: ModelConfig, opts: LlmOptions = {}, write: (line: string) => void = line => console.log(line)): Promise<{ rows: CheckRow[]; exitCode: number }> {
  const llm = createLlm(models, opts), rows: CheckRow[] = [];
  for (const model of models.models) {
    const provider = models.providers.find(p => p.id === model.provider)!;
    const row: CheckRow = { model: model.id, provider: provider.id, protocol: provider.protocol, reachable: false, streaming: false, toolCalls: false, usageReported: false, vision: model.capabilities.vision ? false : "n/a", passed: false };
    const base: LlmRequest = { role: "utility", system: "Follow the user's instructions.", messages: [], maxTokens: 128, pin: { providerId: provider.id, modelId: model.id } };
    const safely = async (request: LlmRequest) => {
      try { return await probe(llm, request); }
      catch (error) { write(error instanceof LlmError ? error.message : "Model request failed (network)"); return undefined; }
    };
    const tiny = await safely({ ...base, messages: [{ role: "user", content: [{ type: "text", text: "Reply with OK." }] }] });
    row.reachable = tiny !== undefined;
    row.streaming = tiny?.text ?? false;
    const tool = await safely({ ...base, messages: [{ role: "user", content: [{ type: "text", text: "Call get_time exactly once with timezone UTC. Do not answer in text." }] }], tools: [{ name: "get_time", description: "Get the current time in a timezone.", inputSchema: { type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"], additionalProperties: false } }] });
    row.toolCalls = tool?.tool ?? false;
    let visionUsage = true;
    if (model.capabilities.vision) {
      const vision = await safely({ ...base, messages: [{ role: "user", content: [{ type: "text", text: "What colour is this square?" }, { type: "image", mediaType: "image/png", data: PNG }] }] });
      row.vision = vision?.text ?? false;
      visionUsage = vision?.usage ?? false;
    }
    row.usageReported = !!tiny?.usage && !!tool?.usage && visionUsage;
    // Missing usage is supported (estimated); tool-less utility models are valid.
    row.passed = row.reachable && row.streaming && (!model.capabilities.tools || row.toolCalls) && row.vision !== false;
    rows.push(row);
  }
  const table = [ ["model", "provider", "protocol", "reachable", "streaming", "tool calls", "usage reported", "vision"], ...rows.map(r => [r.model, r.provider, r.protocol, r.reachable ? "yes" : "no", r.streaming ? "yes" : "no", r.toolCalls ? "yes" : "no", r.usageReported ? "yes" : "no", r.vision === "n/a" ? "n/a" : r.vision ? "yes" : "no"]) ];
  const widths = table[0]!.map((_, i) => Math.max(...table.map(row => row[i]!.length)));
  for (const row of table) write(row.map((cell, i) => cell.padEnd(widths[i]!)).join(" | "));
  for (const role of MODEL_ROLES) write(`${role}: ${models.roles[role].join(" -> ")}`);
  const failed = MODEL_ROLES.some(role => !rows.find(r => r.model === models.roles[role][0])?.passed);
  return { rows, exitCode: failed ? 1 : 0 };
}
export async function runModelsCheck(opts: LlmOptions & { readFile?: (path: string) => string; write?: (line: string) => void } = {}): Promise<number> {
  const write = opts.write ?? (line => console.log(line));
  try {
    const config = loadConfig(opts.env);
    const models = loadModelConfig(config, opts.env, opts.readFile);
    return (await checkModels(models, opts, write)).exitCode;
  } catch (error) {
    write(error instanceof ModelConfigError || error instanceof ConfigError || error instanceof LlmError ? error.message : "Model configuration could not be checked");
    return 1;
  }
}
if (import.meta.main) process.exitCode = await runModelsCheck();
