// M12 models, defaults and deletes (contract §2, §3, §9): adding by id and in a batch (numbers from
// models.dev or the defaults), PATCH (only the given fields, `edited`), the auto default, PUT
// /api/model-defaults validation, the deletes (409 on the default, the last model, the utility
// model, channels falling back with the system line, a provider at once), a channel's own model
// (PATCH /api/channels) and Features.models / webSearch on /api/me.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Channel } from "../../src/contract/channels.ts";
import { Me } from "../../src/contract/auth.ts";
import { ModelEntryResponse, ModelsState } from "../../src/contract/m12.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { call, channelOf, startModelsApp, type ModelsApp } from "./harness.ts";

const MODELS_DEV = {
  openai: { models: {
    "gpt-a": { name: "GPT A", limit: { context: 400000, output: 128000 }, tool_call: true, reasoning: true, reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }], modalities: { input: ["text", "image"], output: ["text"] } },
    "gpt-notools": { name: "No tools", tool_call: false, limit: { context: 8000, output: 2000 } },
  } },
};
const LIST = { data: [{ id: "gpt-a" }, { id: "gpt-b" }, { id: "gpt-notools" }, { id: "gpt-realtime" }] };

let t: ModelsApp;
let n = 0;
beforeAll(async () => {
  t = await startModelsApp();
  t.net.modelsDev = MODELS_DEV;
  t.net.lists.set("api.openai.com", LIST);
});
afterAll(() => t.fixture.cleanup());

const user = () => signUp(t.fixture, `models${++n}`);
const state = async (u: SignedIn) => ModelsState.parse((await call(t, u, "GET", "/api/models")).body);
const provider = async (u: SignedIn, body: Record<string, unknown> = {}) => {
  const r = await call(t, u, "POST", "/api/providers", { kind: "openai", key: "sk-models-test-key-0001", ...body });
  if (r.status !== 200) throw new Error(`provider: ${r.status} ${r.text}`);
  return r.body.provider.id as string;
};
const add = async (u: SignedIn, providerId: string, modelId: string, extra: Record<string, unknown> = {}) => {
  const r = await call(t, u, "POST", "/api/models", { providerId, modelId, ...extra });
  if (r.status !== 200) throw new Error(`model: ${r.status} ${r.text}`);
  return ModelEntryResponse.parse(r.body).model;
};
const me = async (u: SignedIn) => Me.parse((await call(t, u, "GET", "/api/me")).body);
const patchChannel = (u: SignedIn, id: string, body: Record<string, unknown>) => call(t, u, "PATCH", `/api/channels/${id}`, body);

