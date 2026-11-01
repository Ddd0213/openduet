// M12 choosing the model for a turn (contract §4, §9): the channel's own model else the default; the
// main thread ignores a channel model; a task uses its channel's; the thinking level (channel ->
// user default -> model default -> medium, clamped); utility -> the background model, else the
// default, at off; the retry pin; a deleted channel model falls back with the system line; nothing
// usable -> a no_model card without retry; a failing model never falls back to another one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Message } from "../../src/contract/messages.ts";
import { MemoryCurator } from "../../src/memory/curator.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { call, channelOf, failing, startModelsApp, type ModelsApp } from "./harness.ts";

const MODELS_DEV = {
  openai: { models: {
    "gpt-a": { name: "GPT A", limit: { context: 200000, output: 32000 }, tool_call: true, reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }] },
    "gpt-b": { name: "GPT B", limit: { context: 100000, output: 16000 }, tool_call: true, reasoning: true, reasoning_options: [{ type: "effort", values: ["minimal", "high"] }] },
    "gpt-plain": { name: "Plain", tool_call: false, limit: { context: 8000, output: 2000 } },
  } },
};

let t: ModelsApp;
let providerId: string;
let a: string;
let b: string;
let c: string;
let plain: string;
let trips: string;
beforeAll(async () => {
  t = await startModelsApp();
  t.net.modelsDev = MODELS_DEV;
  providerId = (await call(t, t.alex, "POST", "/api/providers", { kind: "openai", key: "sk-resolve-test-key-5555" })).body.provider.id;
  const add = async (modelId: string) => (await call(t, t.alex, "POST", "/api/models", { providerId, modelId })).body.model.id as string;
  a = await add("gpt-a");
  b = await add("gpt-b");
  c = await add("gpt-c");
  plain = await add("gpt-plain");
  trips = await channelOf(t);
});
afterAll(() => t.fixture.cleanup());

let seq = 0;
/** One chat turn in a channel, run to the end. */
async function chat(user: SignedIn, channelId: string, text = "Hello") {
  const response = await t.fixture.app.request(`/api/channels/${channelId}/messages`, {
    method: "POST", headers: { ...user.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text, clientId: `resolve-${++seq}` }),
  });
  if (response.status !== 200) throw new Error(`send failed: ${response.status} ${await response.text()}`);
  const frames = await readSse(response, { timeoutMs: 10_000 });
  await t.runs.idle();
  return frames;
}
const lastRequest = () => t.scripts.requests().at(-1)!;
const cardsIn = async (channelId: string) => {
  const rows = (await call(t, t.alex, "GET", `/api/channels/${channelId}/messages?limit=100`)).body.messages as Message[];
  return rows.filter((m) => m.kind === "model_error");
};
const setDefaults = (body: Record<string, unknown>) => call(t, t.alex, "PUT", "/api/model-defaults", body);
const setChannel = (channelId: string, body: Record<string, unknown>) => call(t, t.alex, "PATCH", `/api/channels/${channelId}`, body);

