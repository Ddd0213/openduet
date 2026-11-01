// Test-only Llm implementation; never imported by src/ or selectable in config.
import { LlmError, type ContentBlock, type Llm, type LlmEvent, type LlmRequest, type ModelIdentity, type StopReason } from "../../src/llm/index.ts";
import type { Capabilities, Model, ModelConfig, ModelRole, RegisteredLlm } from "../../src/llm/index.ts";
export type ScriptEvent = LlmEvent | LlmError | { type: "stop"; stopReason: StopReason };
export type ScriptTurn = readonly ScriptEvent[] | LlmError | ((request: LlmRequest) => readonly ScriptEvent[] | LlmError | Promise<readonly ScriptEvent[] | LlmError>);
export class ScriptedModel implements Llm {
  readonly requests: LlmRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly ScriptTurn[], readonly model: ModelIdentity = { providerId: "scripted-test-only", modelId: "scripted-test-only" }) {}
  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    this.requests.push({ ...structuredClone({ ...request, signal: undefined }), signal: request.signal });
    const turn = this.script[this.turn++];
    if (!turn) throw new LlmError({ kind: "config", ...this.model, attempts: 0 });
    const events = typeof turn === "function" ? await turn(request) : turn;
    if (events instanceof LlmError) throw events;
    const content: ContentBlock[] = [];
    let done = false;
    for (const event of events) {
      if (event instanceof LlmError) throw event;
      if (event.type === "stop") {
        done = true;
        yield { type: "done", stopReason: event.stopReason, message: { role: "assistant", content }, model: request.pin ?? this.model };
      } else {
        if (event.type === "text_delta") {
          const last = content.at(-1);
          if (last?.type === "text") last.text += event.text;
          else content.push({ type: "text", text: event.text });
        } else if (event.type === "thinking_delta") {
          const last = content.at(-1);
          if (last?.type === "thinking") last.text += event.text;
          else content.push({ type: "thinking", text: event.text, origin: request.pin ?? this.model });
        } else if (event.type === "tool_call") content.push({ type: "tool_use", id: event.id, name: event.name, input: event.input });
        if (event.type === "done") done = true;
        yield event;
      }
    }
    if (!done) yield { type: "done", stopReason: content.some(b => b.type === "tool_use") ? "tool_use" : "end_turn", message: { role: "assistant", content }, model: request.pin ?? this.model };
  }
}

/** Registry-aware version for consumers that gate requests on model capabilities. */
export class RegisteredScriptedModel extends ScriptedModel implements RegisteredLlm {
  readonly models: ModelConfig;
  constructor(script: readonly ScriptTurn[], capabilities: Partial<Capabilities> = {}, identity: ModelIdentity = { providerId: "scripted-test-only", modelId: "scripted-test-only" }) {
    super(script, identity);
    this.models = {
      providers: [{ id: identity.providerId, protocol: "anthropic", baseUrl: "https://test.invalid", apiKeyEnv: "TEST_ONLY_UNUSED" }],
      models: [{ id: identity.modelId, provider: identity.providerId, label: "Test only", contextWindow: 128000, maxOutputTokens: 4096, capabilities: { tools: true, vision: false, thinking: false, serverWebTools: false, promptCaching: false, ...capabilities } }],
      roles: { chat: [identity.modelId], task: [identity.modelId], proactive: [identity.modelId], utility: [identity.modelId] },
      timeoutMs: 1000,
    };
  }
  roleModels(role: ModelRole): Model[] {
    return this.models.roles[role].flatMap(id => this.models.models.filter(model => model.id === id));
  }
}
