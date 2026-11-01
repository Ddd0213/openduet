// M12 contract §7 / §9: a provider key typed in the app goes to the vault and to the provider's
// Authorization header, and nowhere else: not in an SSE frame, a Message / Run / RunStep / AuditLog /
// Event row, a log line, or a GET /api/models / /api/providers body ({ set, last4 } only). The real
// createLlm runs over the fake network (realLlm), so the header is really built from the vault.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { captureOutput } from "../channels/harness.ts";
import { readSse } from "../helpers/sse.ts";
import { o, oUsage, sse } from "../llm/fixtures.ts";
import { call, channelOf, startModelsApp, type ModelsApp } from "./harness.ts";

const KEY = "sk-secret-provider-key-QWERTY123456";
const PREFIX = KEY.slice(0, 12);

let t: ModelsApp;
let trips: string;
beforeAll(async () => {
  t = await startModelsApp({ realLlm: true });
  t.net.modelsDev = { openai: { models: { "gpt-a": { name: "GPT A", limit: { context: 200000, output: 32000 }, tool_call: true } } } };
  const provider = await call(t, t.alex, "POST", "/api/providers", { kind: "openai", key: KEY });
  expect(provider.status).toBe(200);
  const model = await call(t, t.alex, "POST", "/api/models", { providerId: provider.body.provider.id, modelId: "gpt-a" });
  expect(model.status).toBe(200);
  trips = await channelOf(t);
});
afterAll(() => t.fixture.cleanup());

const chatStream = (text: string) =>
  new Response(o({ role: "assistant", content: "" }) + o({ content: text }) + o({}, "stop") + oUsage() + sse("[DONE]"), { headers: { "content-type": "text/event-stream" } });

let seq = 0;
async function chat(text: string) {
  const response = await t.fixture.app.request(`/api/channels/${trips}/messages`, {
    method: "POST", headers: { ...t.alex.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text, clientId: `secret-${++seq}` }),
  });
  expect(response.status).toBe(200);
  const frames = await readSse(response, { timeoutMs: 10_000 });
  await t.runs.idle();
  return JSON.stringify(frames);
}

/** Every stored row that could carry it, as one string. */
async function stored(): Promise<string> {
  const db = t.fixture.db;
  const rows = await Promise.all([
    db.message.findMany(), db.run.findMany(), db.runStep.findMany(), db.auditLog.findMany(), db.event.findMany(),
    db.modelProvider.findMany(), db.modelEntry.findMany(), db.user.findMany(),
  ]);
  return JSON.stringify(rows);
}

describe("the provider key stays in the vault and the provider's header", () => {
  test("a turn on the model: the key is in the Authorization header, and nowhere the app or the logs can see", async () => {
    t.net.chat = (c) => {
      expect(c.headers.get("authorization")).toBe(`Bearer ${KEY}`);
      return chatStream("Here's your plan.");
    };
    const out = captureOutput();
    let frames = "";
    let gets = "";
    try {
      frames = await chat("Plan my day");
      gets = (await call(t, t.alex, "GET", "/api/models")).text + (await call(t, t.alex, "GET", "/api/channels/" + trips + "/messages?limit=100")).text;
    } finally {
      out.stop();
    }
    const asked = t.net.calls.filter((c) => c.url.endsWith("/chat/completions"));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((c) => !c.body.includes(KEY))).toBe(true);
    expect(gets).toContain("Here's your plan.");
    for (const [where, text] of [["sse", frames], ["gets", gets], ["logs", out.text()], ["rows", await stored()]] as const) {
      expect({ where, leaked: text.includes(KEY) || text.includes(PREFIX) }).toEqual({ where, leaked: false });
    }
    expect(gets).toContain(KEY.slice(-4));
  });

  test("a provider error that echoes the key: the card, run steps, rows and logs still don't have it", async () => {
    t.net.chat = () => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), { status: 401, headers: { "content-type": "application/json" } });
    const out = captureOutput();
    let frames = "";
    let gets = "";
    try {
      frames = await chat("Try again please");
      gets = (await call(t, t.alex, "GET", "/api/channels/" + trips + "/messages?limit=100")).text;
    } finally {
      out.stop();
    }
    expect(gets).toContain("model_error");
    for (const [where, text] of [["sse", frames], ["gets", gets], ["logs", out.text()], ["rows", await stored()]] as const) {
      expect({ where, leaked: text.includes(KEY) || text.includes(PREFIX) }).toEqual({ where, leaked: false });
    }
  });
});
