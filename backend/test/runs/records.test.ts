// Run records (M8): every run records its steps (text, thinking, tool calls, a failure), redacted
// and capped; GET /api/runs and /api/runs/:id show only the user's own runs; steps of runs older
// than 30 days are pruned; a recorder that can't write never fails the run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import type { ToolProvider } from "../../src/agent/types.ts";
import { RunDetail, RunList } from "../../src/contract/runs.ts";
import { LlmError, type LlmEvent } from "../../src/llm/index.ts";
import { RunHost } from "../../src/runs/host.ts";
import { DETAIL_MAX_CHARS, FILE_READ_MAX_BYTES, REDACTED, STEP_MAX_BYTES } from "../../src/runs/redact.ts";
import { RunRecorder, STEP_RETENTION_MS } from "../../src/runs/steps.ts";
import { createTasks } from "../../src/tasks/index.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse } from "../helpers/sse.ts";
import { call, json, ofType, RoleScriptedLlm, text } from "../tasks/harness.ts";

/** A made-up server secret (stands in for LLM_API_KEY); it must never reach a stored step. */
const SECRET = "test-only-server-secret-0123456789";
const thinking = (value: string): LlmEvent => ({ type: "thinking_delta", text: value });
const BIG = "0123456789ab\n".repeat(1000); // ~13 KB

/** Stand-ins for Claude's computer tools: same names, canned results (the record only sees names, args and results). */
const computer: ToolProvider = {
  name: "fake-computer",
  async tools() {
    return ["computer_exec", "computer_type", "computer_files_write", "computer_files_read", "request_sign_in"].map((name) => ({ name, description: name, inputSchema: { type: "object" } }));
  },
  async execute(toolCall) {
    const data: Record<string, unknown> = {
      computer_exec: { exitCode: 0, stdout: `token=${SECRET}\nAuthorization: Bearer abcdefgh12345678\ndone`, stderr: "", timedOut: false },
      computer_type: { ok: true, url: "https://example.com/login" },
      computer_files_write: { path: "notes/plan.md", written: true },
      computer_files_read: { path: "notes/big.txt", text: BIG, truncated: false },
      request_sign_in: { status: "card_shown" },
    };
    return { result: { type: "tool_result", toolUseId: toolCall.id, content: [{ type: "text", text: JSON.stringify(data[toolCall.name] ?? {}) }] }, endTurn: false };
  },
};

let fixture: TestApp;
let llm: RoleScriptedLlm;
let alex: SignedIn;
let sam: SignedIn;

beforeAll(async () => {
  llm = new RoleScriptedLlm();
  fixture = await createTestApp({}, {
    heartbeatMs: 1000,
    setup: (core) => {
      const providers: ToolProvider[] = [computer];
      const agent = createAgentRuntime({ db: core.db, llm, config: core.config, providers });
      const recorder = new RunRecorder({ db: core.db, secrets: [SECRET] });
      const runs = new RunHost({ db: core.db, events: core.events, usage: core.usage, files: core.files, agent, recorder });
      const tasks = createTasks({ db: core.db, events: core.events, runs });
      providers.push(...tasks.providers);
      return { agent, runs, routes: tasks.routes };
    },
  });
  alex = await signUp(fixture, "alex");
  sam = await signUp(fixture, "sam", "Sam Lee");
});
afterAll(() => fixture.cleanup());

const get = (user: SignedIn, path: string) => fixture.app.request(path, { headers: user.headers });
const send = (user: SignedIn, body: string, clientId: string) =>
  fixture.app.request(`/api/channels/${user.mainChannelId}/messages`, json(user, "POST", { text: body, clientId }));

async function runOf(frames: Awaited<ReturnType<typeof readSse>>): Promise<string> {
  const done = ofType(frames, "done").at(-1);
  if (!done) throw new Error("no done event");
  return done.payload.runId;
}

async function detailOf(user: SignedIn, runId: string) {
  const res = await get(user, `/api/runs/${runId}`);
  expect(res.status).toBe(200);
  return RunDetail.parse(await res.json());
}

