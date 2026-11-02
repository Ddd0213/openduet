import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SteeringInbox } from "../../src/agent/steering.ts";
import { LlmError } from "../../src/llm/index.ts";
import { call, deferred, json, restarted, RoleScriptedLlm, startApp, text, type TaskApp } from "../tasks/harness.ts";
import { readSse } from "../helpers/sse.ts";

describe("steering admission boundaries", () => {
  test("a final empty poll closes admission synchronously", async () => {
    const inbox = new SteeringInbox<string>();
    expect(inbox.reserve()).toBeNull();
    inbox.open();
    const closing = inbox.take(true);
    expect(inbox.reserve()).toBeNull();
    expect(await closing).toEqual([]);
  });
  test("accepted writes settle in admission order; closing waits without replaying them", async () => {
    const inbox = new SteeringInbox<string>();
    inbox.open();
    const first = inbox.reserve()!, second = inbox.reserve()!;
    const read = inbox.take(true);
    second("second"); first("first");
    expect(await read).toEqual(["first", "second"]);
    const late = inbox.reserve()!;
    let closed = false;
    const closing = inbox.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(inbox.reserve()).toBeNull();
    late("retained in history");
    await closing;
    expect(await inbox.take()).toEqual([]);
  });
  test("a failed persistence reservation cannot leave an empty final poll open", async () => {
    const inbox = new SteeringInbox<string>();
    inbox.open();
    const failed = inbox.reserve()!;
    const read = inbox.take(true);
    failed();
    expect(await read).toEqual([]);
    expect(inbox.reserve()).toBeNull();
  });
});

let t: TaskApp;
beforeAll(async () => { t = await startApp(); });
afterAll(() => t.fixture.cleanup());
const channel = () => t.fixture.db.channel.create({ data: { userId: t.alex.userId, name: "Steering", purpose: "Test steering" } });
const send = (channelId: string, value: string, clientId: string = crypto.randomUUID()) => t.fixture.runs.send({
  userId: t.alex.userId, channelId, text: value, clientId, fileIds: [], skill: null, quickReply: null,
});
const requestText = (request: { messages: unknown }) => JSON.stringify(request.messages);

