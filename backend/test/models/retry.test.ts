// M12 model_error card actions (contract §5): retry resubmits the same turn (same channel, same
// user message, no second copy of it) and the card turns `retrying`; retry with modelId runs that
// one turn on that model; an unusable modelId is 400; a card that isn't open is 409; dismiss; a
// retry that fails again posts a new card while the old one stays `retrying`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Message } from "../../src/contract/messages.ts";
import { readSse } from "../helpers/sse.ts";
import { call, channelOf, failing, startModelsApp, type ModelsApp } from "./harness.ts";

const MODELS_DEV = {
  openai: { models: {
    "gpt-a": { name: "GPT A", limit: { context: 200000, output: 32000 }, tool_call: true },
    "gpt-b": { name: "GPT B", limit: { context: 100000, output: 16000 }, tool_call: true },
    "gpt-plain": { name: "Plain", tool_call: false, limit: { context: 8000, output: 2000 } },
  } },
};

let t: ModelsApp;
let a: string;
let b: string;
let plain: string;
let trips: string;
beforeAll(async () => {
  t = await startModelsApp();
  t.net.modelsDev = MODELS_DEV;
  t.net.lists.set("api.openai.com", { data: [{ id: "gpt-a" }, { id: "gpt-b" }, { id: "gpt-plain" }] });
  const providerId = (await call(t, t.alex, "POST", "/api/providers", { kind: "openai", key: "sk-retry-test-key-7777" })).body.provider.id as string;
  const add = async (modelId: string) => (await call(t, t.alex, "POST", "/api/models", { providerId, modelId })).body.model.id as string;
  a = await add("gpt-a");
  b = await add("gpt-b");
  plain = await add("gpt-plain");
  trips = await channelOf(t);
});
afterAll(() => t.fixture.cleanup());

let seq = 0;
async function chat(text: string) {
  const response = await t.fixture.app.request(`/api/channels/${trips}/messages`, {
    method: "POST", headers: { ...t.alex.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text, clientId: `retry-${++seq}` }),
  });
  if (response.status !== 200) throw new Error(`send failed: ${response.status} ${await response.text()}`);
  await readSse(response, { timeoutMs: 10_000 });
  await t.runs.idle();
}
const messages = async () => (await call(t, t.alex, "GET", `/api/channels/${trips}/messages?limit=100`)).body.messages as Message[];
const cards = async () => (await messages()).filter((m) => m.kind === "model_error");
const act = (id: string, body: Record<string, unknown>) => call(t, t.alex, "POST", `/api/messages/${id}/action`, body);
const reply = (text: string) => [{ type: "text_delta" as const, text }];
const asked = (text: string) => JSON.stringify(t.scripts.requests().at(-1)!.request.messages).includes(text);

describe("model_error: retry", () => {
  test("retry resubmits the same turn: the card turns retrying, the answer arrives, the user message isn't copied", async () => {
    t.scripts.push(failing(529));
    await chat("Book the night train to Vienna");
    const card = (await cards()).at(-1)!;
    expect(card.payload).toMatchObject({ modelId: a, retry: true, state: "open" });
    expect(JSON.stringify(card.payload)).not.toContain("retryOf");

    const before = t.scripts.requests().length;
    t.scripts.push(reply("Booked: the 22:10 to Vienna."));
    const answer = await act(card.id, { action: "retry" });
    expect(answer.status).toBe(200);
    expect(answer.body.message.payload.state).toBe("retrying");
    await t.runs.idle();

    expect(t.scripts.requests().length).toBe(before + 1);
    expect(t.scripts.requests().at(-1)!.modelId).toBe("gpt-a");
    expect(asked("Book the night train to Vienna")).toBe(true);
    const rows = await messages();
    expect(rows.filter((m) => m.role === "user" && m.text === "Book the night train to Vienna")).toHaveLength(1);
    expect(rows.some((m) => m.role === "assistant" && m.text.includes("Booked: the 22:10 to Vienna."))).toBe(true);
    expect((await cards()).find((m) => m.id === card.id)!.payload).toMatchObject({ state: "retrying" });
  });

  test("retry with modelId runs that one turn on that model; the next turn is back on the default", async () => {
    t.scripts.push(failing(500));
    await chat("Find a hotel near the station");
    const card = (await cards()).at(-1)!;
    t.scripts.push(reply("Hotel Wien Mitte has rooms."));
    expect((await act(card.id, { action: "retry", modelId: b })).status).toBe(200);
    await t.runs.idle();
    expect(t.scripts.requests().at(-1)!.modelId).toBe("gpt-b");
    expect(asked("Find a hotel near the station")).toBe(true);

    t.scripts.push(reply("Sure."));
    await chat("Thanks");
    expect(t.scripts.requests().at(-1)!.modelId).toBe("gpt-a");
  });

  test("an unusable modelId is 400 and the card stays open; not open is 409; dismiss", async () => {
    t.scripts.push(failing(529));
    await chat("What's the weather in Vienna?");
    const card = (await cards()).at(-1)!;

    const bad = await act(card.id, { action: "retry", modelId: plain });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: "validation_failed", field: "modelId" });
    const unknown = await act(card.id, { action: "retry", modelId: "mdl_nope" });
    expect(unknown.status).toBe(400);
    expect((await cards()).find((m) => m.id === card.id)!.payload).toMatchObject({ state: "open" });

    const dismissed = await act(card.id, { action: "dismiss" });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.message.payload.state).toBe("dismissed");
    expect((await act(card.id, { action: "retry" })).status).toBe(409);
    expect((await act(card.id, { action: "dismiss" })).status).toBe(409);
  });

  test("a retry that fails again posts a new card; the old one stays retrying and can't be retried twice", async () => {
    t.scripts.push(failing(529));
    await chat("Is the museum open on Monday?");
    const first = (await cards()).at(-1)!;
    t.scripts.push(failing(503));
    expect((await act(first.id, { action: "retry" })).status).toBe(200);
    await t.runs.idle();

    const all = await cards();
    const second = all.at(-1)!;
    expect(second.id).not.toBe(first.id);
    expect(second.payload).toMatchObject({ state: "open", retry: true, phrase: { params: { status: { type: "number", value: 503 } } } });
    expect(all.find((m) => m.id === first.id)!.payload).toMatchObject({ state: "retrying" });
    expect((await act(first.id, { action: "retry" })).status).toBe(409);

    t.scripts.push(reply("Closed on Mondays."));
    expect((await act(second.id, { action: "retry" })).status).toBe(200);
    await t.runs.idle();
    expect(asked("Is the museum open on Monday?")).toBe(true);
    const rows = await messages();
    expect(rows.filter((m) => m.role === "user" && m.text === "Is the museum open on Monday?")).toHaveLength(1);
    expect(rows.some((m) => m.role === "assistant" && m.text.includes("Closed on Mondays."))).toBe(true);
  });
});