describe("recording", () => {
  test("thinking, text and every tool call become steps in order, redacted and capped", async () => {
    llm.script("chat",
      [
        thinking("Let me check the files first."),
        text("Looking now."),
        call("computer_exec", { command: `curl -H "Authorization: Bearer abcdefgh12345678" https://api.example.com/?token=${SECRET}` }),
        call("computer_type", { ref: "e12", text: "hunter2-password", submit: true }),
        call("computer_files_write", { path: "notes/plan.md", contents: "secret plans for Q3" }),
        call("computer_files_read", { path: "notes/big.txt" }),
        call("request_sign_in", { domain: "example.com", email: "alex@example.com", password: "pw-123456789" }),
      ],
      [text("All done.")],
    );
    const runId = await runOf(await readSse(await send(alex, "  Check   my notes\nplease  ", "rec-1")));
    const d = await detailOf(alex, runId);
    expect(d).toMatchObject({ kind: "chat", status: "completed", channelId: alex.mainChannelId, taskId: null, title: { text: "Check my notes please" }, stepCount: 8 });
    expect(d.steps.map((s) => [s.index, s.kind, s.tool, s.title.key, s.status])).toEqual([
      [0, "thinking", null, "run.step.thinking", "ok"],
      [1, "text", null, "run.step.text", "ok"],
      [2, "tool", "computer_exec", "run.step.exec", "ok"],
      [3, "tool", "computer_type", "run.step.browse", "ok"],
      [4, "tool", "computer_files_write", "run.step.files_write", "ok"],
      [5, "tool", "computer_files_read", "run.step.files_read", "ok"],
      [6, "tool", "request_sign_in", "run.step.browse", "ok"],
      [7, "text", null, "run.step.text", "ok"],
    ]);
    expect(d.steps.every((s) => s.finishedAt !== null)).toBe(true);
    expect(d.latest).toEqual({ title: { key: "run.step.text" }, detail: "All done." });
    const [think, said, exec, typed, wrote, read, signIn] = d.steps;
    expect(think).toMatchObject({ input: "Let me check the files first.", detail: "Let me check the files first." });
    expect(said).toMatchObject({ input: "Looking now.", detail: "Looking now." });

    // exec: the command is the grey line; the Authorization header and the server's key are gone.
    expect(exec!.app).toBe("OpenDuet's computer");
    expect(exec!.detail.length).toBeLessThanOrEqual(DETAIL_MAX_CHARS);
    expect(exec!.input).toContain(`Authorization: ${REDACTED}`);
    expect(exec!.input).toContain(`token=${REDACTED}`);
    expect(exec!.output).toBe(`exit 0\n\ntoken=${REDACTED}\nAuthorization: ${REDACTED}\ndone`);
    // computer_type: the field ref only; files_write: path + size; sign-in: the domain only.
    expect(typed).toMatchObject({ detail: "e12" });
    expect(JSON.parse(typed!.input!)).toEqual({ ref: "e12", submit: true });
    expect(JSON.parse(wrote!.input!)).toEqual({ path: "notes/plan.md", bytes: 19 });
    expect(JSON.parse(signIn!.input!)).toEqual({ domain: "example.com" });
    // files_read output is capped to 2 KB; every body to 8 KB.
    expect(new TextEncoder().encode(read!.output!).byteLength).toBeLessThanOrEqual(FILE_READ_MAX_BYTES);
    expect(read!.output!.endsWith("…")).toBe(true);
    for (const s of d.steps) for (const body of [s.input, s.output]) if (body) expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(STEP_MAX_BYTES);

    // Nothing secret was ever written, in any column.
    const stored = JSON.stringify(await fixture.db.runStep.findMany({ where: { runId } }));
    for (const leak of [SECRET, "abcdefgh12345678", "hunter2", "pw-123456789", "alex@example.com", "secret plans"]) expect(stored).not.toContain(leak);

    const list = RunList.parse(await (await get(alex, `/api/runs?channelId=${alex.mainChannelId}`)).json());
    expect(list.runs[0]).toMatchObject({ id: runId, stepCount: 8, latest: { title: { key: "run.step.text" }, detail: "All done." } });
  });

  test("a failed run ends with an error step in the user's language", async () => {
    await fixture.db.user.update({ where: { id: alex.userId }, data: { language: "zh-Hans" } });
    try {
      llm.script("chat", new LlmError({ kind: "http", status: 502, providerId: "scripted-test-only", modelId: "scripted-test-only", attempts: 3 }));
      const runId = await runOf(await readSse(await send(alex, "Hello?", "rec-2")));
      const d = await detailOf(alex, runId);
      expect(d.status).toBe("failed");
      expect(d.error).toMatchObject({ key: "system.model_error" });
      const last = d.steps.at(-1)!;
      expect(last).toMatchObject({ kind: "error", title: { key: "run.step.error" }, status: "error", tool: null });
      expect(last.detail).toContain("连不上模型");
      expect(last.detail).toContain("502");
    } finally {
      await fixture.db.user.update({ where: { id: alex.userId }, data: { language: "en" } });
    }
  });

  test("a decided approval updates the step that posted its card (approved, failed, declined)", async () => {
    const run = await fixture.db.run.create({ data: { userId: alex.userId, kind: "chat", channelId: alex.mainChannelId, status: "completed" } });
    const recorder = new RunRecorder({ db: fixture.db, secrets: [SECRET] });
    const ids = ["ap-ok", "ap-fail", "ap-no"];
    for (const [index, approvalId] of ids.entries()) {
      await fixture.db.runStep.create({ data: { id: `${run.id}-${index}`, runId: run.id, index, kind: "tool", tool: "computer_exec", app: "Claude's computer", title: JSON.stringify({ key: "run.step.exec" }), status: "awaiting_approval", approvalId } });
    }
    await recorder.approvalDecided({ approvalId: "ap-ok", status: "approved", ok: true, slug: "computer_exec", output: { exitCode: 0, stdout: `key ${SECRET}`, stderr: "", timedOut: false } });
    await recorder.approvalDecided({ approvalId: "ap-fail", status: "approved", ok: false, output: "Couldn't reach Claude's computer." });
    await recorder.approvalDecided({ approvalId: "ap-no", status: "declined", ok: false });
    const d = await detailOf(alex, run.id);
    expect(d.steps.map((s) => [s.approvalId, s.status])).toEqual([["ap-ok", "ok"], ["ap-fail", "error"], ["ap-no", "denied"]]);
    expect(d.steps[0]!.output).toBe(`exit 0\n\nkey ${REDACTED}`);
    expect(d.steps[1]!.output).toBe("Couldn't reach Claude's computer.");
    expect(d.steps[2]!.output).toBeNull();
    expect(d.steps.every((s) => s.finishedAt !== null)).toBe(true);
  });

  test("M27: an approved computer_exec with non-zero exit stays ok and shows exit N in its detail", async () => {
    const run = await fixture.db.run.create({ data: { userId: alex.userId, kind: "chat", channelId: alex.mainChannelId, status: "completed" } });
    const recorder = new RunRecorder({ db: fixture.db, secrets: [SECRET] });
    const steps = recorder.open(run.id, alex.userId);
    const id = "ap-exit-7";
    const handle = steps.toolStart({ type: "tool_use", id: "exec-7", name: "computer_exec", input: { command: "python report.py" } });
    steps.toolEnd(handle, { type: "tool_result", toolUseId: "exec-7", content: [{ type: "text", text: JSON.stringify({ status: "awaiting_approval", approvalId: id }) }] });
    await steps.finish();
    expect((await detailOf(alex, run.id)).steps[0]).toMatchObject({ status: "awaiting_approval", detail: "python report.py", finishedAt: null });

    await recorder.approvalDecided({ approvalId: id, status: "approved", ok: true, slug: "computer_exec", output: { exitCode: 7, stdout: "", stderr: `token=${SECRET}`, timedOut: false } });
    const detail = await detailOf(alex, run.id);
    expect(detail.steps[0]).toMatchObject({ status: "ok", detail: "exit 7", output: `exit 7\n\nstderr:\ntoken=${REDACTED}` });
    expect(detail.steps[0]!.finishedAt).not.toBeNull();
    expect(detail.latest).toEqual({ title: { key: "run.step.exec" }, detail: "exit 7" });
    expect(JSON.stringify(await fixture.db.runStep.findMany({ where: { runId: run.id } }))).not.toContain(SECRET);
  });

  test("M27: a live computer_exec non-zero exit overrides the command detail but stays ok", async () => {
    const run = await fixture.db.run.create({ data: { userId: alex.userId, kind: "chat", channelId: alex.mainChannelId, status: "completed" } });
    const steps = new RunRecorder({ db: fixture.db }).open(run.id, alex.userId);
    const handle = steps.toolStart({ type: "tool_use", id: "exec-3", name: "computer_exec", input: { command: "python report.py" } });
    steps.toolEnd(handle, { type: "tool_result", toolUseId: "exec-3", content: [{ type: "text", text: JSON.stringify({ exitCode: 3, stdout: "", stderr: "missing input", timedOut: false }) }] });
    await steps.finish();
    expect((await detailOf(alex, run.id)).steps[0]).toMatchObject({ status: "ok", detail: "exit 3 · python report.py" });
  });
});