describe("default steering through the real runtime and run host", () => {
  test("multiple corrections enter the next model request in the same run, without aborting the current request", async () => {
    const c = await channel(), entered = deferred(), release = deferred();
    const from = t.llm.requests.length;
    t.llm.script("chat", async (request) => {
      entered.resolve(); await release.promise;
      expect(request.signal?.aborted).toBe(false);
      expect(requestText(request)).not.toContain("改成上海");
      return [text("正在整理。")];
    }, (request) => {
      const content = requestText(request);
      expect(content).toContain("找北京酒店");
      expect(content.indexOf("改成上海")).toBeLessThan(content.indexOf("预算500以内"));
      return [text("按上海和预算筛选。")];
    });
    const first = await send(c.id, "找北京酒店");
    await entered.promise;
    const second = await send(c.id, "改成上海", "steer-dedupe");
    const third = await send(c.id, "预算500以内");
    const retry = await send(c.id, "改成上海", "steer-dedupe");
    expect(second.runId).toBe(first.runId); expect(third.runId).toBe(first.runId);
    expect(retry).toMatchObject({ runId: first.runId, message: { id: second.message.id } });
    expect(await t.fixture.db.run.count({ where: { channelId: c.id } })).toBe(1);
    expect((await t.fixture.db.message.findUniqueOrThrow({ where: { id: second.message.id } })).status).toBe("sent");
    release.resolve(); await t.fixture.runs.idle();
    expect(t.llm.requests.length - from).toBe(2);
    for (const m of [second.message, third.message]) expect((await t.fixture.db.message.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("seen");
    expect((await send(c.id, "改成上海", "steer-dedupe")).runId).toBeNull();
  });

  test("a correction during an executed tool batch retains the results and never repeats the tool", async () => {
    const c = await channel(), entered = deferred(), release = deferred();
    const original = t.tasks.service.create.bind(t.tasks.service);
    // start_task is a real tool; hold the service operation after it starts.
    t.tasks.service.create = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
    const from = t.llm.requests.length;
    t.llm.script("chat", [call("start_task", { title: "Research", prompt: "Read the plan" }, "research-call")], (request) => {
      const content = requestText(request);
      expect(content).toContain("research-call");
      expect(content).toContain("tool_result");
      expect(content).toContain("只比较，不预订");
      return [text("收到，只比较。")];
    });
    t.llm.script("task", [call("ask_user", { question: "Which plan?" })]);
    try {
      const first = await send(c.id, "开始调研");
      await entered.promise;
      expect((await send(c.id, "只比较，不预订")).runId).toBe(first.runId);
      release.resolve(); await t.fixture.runs.idle();
      expect(await t.fixture.db.task.count({ where: { channelId: c.id } })).toBe(1);
      expect(t.llm.requests.slice(from).filter((r) => r.role === "chat")).toHaveLength(2);
    } finally { release.resolve(); t.tasks.service.create = original; }
  });

  test("Stop before the model reads a correction: the correction runs as its own turn", async () => {
    const c = await channel(), entered = deferred();
    const from = t.llm.requests.length;
    t.llm.script("chat", async (request) => {
      entered.resolve();
      await new Promise<void>((resolve) => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
      // A provider can finish normally just as Stop arrives (or during the final bubble flush).
      return [text("Late final reply")];
    }, (request) => {
      expect(requestText(request)).toContain("改成上海");
      return [text("好的，改成上海。")];
    });
    const first = await send(c.id, "Start"); await entered.promise;
    const correction = await send(c.id, "改成上海");
    expect(correction.runId).toBe(first.runId);
    await t.fixture.runs.stop({ userId: t.alex.userId, channelId: c.id });
    await t.fixture.runs.idle();
    expect(t.llm.requests.length - from).toBe(2);
    expect((await t.fixture.db.run.findUniqueOrThrow({ where: { id: first.runId! } })).status).toBe("cancelled");
    const runs = await t.fixture.db.run.findMany({ where: { channelId: c.id }, orderBy: { createdAt: "asc" } });
    expect(runs.map((r) => r.status)).toEqual(["cancelled", "completed"]);
    expect((await t.fixture.db.message.findUniqueOrThrow({ where: { id: correction.message.id } })).status).toBe("seen");
  });

  test("Stop after the model started on a correction: it stays part of the stopped turn", async () => {
    const c = await channel(), entered = deferred(), release = deferred(), creating = deferred(), hold = deferred();
    const original = t.tasks.service.create.bind(t.tasks.service);
    // The second round starts a task (its tool call marks the correction seen), and the tool hangs there.
    t.tasks.service.create = async (...args) => { creating.resolve(); await hold.promise; return original(...args); };
    const from = t.llm.requests.length;
    t.llm.script("chat", async () => { entered.resolve(); await release.promise; return [text("先看北京。")]; },
      [call("start_task", { title: "Shanghai hotels", prompt: "Compare" })]);
    t.llm.script("task", [text("Comparing.")]);
    try {
      const first = await send(c.id, "找北京酒店"); await entered.promise;
      const correction = await send(c.id, "改成上海");
      expect(correction.runId).toBe(first.runId);
      release.resolve(); await creating.promise;
      expect((await t.fixture.db.message.findUniqueOrThrow({ where: { id: correction.message.id } })).status).toBe("seen");
      await t.fixture.runs.stop({ userId: t.alex.userId, channelId: c.id });
      // Only the stopped turn's two model calls; the correction it was working on doesn't run again.
      expect(t.llm.requests.filter((r, i) => i >= from && r.role === "chat")).toHaveLength(2);
      const chatRuns = await t.fixture.db.run.findMany({ where: { channelId: c.id, kind: "chat" } });
      expect(chatRuns.map((r) => r.status)).toEqual(["cancelled"]);
    } finally {
      hold.resolve(); t.tasks.service.create = original;
      await t.fixture.runs.idle();
    }
  });

  test("SSE for the correction ends with the same run, and a later idle send starts a new one", async () => {
    const c = await channel(), entered = deferred(), release = deferred();
    t.llm.script("chat", async () => { entered.resolve(); await release.promise; return [text("First")]; }, [text("Adjusted")], [text("Next")]);
    const first = await send(c.id, "First"); await entered.promise;
    const stream = await t.fixture.app.request(`/api/channels/${c.id}/messages`, json(t.alex, "POST", { text: "Correction", clientId: crypto.randomUUID() }));
    release.resolve();
    const frames = await readSse(stream); await t.fixture.runs.idle();
    expect(frames.events.filter((e) => e.type === "done").map((e) => e.payload.runId)).toEqual([first.runId!]);
    const next = await send(c.id, "Next"); await t.fixture.runs.idle();
    expect(next.runId).not.toBe(first.runId);
  });

  test("failed runs retain steering in the retry target instead of losing or independently replaying it", async () => {
    const c = await channel(), entered = deferred(), release = deferred();
    t.llm.script("chat", async () => { entered.resolve(); await release.promise; return new LlmError({ kind: "http", status: 400, providerId: "test", modelId: "test", attempts: 1 }); });
    const first = await send(c.id, "Original"); await entered.promise;
    const correction = await send(c.id, "Correction"); release.resolve(); await t.fixture.runs.idle();
    const card = await t.fixture.db.message.findFirstOrThrow({ where: { channelId: c.id, kind: "model_error" } });
    const stored = JSON.parse(card.payload);
    expect(stored.retryOf.messageId).toBe(correction.message.id);
    expect(stored.retryOf.folded).toEqual([first.message.id, correction.message.id]);
    t.llm.script("chat", (request) => { expect(requestText(request)).toContain("Original"); expect(requestText(request)).toContain("Correction"); return [text("Noted")]; });
    await t.fixture.runs.retry(t.alex.userId, first.runId!, stored.retryOf, null);
    await t.fixture.runs.idle();
  });

  test("task-session corrections use that task's active run", async () => {
    const entered = deferred(), release = deferred();
    t.llm.script("task", async () => { entered.resolve(); await release.promise; return [text("Working")]; }, (request) => { expect(requestText(request)).toContain("Budget 500"); return [call("ask_user", { question: "Which date?" })]; });
    const task = await t.tasks.service.create({ userId: t.alex.userId, channelId: t.alex.mainChannelId, title: "Task steering", prompt: "Research hotels" });
    await entered.promise;
    const active = await t.fixture.db.run.findFirstOrThrow({ where: { taskId: task.id, status: "running" } });
    const sent = await t.tasks.service.reply(task, { text: "Budget 500", clientId: crypto.randomUUID(), fileIds: [], skill: null, quickReply: null });
    expect(sent.runId).toBe(active.id); release.resolve(); await t.fixture.runs.idle();
    expect(await t.fixture.db.run.count({ where: { taskId: task.id } })).toBe(1);
  });

  test("an attachment and quote are injected with the correction; other channels stay independent", async () => {
    const c = await channel(), other = await channel(), entered = deferred(), release = deferred();
    const quoted = await t.fixture.db.message.create({ data: { userId: t.alex.userId, channelId: c.id, role: "assistant", text: "Original budget" } });
    const bytes = new TextEncoder().encode("Budget: 500 CNY");
    const path = await t.fixture.files.save(t.alex.userId, "text/plain", bytes);
    const file = await t.fixture.db.channelFile.create({ data: { userId: t.alex.userId, channelId: c.id, path, name: "budget.txt", mime: "text/plain", size: bytes.length, source: "user" } });
    t.llm.script("chat", async () => { entered.resolve(); await release.promise; return [text("Working")]; },
      (request) => { expect(requestText(request)).not.toContain("Use attached budget"); return [text("Independent reply")]; },
      (request) => { const content = requestText(request); expect(content).toContain("Budget: 500 CNY"); expect(content).toContain("Original budget"); expect(content).not.toContain("Other channel"); return [text("Budget accepted")]; });
    const first = await send(c.id, "Research"); await entered.promise;
    const correction = await t.fixture.runs.send({ userId: t.alex.userId, channelId: c.id, text: "Use attached budget", clientId: crypto.randomUUID(), fileIds: [file.id], skill: null, quickReply: null, replyTo: quoted.id });
    expect(correction.runId).toBe(first.runId);
    const separate = await send(other.id, "Other channel");
    expect(separate.runId).not.toBe(first.runId);
    // Wait for the independent model request before releasing the first one.
    while (t.llm.remaining("chat") > 1) await Bun.sleep(1);
    release.resolve(); await t.fixture.runs.idle();
  });

  test("a late correction after an end-turn tool preserves call/result pairs and skips unexecuted calls", async () => {
    const c = await channel(), entered = deferred(), release = deferred();
    t.llm.script("chat", async () => { entered.resolve(); await release.promise; return [
      call("quick_replies", { options: ["好", "不用"], text: "Continue?" }, "chips"),
      call("send_feedback", { text: "must not execute" }, "stale-call"),
    ]; }, (request) => {
      const content = requestText(request);
      expect(content).toContain("Actually use Shanghai");
      const results = request.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result");
      expect(results.map((b) => b.toolUseId)).toEqual(["chips", "stale-call"]);
      expect(results[1]!.isError).toBe(true);
      return [text("Shanghai it is")];
    });
    const first = await send(c.id, "Choose a city"); await entered.promise;
    expect((await send(c.id, "Actually use Shanghai")).runId).toBe(first.runId);
    release.resolve(); await t.fixture.runs.idle();
    expect(await t.fixture.db.feedback.count({ where: { text: "must not execute" } })).toBe(0);
    expect((await t.fixture.db.run.findUniqueOrThrow({ where: { id: first.runId! } })).status).toBe("completed");
  });

  test("restart recovers accepted steering with its interrupted run, never as independent work", async () => {
    const llm = new RoleScriptedLlm(), a = restarted(t.fixture, llm);
    const c = await channel(), entered = deferred();
    llm.script("chat", async (request) => { entered.resolve(); await new Promise<void>((resolve) => request.signal!.addEventListener("abort", () => resolve(), { once: true })); return [text("")]; });
    const start = await a.runs.send({ userId: t.alex.userId, channelId: c.id, text: "Original", clientId: crypto.randomUUID(), fileIds: [], skill: null, quickReply: null });
    await entered.promise;
    const correction = await a.runs.send({ userId: t.alex.userId, channelId: c.id, text: "Latest correction", clientId: crypto.randomUUID(), fileIds: [], skill: null, quickReply: null });
    expect(correction.runId).toBe(start.runId);
    await a.runs.shutdown();
    const nextLlm = new RoleScriptedLlm(), b = restarted(t.fixture, nextLlm);
    nextLlm.script("chat", (request) => { expect(requestText(request)).toContain("Original"); expect(requestText(request)).toContain("Latest correction"); return [text("Resumed")]; });
    try {
      expect(await b.runs.recoverStaleRuns()).toBe(1);
      await b.runs.idle();
      expect(nextLlm.sent("chat")).toHaveLength(1);
      expect((await t.fixture.db.message.findUniqueOrThrow({ where: { id: correction.message.id } })).status).toBe("seen");
    } finally { await b.runs.shutdown(); }
  });

  test("a card before steering cannot count as answering a later correction", async () => {
    const llm = new RoleScriptedLlm(), a = restarted(t.fixture, llm);
    const c = await channel(), entered = deferred(), release = deferred();
    llm.script("chat", async () => { entered.resolve(); await release.promise; return [call("quick_replies", { options: ["好", "不用"], text: "Continue?" })]; },
      [], [text("The new correction is understood.")]);
    try {
      const first = await a.runs.send({ userId: t.alex.userId, channelId: c.id, text: "Original", clientId: crypto.randomUUID(), fileIds: [], skill: null, quickReply: null });
      await entered.promise;
      await a.runs.send({ userId: t.alex.userId, channelId: c.id, text: "Correction", clientId: crypto.randomUUID(), fileIds: [], skill: null, quickReply: null });
      release.resolve(); await a.runs.idle();
      expect(llm.sent("chat")).toHaveLength(3);
      expect((await t.fixture.db.run.findUniqueOrThrow({ where: { id: first.runId! } })).status).toBe("completed");
      expect(await t.fixture.db.message.count({ where: { channelId: c.id, text: "The new correction is understood." } })).toBe(1);
    } finally { release.resolve(); await a.runs.shutdown(); }
  });

  test("a retried steering turn survives another restart after its messages age out of the title heuristic", async () => {
    const llm = new RoleScriptedLlm(), a = restarted(t.fixture, llm);
    const c = await channel(), entered = deferred(), release = deferred(), retryEntered = deferred();
    const sendToA = (value: string, skill: string | null = null) => a.runs.send({ userId: t.alex.userId, channelId: c.id, text: value, clientId: crypto.randomUUID(), fileIds: [], skill, quickReply: null });
    llm.script("chat", async () => { entered.resolve(); await release.promise; return new LlmError({ kind: "http", status: 400, providerId: "test", modelId: "test", attempts: 1 }); });
    const first = await sendToA("Original request", "notes"); await entered.promise;
    const correction = await sendToA("Latest correction"); release.resolve(); await a.runs.idle();
    // Retry can happen minutes later. No sleep is needed to exercise that recovery boundary.
    await t.fixture.db.message.update({ where: { id: first.message.id }, data: { createdAt: new Date(Date.now() - 20_000) } });
    await t.fixture.db.message.update({ where: { id: correction.message.id }, data: { createdAt: new Date(Date.now() - 10_000) } });
    const card = await t.fixture.db.message.findFirstOrThrow({ where: { channelId: c.id, kind: "model_error" } });
    expect(JSON.parse(card.payload).retryOf.skill).toBe("notes");
    llm.script("chat", async (request) => { retryEntered.resolve(); await new Promise<void>((resolve) => request.signal!.addEventListener("abort", () => resolve(), { once: true })); return [text("")]; });
    await a.runs.retry(t.alex.userId, first.runId!, JSON.parse(card.payload).retryOf, null);
    await retryEntered.promise; await a.runs.shutdown();
    const nextLlm = new RoleScriptedLlm(), b = restarted(t.fixture, nextLlm);
    nextLlm.script("chat", (request) => { expect(requestText(request)).toContain("Original request"); expect(requestText(request)).toContain("Latest correction"); return [text("Resumed after retry")]; });
    try {
      expect(await b.runs.recoverStaleRuns()).toBe(1);
      await b.runs.idle();
      expect(nextLlm.sent("chat")).toHaveLength(1);
      for (const id of [first.message.id, correction.message.id]) expect((await t.fixture.db.message.findUniqueOrThrow({ where: { id } })).status).toBe("seen");
    } finally { await b.runs.shutdown(); }
  });

  test("a typed slash skill starts a separate turn instead of being silently injected", async () => {
    const c = await channel(), entered = deferred(), release = deferred();
    t.llm.script("chat", async () => { entered.resolve(); await release.promise; return [text("Original answer")]; }, [text("Skill answer")]);
    const first = await send(c.id, "Original"); await entered.promise;
    try {
      const skill = await send(c.id, "/notes summarize this");
      expect(skill.runId).not.toBe(first.runId);
      const stored = await t.fixture.db.message.findUniqueOrThrow({ where: { id: skill.message.id } });
      expect(JSON.parse(stored.payload).skill).toBe("notes");
      expect(JSON.parse(stored.payload).steeringRunId).toBeUndefined();
    } finally { release.resolve(); await t.fixture.runs.idle(); }
  });
});
