// M20 (#5): no Composio execution carries a credential out. guardOutbound wraps the gateway (sdk.ts
// createComposioGateway always returns it), so both the direct path (execute_app_tools with a tool
// set to Always) and Approve are covered (connectors/provider.ts also refuses such a call before it
// becomes a card): nothing reaches Composio, the model / card get a fixed
// reason, and the log line has the category and path, never the value.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import { guardOutbound } from "../../src/composio/gateway.ts";
import { createConnectorsModule, type ConnectorsModule } from "../../src/connectors/module.ts";
import type { LlmEvent } from "../../src/llm/index.ts";
import { captureOutput } from "../channels/harness.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { FakeComposio } from "../helpers/fake-composio.ts";
import { RegisteredScriptedModel, type ScriptTurn } from "../helpers/scripted-model.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";

const KEY = "AKIAIOSFODNN7EXAMPLE";
const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
const execute = (...calls: { tool: string; arguments?: Record<string, unknown> }[]): LlmEvent => ({ type: "tool_call", id: crypto.randomUUID(), name: "execute_app_tools", input: { calls } });

describe("guardOutbound (unit)", () => {
  test("refuses an execution with a credential before the inner gateway sees it; passes the rest through", async () => {
    const fake = new FakeComposio();
    const gateway = guardOutbound(fake);
    const refused = await gateway.execute("u1", "GMAIL_SEND_EMAIL", { recipient_email: "sam@example.com", body: `my key is ${KEY}` });
    expect(refused).toMatchObject({ ok: false, kind: "invalid_arguments" });
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.error).toContain("Not sent:");
    expect(refused.error).toContain("provider_token at $.body");
    expect(refused.error).not.toContain(KEY);
    expect(await gateway.executeForAccount("u1", "ca_1", "GMAIL_SEND_EMAIL", { password: "hunter2" })).toMatchObject({ ok: false, kind: "invalid_arguments" });
    expect(fake.executions).toEqual([]);
    expect(await gateway.execute("u1", "GMAIL_SEND_EMAIL", { recipient_email: "sam@example.com", body: "Hi Sam, the numbers are attached." })).toMatchObject({ ok: true });
    expect(fake.executions).toHaveLength(1);
    expect((await gateway.listToolkits()).length).toBe(fake.toolkits.length);
  });
});

describe("through the agent", () => {
  let fixture: TestApp;
  let module!: ConnectorsModule;
  let alex: SignedIn;
  const fake = new FakeComposio();
  const queue: ScriptTurn[] = [];
  // Every model call takes the next queued turn; once empty it answers "Done.".
  const llm = new RegisteredScriptedModel(Array.from({ length: 200 }, () => async () => (queue.shift() ?? [{ type: "text_delta", text: "Done." }]) as LlmEvent[]));
  let sent = 0;
  const send = async (text: string) => {
    const response = await fixture.app.request(`/api/channels/${alex.mainChannelId}/messages`, { method: "POST", headers: { ...alex.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text, clientId: `g-${++sent}` }) });
    expect(response.status).toBe(200);
    await readSse(response, { timeoutMs: 10_000 });
  };
  const lastResult = () => {
    const block = llm.requests.at(-1)!.messages.at(-1)!.content[0]!;
    return JSON.parse(block.type === "tool_result" && block.content[0]?.type === "text" ? block.content[0].text : "null") as { results: Record<string, unknown>[] };
  };

  beforeAll(async () => {
    fixture = await createTestApp({}, {
      setup: ({ db, events, config }) => {
        module = createConnectorsModule({ db, events, config, gateway: guardOutbound(fake) });
        return { agent: createAgentRuntime({ db, llm, config, providers: module.providers }), routes: module.routes };
      },
    });
    alex = await signUp(fixture, "alex");
    fake.connect(alex.userId, "gmail", "ca_a1");
  });
  afterAll(async () => { module.stop(); await fixture.cleanup(); });

  test("direct path (a read set to Always): refused, nothing executed, the value isn't in the result or the log", async () => {
    const output = captureOutput();
    try {
      queue.push([execute({ tool: "GMAIL_FETCH_EMAILS", arguments: { query: `from:aws ${KEY}` } })]);
      await send("find the aws mail");
    } finally {
      output.stop();
    }
    const [result] = lastResult().results;
    expect(result).toMatchObject({ status: "error", tool: "Fetch emails" });
    expect(String(result!.error)).toContain("Not sent:");
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(fake.executions).toEqual([]);
    const log = output.text();
    expect(log).toContain("connector call refused: credential in arguments");
    expect(log).toContain("provider_token");
    expect(log).not.toContain(KEY);
  });

  test("a write carrying a credential is refused before it becomes a card: no card, nothing executed", async () => {
    const cards = await fixture.db.approval.count({ where: { userId: alex.userId } });
    queue.push([execute({ tool: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "sam@example.com", subject: "Server", body: `Here is the key:\n${PEM}` } })]);
    await send("send sam the server key");
    expect(await fixture.db.approval.count({ where: { userId: alex.userId } })).toBe(cards);
    const [result] = lastResult().results;
    expect(result).toMatchObject({ status: "refused", tool: "Send email", findings: [{ category: "private_key", path: "$.body" }] });
    expect(JSON.stringify(result)).not.toContain("b3BlbnNzaC1rZXktdjEAAAAA");
    expect(fake.executions).toEqual([]);
  });

  test("Approve: the stored call is checked again when it runs; nothing executed, the card says why in plain words", async () => {
    queue.push([execute({ tool: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "sam@example.com", subject: "Server", body: "The server key follows." } })]);
    await send("send sam the server key");
    const card = await fixture.db.approval.findFirstOrThrow({ where: { userId: alex.userId, toolSlug: "GMAIL_SEND_EMAIL", status: "pending" } });
    // A card whose stored arguments carry a credential (posted before M20, or changed since).
    await fixture.db.approval.update({ where: { id: card.id }, data: { arguments: JSON.stringify({ recipient_email: "sam@example.com", subject: "Server", body: `Here is the key:\n${PEM}` }) } });
    const output = captureOutput();
    let body: unknown;
    try {
      const response = await fixture.app.request(`/api/approvals/${card.id}/approve`, { method: "POST", headers: { ...alex.headers, "Content-Type": "application/json" }, body: JSON.stringify({ version: card.version }) });
      body = await response.json();
    } finally {
      output.stop();
    }
    expect(body).toMatchObject({ approval: { result: { ok: false, error: { key: "approval.failed", params: { reason: { value: "Gmail didn't accept the details. Edit them and try again." } } } } } });
    expect(fake.executions).toEqual([]);
    expect(output.text()).toContain("private_key");
    expect(output.text()).not.toContain("b3BlbnNzaC1rZXktdjEAAAAA");
  });
});