describe("POST /api/models and /api/models/batch", () => {
  test("adding by id copies the enriched numbers; the first usable chat model becomes the default; 409 on a duplicate", async () => {
    const u = await user();
    expect((await me(u)).features.models).toBe(false);
    const pid = await provider(u);
    expect(await state(u)).toMatchObject({ configured: false, defaults: { defaultModelId: null, defaultThinking: null, utilityModelId: null } });
    const a = await add(u, pid, "gpt-a");
    expect(a).toMatchObject({
      providerId: pid, purpose: "chat", modelId: "gpt-a", label: "GPT A", contextWindow: 400000, maxOutputTokens: 128000,
      thinkingLevels: ["minimal", "low", "medium", "high"], thinkingFormat: "effort", defaultThinking: null,
      tools: true, vision: true, serverWebTools: false, promptCaching: false, source: "models.dev", edited: [],
    });
    expect(await state(u)).toMatchObject({ configured: true, defaults: { defaultModelId: a.id } });
    expect((await me(u)).features.models).toBe(true);
    // models.dev doesn't know it: the defaults; a label given here counts as edited.
    const b = await add(u, pid, "gpt-b", { label: "Bee" });
    expect(b).toMatchObject({ label: "Bee", contextWindow: 128000, maxOutputTokens: 8192, thinkingLevels: [], thinkingFormat: "none", tools: true, vision: false, source: "default", edited: ["label"] });
    expect((await state(u)).defaults.defaultModelId).toBe(a.id);
    const dup = await call(t, u, "POST", "/api/models", { providerId: pid, modelId: "gpt-a" });
    expect(dup).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
    // Someone else's provider (or none) is 400 field providerId.
    const other = await user();
    expect((await call(t, other, "POST", "/api/models", { providerId: pid, modelId: "gpt-x" })).body.error).toMatchObject({ code: "validation_failed", field: "providerId" });
    expect((await call(t, u, "POST", "/api/models", { providerId: "nope", modelId: "gpt-x" })).body.error.field).toBe("providerId");
    expect((await call(t, u, "POST", "/api/models", { providerId: pid, modelId: "gpt-x", extra: 1 })).status).toBe(400);
  });

  test("batch: ids already added (and repeats) are skipped; a realtime model is never a chat candidate", async () => {
    const u = await user();
    const pid = await provider(u);
    const first = await add(u, pid, "gpt-b");
    const r = await call(t, u, "POST", "/api/models/batch", { providerId: pid, modelIds: ["gpt-realtime", "gpt-b", "gpt-a", "gpt-a", "gpt-notools"] });
    expect(r.status).toBe(200);
    const s = ModelsState.parse(r.body);
    expect(s.models.map((m) => m.modelId).sort()).toEqual(["gpt-a", "gpt-b", "gpt-notools", "gpt-realtime"]);
    expect(s.providers[0]!.modelCount).toBe(4);
    const realtime = s.models.find((m) => m.modelId === "gpt-realtime")!;
    expect(realtime).toMatchObject({ purpose: "realtime", source: "default" });
    expect(s.models.find((m) => m.modelId === "gpt-notools")).toMatchObject({ purpose: "chat", tools: false, source: "models.dev" });
    expect(s.defaults.defaultModelId).toBe(first.id);
    // A realtime row can't be the default, the background model or a channel's model.
    expect((await call(t, u, "PUT", "/api/model-defaults", { defaultModelId: realtime.id })).body.error.field).toBe("defaultModelId");
    expect((await call(t, u, "PUT", "/api/model-defaults", { utilityModelId: realtime.id })).body.error.field).toBe("utilityModelId");
    expect((await patchChannel(u, await channelOf(t, u), { modelId: realtime.id })).body.error.field).toBe("modelId");
    // The request's purpose wins over the guess.
    expect((await add(u, pid, "live-notes", { purpose: "chat" })).purpose).toBe("chat");
    // The whole batch is 400 for someone else's provider.
    const other = await user();
    expect((await call(t, other, "POST", "/api/models/batch", { providerId: pid, modelIds: ["gpt-a"] })).body.error.field).toBe("providerId");
  });

  test("batch on a user without a default: the first usable model in the request's order becomes it", async () => {
    const u = await user();
    const pid = await provider(u);
    const s = ModelsState.parse((await call(t, u, "POST", "/api/models/batch", { providerId: pid, modelIds: ["gpt-realtime", "gpt-notools", "gpt-b", "gpt-a"] })).body);
    expect(s.defaults.defaultModelId).toBe(s.models.find((m) => m.modelId === "gpt-b")!.id);
    expect(s.configured).toBe(true);
  });
});

