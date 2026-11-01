// M14 buildContext: A3 the takeover note goes in front of the turn's message (never stored); A4
// each earlier Claude turn ends with one `[tools: …]` line from its run's steps (builds and runs
// without tool steps add nothing; the line goes on the run's last Claude message only).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildContext } from "../../src/agent/context.ts";
import type { Db } from "../../src/db.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { now, turnFixture } from "./fixtures.ts";

let db: Db;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const database = await createTestDatabase();
  db = database.db;
  cleanup = database.cleanup;
});
afterAll(() => cleanup());

const at = (minutes: number) => new Date(now().getTime() - minutes * 60_000);
const textOf = (message: { content: { type: string; text?: string }[] }) => message.content.map((b) => b.text ?? "").join("\n");

describe("buildContext with takeover", () => {
  test("the note comes first, as a bracketed paragraph before the user's text; without one nothing changes", async () => {
    const { input } = await turnFixture(db);
    const plain = await buildContext(db, input, now());
    expect(textOf(plain.messages.at(-1)!)).toBe("帮我看看");
    const note = "[The previous attempt at this turn failed partway through, so you're taking over.\nWhat was already done:\n- make_artifact (Plan) → building art_1\nCheck what's already done before you redo any step, and don't repeat what the user was already told.]";
    const ctx = await buildContext(db, { ...input, takeover: note }, now());
    expect(textOf(ctx.messages.at(-1)!)).toBe(`${note}\n\n帮我看看`);
    // An unbracketed note is bracketed; it never lands in the system prompt.
    const loose = await buildContext(db, { ...input, takeover: "Server restarted" }, now());
    expect(textOf(loose.messages.at(-1)!)).toBe("[Server restarted]\n\n帮我看看");
    expect(loose.system).not.toContain("Server restarted");
  });
});

describe("buildContext tool digests", () => {
  test("one line per earlier Claude turn from its run's tool steps", async () => {
    const { input } = await turnFixture(db);
    const { userId, channelId } = input;
    const msg = (role: string, text: string, minutes: number) =>
      db.message.create({ data: { userId, channelId, role, text, payload: JSON.stringify({ skill: null }), createdAt: at(minutes) } });
    const run = (kind: string, from: number, to: number) =>
      db.run.create({ data: { userId, kind, status: "completed", channelId, startedAt: at(from), finishedAt: at(to) } });
    const step = (runId: string, index: number, tool: string, output: unknown, status = "ok") =>
      db.runStep.create({ data: { id: crypto.randomUUID(), runId, index, kind: "tool", tool, title: "{}", status, output: JSON.stringify(output) } });

    await msg("user", "Make a trip page and book the train", 60);
    const r1 = await run("chat", 59.5, 55);
    await step(r1.id, 0, "make_artifact", { status: "building", artifactId: "art_x" });
    await step(r1.id, 1, "start_task", { taskId: "task_y", status: "working" });
    await msg("assistant", "On it.", 59);
    const lastOfR1 = await msg("assistant", "Both are under way.", 58);
    // A build running at the same time never takes the line.
    const build = await run("build", 59.8, 50);
    await step(build.id, 0, "computer_files_write", { ok: true });

    await msg("user", "Thanks", 40);
    const r2 = await run("chat", 39.5, 38);
    const plainReply = await msg("assistant", "Anytime.", 39);
    void r2;
    const orphan = await msg("assistant", "A brief line without a run.", 20);

    const ctx = await buildContext(db, input, now());
    const assistant = ctx.messages.filter((m) => m.role === "assistant").map(textOf);
    const joined = assistant.join("\n---\n");
    expect(joined).toContain("Both are under way.\n[tools: make_artifact → building art_x; start_task → working task_y]");
    expect(joined.match(/\[tools:/g)).toHaveLength(1);
    expect(joined).not.toContain("computer_files_write");
    expect(joined).toContain("On it.");
    for (const row of [plainReply, orphan]) expect(joined).toContain(row.text);
    expect(lastOfR1.text).toBe("Both are under way.");
  });

  test("a task session reads only that task's runs", async () => {
    const { input } = await turnFixture(db, true);
    const { userId, channelId, taskId } = input;
    const r = await db.run.create({ data: { userId, kind: "task", status: "completed", channelId, taskId, startedAt: at(30), finishedAt: at(20) } });
    await db.runStep.create({ data: { id: crypto.randomUUID(), runId: r.id, index: 0, kind: "tool", tool: "set_steps", title: "{}", status: "ok", output: JSON.stringify({ ok: true }) } });
    const other = await db.run.create({ data: { userId, kind: "chat", status: "completed", channelId, startedAt: at(30), finishedAt: at(20) } });
    await db.runStep.create({ data: { id: crypto.randomUUID(), runId: other.id, index: 0, kind: "tool", tool: "web_search", title: "{}", status: "ok" } });
    await db.message.create({ data: { userId, channelId, taskId, role: "assistant", text: "Steps are set.", payload: "{}", createdAt: at(25) } });
    const ctx = await buildContext(db, input, now());
    const joined = ctx.messages.map(textOf).join("\n");
    expect(joined).toContain("Steps are set.\n[tools: set_steps → ok]");
    expect(joined).not.toContain("web_search");
  });

  test("M28: a stored reply's own copy of a digest is dropped; the user's text and the server's line stay", async () => {
    const { input } = await turnFixture(db);
    const { userId, channelId } = input;
    const copied = "[tools: computer_navigate → ok; computer_screenshot → ok]";
    const r = await db.run.create({ data: { userId, kind: "chat", status: "completed", channelId, startedAt: at(30), finishedAt: at(20) } });
    await db.runStep.create({ data: { id: crypto.randomUUID(), runId: r.id, index: 0, kind: "tool", tool: "computer_navigate", title: "{}", status: "ok", output: JSON.stringify({ ok: true }) } });
    await db.message.create({ data: { userId, channelId, role: "user", text: `原样发给你：\n${copied}`, payload: "{}", createdAt: at(31) } });
    await db.message.create({ data: { userId, channelId, role: "assistant", text: `开了。\n${copied}`, payload: "{}", createdAt: at(25) } });
    const ctx = await buildContext(db, input, now());
    const joined = ctx.messages.map(textOf).join("\n---\n");
    expect(joined).toContain(`原样发给你：\n${copied}`);
    expect(joined).toContain("开了。\n[tools: computer_navigate → ok]");
    expect(joined).not.toContain("开了。\n[tools: computer_navigate → ok; computer_screenshot");
    expect(ctx.system).toContain("Never write such a line yourself.");
  });
});