describe("which model", () => {
  test("the channel's own model, else the default; the main thread ignores a channel model; a task uses its channel's", async () => {
    // Even a modelId written straight into the main thread's row is ignored.
    await t.fixture.db.channel.update({ where: { id: t.alex.mainChannelId }, data: { modelId: b, thinkingLevel: "high" } });
    await chat(t.alex, t.alex.mainChannelId);
    expect(lastRequest()).toMatchObject({ modelId: "gpt-a", providerId, request: { role: "chat", thinkingLevel: "medium" } });
    await t.fixture.db.channel.update({ where: { id: t.alex.mainChannelId }, data: { modelId: null, thinkingLevel: null } });
    // A channel without its own model: the default.
    await chat(t.alex, trips);
    expect(lastRequest()).toMatchObject({ modelId: "gpt-a", request: { thinkingLevel: "medium" } });
    // Its own model (no level anywhere: medium, clamped up onto gpt-b's minimal / high).
    await setChannel(trips, { modelId: b });
    await chat(t.alex, trips);
    expect(lastRequest()).toMatchObject({ modelId: "gpt-b", request: { role: "chat", thinkingLevel: "high" } });
    expect(t.scripts.built.at(-1)!.config.models.map((m) => m.id)).toEqual(["gpt-b"]);
    const run = await t.fixture.db.run.findFirstOrThrow({ where: { userId: t.alex.userId, channelId: trips }, orderBy: { createdAt: "desc" } });
    expect(run).toMatchObject({ providerId, model: "gpt-b", status: "completed" });
    // A task session in that channel runs on the channel's model.
    await t.tasks.service.create({ userId: t.alex.userId, channelId: trips, title: "Book it", prompt: "Book the hotel" });
    await t.runs.idle();
    expect(lastRequest()).toMatchObject({ modelId: "gpt-b", request: { role: "task" } });
    await setChannel(trips, { modelId: null });
  });

  test("the thinking level: channel, then the user's default, then the model's, then medium; clamped onto the model", async () => {
    await call(t, t.alex, "PATCH", `/api/models/${a}`, { defaultThinking: "high" });
    await chat(t.alex, trips);
    expect(lastRequest().request.thinkingLevel).toBe("high");
    await setDefaults({ defaultThinking: "low" });
    await chat(t.alex, trips);
    expect(lastRequest().request.thinkingLevel).toBe("low");
    await setChannel(trips, { thinkingLevel: "medium" });
    await chat(t.alex, trips);
    expect(lastRequest().request.thinkingLevel).toBe("medium");
    // Walk up first (minimal -> low), then down (max -> high).
    await setChannel(trips, { thinkingLevel: "minimal" });
    await chat(t.alex, trips);
    expect(lastRequest().request.thinkingLevel).toBe("low");
    await setChannel(trips, { thinkingLevel: "max" });
    await chat(t.alex, trips);
    expect(lastRequest().request.thinkingLevel).toBe("high");
    // A model without levels always gets off.
    await setChannel(trips, { modelId: c, thinkingLevel: "high" });
    await chat(t.alex, trips);
    expect(lastRequest()).toMatchObject({ modelId: "gpt-c", request: { thinkingLevel: "off" } });
    expect(lastRequest().request.thinking).toBeUndefined();
    await setChannel(trips, { modelId: null, thinkingLevel: null });
    await setDefaults({ defaultThinking: null });
    await call(t, t.alex, "PATCH", `/api/models/${a}`, { defaultThinking: null });
  });

  test("utility: the background model (tools not needed), else the default, at off clamped; the retry pin is exactly that model", async () => {
    const resolve = (q: { role: "chat" | "utility"; pinModelId?: string; channelId?: string | null }) =>
      t.models.resolver.resolve({ userId: t.alex.userId, channelId: q.channelId ?? null, role: q.role, ...(q.pinModelId ? { pinModelId: q.pinModelId } : {}) });
    // No background model: the default; off isn't one of gpt-a's levels, so it walks up to low.
    expect(await resolve({ role: "utility" })).toMatchObject({ entryId: a, thinkingLevel: "low" });
    await setDefaults({ utilityModelId: plain });
    expect(await resolve({ role: "utility" })).toMatchObject({ entryId: plain, label: "Plain", thinkingLevel: "off" });
    expect(await resolve({ role: "chat" })).toMatchObject({ entryId: a });
    // One model, never a chain.
    const resolved = (await resolve({ role: "utility" }))!;
    expect(resolved.llm.models.models.map((m) => m.id)).toEqual(["gpt-plain"]);
    expect(Object.values(resolved.llm.models.roles)).toEqual([["gpt-plain"], ["gpt-plain"], ["gpt-plain"], ["gpt-plain"]]);
    // The pin wins over the channel and the default; an unusable or missing pin is nothing (no fallback).
    await setChannel(trips, { modelId: c });
    expect(await resolve({ role: "chat", channelId: trips, pinModelId: b })).toMatchObject({ entryId: b });
    expect(await resolve({ role: "chat", channelId: trips, pinModelId: plain })).toBeNull();
    expect(await resolve({ role: "chat", pinModelId: "missing" })).toBeNull();
    await setChannel(trips, { modelId: null });
    await setDefaults({ utilityModelId: null });
  });

  test("the memory curator goes through the resolver with role utility", async () => {
    const curator = new MemoryCurator({ db: t.fixture.db, llm: null, resolver: t.models.resolver });
    expect(curator.configured).toBe(true);
    await setDefaults({ utilityModelId: plain });
    expect(await curator.hasModel(t.alex.userId)).toBe(true);
    t.scripts.push([{ type: "text_delta", text: JSON.stringify({ add: [], archive: [] }) }]);
    const result = await curator.curate({ userId: t.alex.userId, channelId: null, sourceChannelId: t.alex.mainChannelId });
    expect(result).toMatchObject({ status: "applied", added: 0, archived: 0 });
    expect(lastRequest()).toMatchObject({ modelId: "gpt-plain", request: { role: "utility", thinkingLevel: "off" } });
    await setDefaults({ utilityModelId: null });
    const sam = await signUp(t.fixture, "curated");
    expect(await curator.hasModel(sam.userId)).toBe(false);
    expect(await curator.curate({ userId: sam.userId, channelId: null, sourceChannelId: sam.mainChannelId })).toBeNull();
  });
});