describe("PATCH /api/models/:id", () => {
  test("writes only the given fields and adds their names to edited; levels in ladder order", async () => {
    const u = await user();
    const pid = await provider(u);
    const a = await add(u, pid, "gpt-a");
    const b = await add(u, pid, "gpt-b", { label: "Bee" });
    const r = await call(t, u, "PATCH", `/api/models/${b.id}`, { thinkingLevels: ["high", "off", "low", "high"], thinkingFormat: "effort", defaultThinking: "low", vision: true });
    expect(r.status).toBe(200);
    const patched = ModelEntryResponse.parse(r.body).model;
    expect(patched).toMatchObject({ label: "Bee", thinkingLevels: ["off", "low", "high"], thinkingFormat: "effort", defaultThinking: "low", vision: true, contextWindow: 128000, tools: true });
    expect([...patched.edited].sort()).toEqual(["defaultThinking", "label", "thinkingFormat", "thinkingLevels", "vision"]);
    // A second PATCH merges into edited (no repeats).
    const again = ModelEntryResponse.parse((await call(t, u, "PATCH", `/api/models/${b.id}`, { vision: false, serverWebTools: true })).body).model;
    expect([...again.edited].sort()).toEqual(["defaultThinking", "label", "serverWebTools", "thinkingFormat", "thinkingLevels", "vision"]);
    expect(again).toMatchObject({ vision: false, serverWebTools: true });
    // Output above the context window is 400 field maxOutputTokens, whichever side moved.
    expect((await call(t, u, "PATCH", `/api/models/${b.id}`, { maxOutputTokens: 200000 })).body.error).toMatchObject({ code: "validation_failed", field: "maxOutputTokens" });
    expect((await call(t, u, "PATCH", `/api/models/${b.id}`, { contextWindow: 4000 })).body.error.field).toBe("maxOutputTokens");
    expect(ModelEntryResponse.parse((await call(t, u, "PATCH", `/api/models/${b.id}`, { contextWindow: 4000, maxOutputTokens: 2000 })).body).model).toMatchObject({ contextWindow: 4000, maxOutputTokens: 2000 });
    // tools:false on the default is refused; on another model it's fine.
    expect((await call(t, u, "PATCH", `/api/models/${a.id}`, { tools: false })).body.error).toMatchObject({ code: "validation_failed", field: "tools" });
    expect(ModelEntryResponse.parse((await call(t, u, "PATCH", `/api/models/${b.id}`, { tools: false })).body).model.tools).toBe(false);
    expect((await state(u)).defaults.defaultModelId).toBe(a.id);
    // Unknown fields 400; someone else's or a missing id 404.
    expect((await call(t, u, "PATCH", `/api/models/${b.id}`, { modelId: "x" })).status).toBe(400);
    expect((await call(t, await user(), "PATCH", `/api/models/${b.id}`, { label: "Mine" })).status).toBe(404);
    expect((await call(t, u, "PATCH", "/api/models/missing", { label: "x" })).status).toBe(404);
  });

  test("auto default: a model that gets tools while there's no default becomes it", async () => {
    const u = await user();
    const pid = await provider(u);
    const plain = await add(u, pid, "gpt-notools");
    expect(plain.tools).toBe(false);
    expect(await state(u)).toMatchObject({ configured: false, defaults: { defaultModelId: null } });
    await call(t, u, "PATCH", `/api/models/${plain.id}`, { tools: true });
    expect(await state(u)).toMatchObject({ configured: true, defaults: { defaultModelId: plain.id } });
  });
});

describe("PUT /api/model-defaults", () => {
  test("defaultModelId must be usable (null only while none is); utility any chat model; any thinking level", async () => {
    const u = await user();
    const pid = await provider(u);
    // Nothing usable yet: null is accepted.
    expect((await call(t, u, "PUT", "/api/model-defaults", { defaultModelId: null })).status).toBe(200);
    const plain = await add(u, pid, "gpt-notools");
    const a = await add(u, pid, "gpt-a");
    const b = await add(u, pid, "gpt-b");
    expect((await call(t, u, "PUT", "/api/model-defaults", { defaultModelId: plain.id })).body.error).toMatchObject({ code: "validation_failed", field: "defaultModelId" });
    expect((await call(t, u, "PUT", "/api/model-defaults", { defaultModelId: null })).body.error.field).toBe("defaultModelId");
    const r = await call(t, u, "PUT", "/api/model-defaults", { defaultModelId: b.id, defaultThinking: "high", utilityModelId: plain.id });
    expect(r.status).toBe(200);
    expect(ModelsState.parse(r.body)).toMatchObject({ configured: true, defaults: { defaultModelId: b.id, defaultThinking: "high", utilityModelId: plain.id } });
    // Only the given fields change.
    expect(ModelsState.parse((await call(t, u, "PUT", "/api/model-defaults", { utilityModelId: null })).body).defaults).toEqual({ defaultModelId: b.id, defaultThinking: "high", utilityModelId: null });
    expect(ModelsState.parse((await call(t, u, "PUT", "/api/model-defaults", { defaultThinking: null, defaultModelId: a.id })).body).defaults).toEqual({ defaultModelId: a.id, defaultThinking: null, utilityModelId: null });
    // Someone else's model, an unknown id, a bad level or an unknown field: 400.
    const other = await user();
    const theirs = await add(other, await provider(other), "gpt-a");
    expect((await call(t, u, "PUT", "/api/model-defaults", { defaultModelId: theirs.id })).body.error.field).toBe("defaultModelId");
    expect((await call(t, u, "PUT", "/api/model-defaults", { utilityModelId: theirs.id })).body.error.field).toBe("utilityModelId");
    expect((await call(t, u, "PUT", "/api/model-defaults", { utilityModelId: "missing" })).body.error.field).toBe("utilityModelId");
    expect((await call(t, u, "PUT", "/api/model-defaults", { defaultThinking: "ultra" })).status).toBe(400);
    expect((await call(t, u, "PUT", "/api/model-defaults", { configured: true })).status).toBe(400);
    expect((await state(u)).defaults).toEqual({ defaultModelId: a.id, defaultThinking: null, utilityModelId: null });
  });
});