describe("routes", () => {
  test("only the user's own runs: someone else's run, task or channel is 404; signed out is 401", async () => {
    const theirs = await fixture.db.run.findFirstOrThrow({ where: { userId: alex.userId } });
    expect((await get(sam, `/api/runs/${theirs.id}`)).status).toBe(404);
    expect((await get(sam, "/api/runs/no-such-run")).status).toBe(404);
    expect((await get(sam, `/api/runs?channelId=${alex.mainChannelId}`)).status).toBe(404);
    const task = await fixture.db.task.create({ data: { userId: alex.userId, channelId: alex.mainChannelId, title: "Alex's task", prompt: "x" } });
    expect((await get(sam, `/api/runs?taskId=${task.id}`)).status).toBe(404);
    const mine = RunList.parse(await (await get(sam, "/api/runs")).json());
    expect(mine.runs.every((r) => r.channelId === sam.mainChannelId || r.channelId === null)).toBe(true);
    expect(mine.runs.some((r) => r.id === theirs.id)).toBe(false);
    expect((await fixture.app.request("/api/runs")).status).toBe(401);
    expect((await fixture.app.request(`/api/runs/${theirs.id}`)).status).toBe(401);
  });

  test("newest first, paged with before + limit; taskId and channelId filters; bad queries are 400", async () => {
    const kim = await signUp(fixture, "kim", "Kim Park");
    const task = await fixture.db.task.create({ data: { userId: kim.userId, channelId: kim.mainChannelId, title: "Book the venue", prompt: "Book it" } });
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 26, 8, minutes));
    const make = (minutes: number, data: { kind: string; taskId?: string; title?: string }) => fixture.db.run.create({ data: {
      userId: kim.userId, channelId: kim.mainChannelId, taskId: data.taskId ?? null, kind: data.kind, status: "completed", createdAt: at(minutes),
      title: data.title ?? null,
    } });
    const chat1 = await make(1, { kind: "chat", title: JSON.stringify({ text: "First question" }) });
    const task1 = await make(2, { kind: "task", taskId: task.id });
    const brief = await make(3, { kind: "brief" });
    const task2 = await make(4, { kind: "task", taskId: task.id, title: JSON.stringify({ text: "An old title" }) });

    const all = RunList.parse(await (await get(kim, "/api/runs")).json());
    expect(all.runs.map((r) => r.id)).toEqual([task2.id, brief.id, task1.id, chat1.id]);
    expect(all.hasMore).toBe(false);
    // Task runs show the task's current title; others their own (or run.title.<kind>).
    expect(all.runs.map((r) => r.title)).toEqual([{ text: "Book the venue" }, { key: "run.title.brief" }, { text: "Book the venue" }, { text: "First question" }]);

    const page1 = RunList.parse(await (await get(kim, "/api/runs?limit=2")).json());
    expect([page1.runs.map((r) => r.id), page1.hasMore]).toEqual([[task2.id, brief.id], true]);
    const page2 = RunList.parse(await (await get(kim, `/api/runs?limit=2&before=${brief.id}`)).json());
    expect([page2.runs.map((r) => r.id), page2.hasMore]).toEqual([[task1.id, chat1.id], false]);

    const ofTask = RunList.parse(await (await get(kim, `/api/runs?taskId=${task.id}`)).json());
    expect(ofTask.runs.map((r) => r.id)).toEqual([task2.id, task1.id]);
    // A channel's own runs: its chat and proactive runs; task runs are listed under their task.
    const ofChannel = RunList.parse(await (await get(kim, `/api/runs?channelId=${kim.mainChannelId}`)).json());
    expect(ofChannel.runs.map((r) => r.id)).toEqual([brief.id, chat1.id]);

    for (const [query, field] of [["limit=0", "limit"], ["limit=101", "limit"], ["limit=abc", "limit"], ["before=no-such-run", "before"]] as const) {
      const res = await get(kim, `/api/runs?${query}`);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatchObject({ code: "validation_failed", field });
    }
    // Someone else's run is no cursor either.
    const alexRun = await fixture.db.run.findFirstOrThrow({ where: { userId: alex.userId } });
    expect((await get(kim, `/api/runs?before=${alexRun.id}`)).status).toBe(400);
  });
});