describe("fallbacks and failures", () => {
  test("a deleted channel model: the system line, then the next turn runs on the default", async () => {
    const extra = (await call(t, t.alex, "POST", "/api/models", { providerId, modelId: "gpt-extra", label: "Extra" })).body.model.id as string;
    await setChannel(trips, { modelId: extra, thinkingLevel: "high" });
    await chat(t.alex, trips);
    expect(lastRequest().modelId).toBe("gpt-extra");
    expect((await call(t, t.alex, "DELETE", `/api/models/${extra}`)).status).toBe(204);
    const rows = (await call(t, t.alex, "GET", `/api/channels/${trips}/messages?limit=100`)).body.messages as Message[];
    expect(rows.at(-1)).toMatchObject({ kind: "system", role: "system", payload: { phrase: { key: "system.channel_model_removed", params: { model: { type: "text", value: "Extra" } } } } });
    await chat(t.alex, trips);
    expect(lastRequest()).toMatchObject({ modelId: "gpt-a", request: { thinkingLevel: "medium" } });
  });

  test("nothing usable: the turn fails with system.no_model and its card has no retry; no model is asked", async () => {
    const sam = await signUp(t.fixture, "nomodel");
    const built = t.scripts.built.length;
    const frames = await chat(sam, sam.mainChannelId, "Anyone there?");
    const done = frames.events.find((e) => e.type === "done");
    expect(done?.payload).toMatchObject({ status: "failed", error: { key: "system.no_model" } });
    const card = frames.events.flatMap((e) => (e.type === "message" ? [e.payload.message] : [])).find((m) => m.kind === "model_error");
    expect(card).toMatchObject({ role: "system", payload: { phrase: { key: "system.no_model" }, modelId: null, modelLabel: null, retry: false, state: "open" } });
    expect(frames.events.some((e) => e.type === "message" && e.payload.message.kind === "system")).toBe(false);
    expect(t.scripts.built.length).toBe(built);
    // Retry is refused (the app offers setup instead); dismiss works.
    const retry = await call(t, sam, "POST", `/api/messages/${card!.id}/action`, { action: "retry" });
    expect(retry).toMatchObject({ status: 400, body: { error: { code: "validation_failed", field: "action" } } });
    expect((await call(t, sam, "POST", `/api/messages/${card!.id}/action`, { action: "dismiss" })).body.message.payload.state).toBe("dismissed");
  });

  test("a failing model doesn't fall back to another one: one model, one card naming it, retry offered", async () => {
    await setChannel(trips, { modelId: b });
    const built = t.scripts.built.length;
    t.scripts.push(failing(529));
    const frames = await chat(t.alex, trips);
    expect(t.scripts.built.length).toBe(built + 1);
    expect(t.scripts.requests().slice(-1).map((r) => r.modelId)).toEqual(["gpt-b"]);
    expect(t.scripts.built.at(-1)!.config.models).toHaveLength(1);
    expect(frames.events.some((e) => e.type === "message" && e.payload.message.role === "assistant")).toBe(false);
    const cards = await cardsIn(trips);
    expect(cards.at(-1)).toMatchObject({ payload: { phrase: { key: "system.model_error", params: { status: { type: "number", value: 529 } } }, modelId: b, modelLabel: "GPT B", retry: true, state: "open" } });
    await setChannel(trips, { modelId: null });
  });
});