describe("deletes", () => {
  test("the default: 409 while another usable chat model exists; the last one is deleted and nothing is configured", async () => {
    const u = await user();
    const pid = await provider(u);
    const a = await add(u, pid, "gpt-a");
    const plain = await add(u, pid, "gpt-notools");
    const b = await add(u, pid, "gpt-b");
    const refused = await call(t, u, "DELETE", `/api/models/${a.id}`);
    expect(refused).toMatchObject({ status: 409, body: { error: { code: "conflict", message: "Choose another default model first." } } });
    expect((await call(t, u, "DELETE", `/api/models/${b.id}`)).status).toBe(204);
    // Only a model without tools is left besides the default: it can go.
    expect((await call(t, u, "DELETE", `/api/models/${a.id}`)).status).toBe(204);
    expect(await state(u)).toMatchObject({ configured: false, defaults: { defaultModelId: null }, models: [{ id: plain.id }] });
    expect((await me(u)).features.models).toBe(false);
    expect((await call(t, u, "DELETE", `/api/models/${a.id}`)).status).toBe(404);
    expect((await call(t, await user(), "DELETE", `/api/models/${plain.id}`)).status).toBe(404);
  });

  test("the utility model goes back to null; a channel using the model falls back with a system line and a channel event", async () => {
    const u = await user();
    const pid = await provider(u);
    await add(u, pid, "gpt-a");
    const b = await add(u, pid, "gpt-b", { label: "Bee" });
    await call(t, u, "PUT", "/api/model-defaults", { utilityModelId: b.id });
    const channelId = await channelOf(t, u);
    const set = await patchChannel(u, channelId, { modelId: b.id, thinkingLevel: "high" });
    expect(Channel.parse(set.body)).toMatchObject({ modelId: b.id, thinkingLevel: "high" });
    const before = await t.fixture.db.event.findFirst({ where: { userId: u.userId }, orderBy: { id: "desc" } });
    expect((await call(t, u, "DELETE", `/api/models/${b.id}`)).status).toBe(204);
    expect((await state(u)).defaults.utilityModelId).toBeNull();
    expect(await t.fixture.db.channel.findUniqueOrThrow({ where: { id: channelId } })).toMatchObject({ modelId: null, thinkingLevel: null });
    const line = await t.fixture.db.message.findFirstOrThrow({ where: { channelId, kind: "system" } });
    expect(JSON.parse(line.payload)).toEqual({ phrase: { key: "system.channel_model_removed", params: { model: { type: "text", value: "Bee" } } } });
    const events = await t.fixture.db.event.findMany({ where: { userId: u.userId, id: { gt: before?.id ?? 0 } } });
    const channelEvent = events.find((e) => e.type === "channel");
    expect(channelEvent?.channelId).toBe(channelId);
    expect(JSON.parse(channelEvent!.payload).channel).toMatchObject({ id: channelId, modelId: null, thinkingLevel: null });
    expect(events.some((e) => e.type === "message" && JSON.parse(e.payload).message.kind === "system")).toBe(true);
  });

  test("a provider: 409 while it hosts the default and other chat models exist elsewhere; then its models, channels and vault rows at once", async () => {
    const u = await user();
    const p1 = await provider(u);
    const p2 = await provider(u, { kind: "stepfun" });
    const a = await add(u, p1, "gpt-a");
    const b = await add(u, p1, "gpt-b", { label: "Bee" });
    const other = await add(u, p2, "gpt-a");
    const channelId = await channelOf(t, u);
    await patchChannel(u, channelId, { modelId: b.id });
    await call(t, u, "PUT", "/api/model-defaults", { utilityModelId: a.id });
    expect((await call(t, u, "DELETE", `/api/providers/${p1}`)).body.error).toMatchObject({ code: "conflict", message: "Choose another default model first." });
    expect(await t.fixture.db.modelEntry.count({ where: { providerId: p1 } })).toBe(2);
    await call(t, u, "PUT", "/api/model-defaults", { defaultModelId: other.id });
    expect((await call(t, u, "DELETE", `/api/providers/${p1}`)).status).toBe(204);
    const s = await state(u);
    expect(s.providers.map((p) => p.id)).toEqual([p2]);
    expect(s.models.map((m) => m.id)).toEqual([other.id]);
    expect(s.defaults).toEqual({ defaultModelId: other.id, defaultThinking: null, utilityModelId: null });
    expect((await t.fixture.db.channel.findUniqueOrThrow({ where: { id: channelId } })).modelId).toBeNull();
    const line = await t.fixture.db.message.findFirstOrThrow({ where: { channelId, kind: "system" } });
    expect(JSON.parse(line.payload).phrase.params.model.value).toBe("Bee");
    expect(await t.fixture.db.vaultSecret.count({ where: { ownerKind: "provider", ownerId: p1 } })).toBe(0);
    // The last provider (with the default on it) can always go.
    expect((await call(t, u, "DELETE", `/api/providers/${p2}`)).status).toBe(204);
    expect(await state(u)).toMatchObject({ providers: [], models: [], configured: false, defaults: { defaultModelId: null } });
  });
});