describe("retention", () => {
  test("steps of runs older than 30 days are deleted (the runs stay); newer ones are kept", async () => {
    const now = new Date(Date.UTC(2026, 9, 26, 12));
    const old = await fixture.db.run.create({ data: { userId: sam.userId, kind: "chat", channelId: sam.mainChannelId, status: "completed", createdAt: new Date(now.getTime() - STEP_RETENTION_MS - 60_000) } });
    const fresh = await fixture.db.run.create({ data: { userId: sam.userId, kind: "chat", channelId: sam.mainChannelId, status: "completed", createdAt: new Date(now.getTime() - STEP_RETENTION_MS + 60_000) } });
    for (const run of [old, fresh]) {
      await fixture.db.runStep.create({ data: { id: `${run.id}-step`, runId: run.id, index: 0, kind: "text", title: JSON.stringify({ key: "run.step.text" }), status: "ok", input: "hi" } });
    }
    const recorder = new RunRecorder({ db: fixture.db, now: () => now });
    expect(await recorder.prune()).toBe(1);
    expect(await fixture.db.runStep.count({ where: { runId: old.id } })).toBe(0);
    expect(await fixture.db.runStep.count({ where: { runId: fresh.id } })).toBe(1);
    expect(await fixture.db.run.count({ where: { id: { in: [old.id, fresh.id] } } })).toBe(2);
    // The pruned run still reads, with no steps.
    expect(await detailOf(sam, old.id)).toMatchObject({ stepCount: 0, latest: null, steps: [] });
  });
});