describe("PATCH /api/channels/:id (a channel's own model)", () => {
  test("a usable chat model with tools, or null for the default; not on the main thread", async () => {
    const u = await user();
    const pid = await provider(u);
    await add(u, pid, "gpt-a");
    const b = await add(u, pid, "gpt-b");
    const plain = await add(u, pid, "gpt-notools");
    const channelId = await channelOf(t, u);
    for (const body of [{ modelId: b.id }, { thinkingLevel: "high" }, { modelId: null }]) {
      const r = await patchChannel(u, u.mainChannelId, body);
      expect(r).toMatchObject({ status: 400, body: { error: { code: "validation_failed", field: Object.keys(body)[0] } } });
    }
    expect((await patchChannel(u, channelId, { modelId: plain.id })).body.error).toMatchObject({ field: "modelId", message: "modelId: must be a chat model with tools whose provider has a key" });
    expect((await patchChannel(u, channelId, { modelId: "missing" })).body.error.field).toBe("modelId");
    expect((await patchChannel(u, channelId, { thinkingLevel: "ultra" })).status).toBe(400);
    const other = await user();
    const theirs = await add(other, await provider(other), "gpt-a");
    expect((await patchChannel(u, channelId, { modelId: theirs.id })).body.error.field).toBe("modelId");
    const set = Channel.parse((await patchChannel(u, channelId, { modelId: b.id, thinkingLevel: "minimal" })).body);
    expect(set).toMatchObject({ id: channelId, modelId: b.id, thinkingLevel: "minimal" });
    const listed = (await call(t, u, "GET", "/api/channels")).body.channels as { id: string; modelId: string | null; thinkingLevel: string | null }[];
    expect(listed.find((c) => c.id === channelId)).toMatchObject({ modelId: b.id, thinkingLevel: "minimal" });
    expect(listed.find((c) => c.id === u.mainChannelId)).toMatchObject({ modelId: null, thinkingLevel: null });
    // null goes back to the defaults.
    expect(Channel.parse((await patchChannel(u, channelId, { modelId: null, thinkingLevel: null })).body)).toMatchObject({ modelId: null, thinkingLevel: null });
    // A model whose provider has lost its key isn't usable.
    await t.fixture.db.vaultSecret.deleteMany({ where: { ownerKind: "provider", ownerId: pid } });
    expect((await patchChannel(u, channelId, { modelId: b.id })).body.error.field).toBe("modelId");
  });
});

describe("/api/me features", () => {
  test("models follows usable defaults; webSearch stays available through the key-less default", async () => {
    const u = await user();
    expect((await me(u)).features).toMatchObject({ models: false, webSearch: true });
    const pid = await provider(u);
    expect((await me(u)).features.models).toBe(false);
    const a = await add(u, pid, "gpt-a");
    const b = await add(u, pid, "gpt-b");
    expect((await me(u)).features).toMatchObject({ models: true, webSearch: true });
    // Native search is additive: the key-less default already offers search.
    await call(t, u, "PATCH", `/api/models/${b.id}`, { serverWebTools: true });
    expect((await me(u)).features.webSearch).toBe(true);
    await call(t, u, "PATCH", `/api/models/${a.id}`, { serverWebTools: true });
    expect((await me(u)).features).toMatchObject({ models: true, webSearch: true });
    await t.fixture.db.vaultSecret.deleteMany({ where: { ownerKind: "provider", ownerId: pid } });
    expect((await me(u)).features).toMatchObject({ models: false, webSearch: true });
    expect((await state(u)).configured).toBe(false);
  });
});