describe("a recorder that can't write", () => {
  test("never fails or changes the run", async () => {
    // Every runStep call throws (a broken table, a full disk); everything else works.
    const broken = new Proxy(fixture.db, {
      get(target, prop, receiver) {
        if (prop === "runStep") throw new Error("runStep is unavailable");
        return Reflect.get(target, prop, receiver);
      },
    });
    const brokenLlm = new RoleScriptedLlm();
    const providers: ToolProvider[] = [computer];
    const agent = createAgentRuntime({ db: fixture.db, llm: brokenLlm, config: fixture.config, providers });
    const runs = new RunHost({ db: fixture.db, events: fixture.events, usage: fixture.usage, files: fixture.files, agent, recorder: new RunRecorder({ db: broken }) });
    brokenLlm.script("chat", [thinking("Hmm."), text("Running it."), call("computer_exec", { command: "ls" })], [text("Here you go.")]);
    const runId = await runs.submit({ userId: sam.userId, channelId: sam.mainChannelId, taskId: null, kind: "chat", prompt: "List the files" });
    expect(runId).not.toBeNull();
    await runs.idle();
    const run = await fixture.db.run.findUniqueOrThrow({ where: { id: runId! } });
    expect(run.status).toBe("completed");
    expect(run.error).toBeNull();
    expect(brokenLlm.sent("chat")).toHaveLength(2);
    expect(await fixture.db.runStep.count({ where: { runId: runId! } })).toBe(0);
    const replies = await fixture.db.message.findMany({ where: { userId: sam.userId, role: "assistant", text: { in: ["Running it.", "Here you go."] } } });
    expect(replies).toHaveLength(2);
    await runs.shutdown();
  });
});
