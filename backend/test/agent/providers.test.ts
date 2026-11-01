// The ToolProvider seam (M3+): provider tools are offered after the built-ins, calls are routed to
// their owner with its status, instructions reach the system prompt, a throwing provider becomes
// an error result, and the run kind picks the model role.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import type { ToolProvider } from "../../src/agent/types.ts";
import { createTestDatabase } from "../helpers/db.ts";
import { RegisteredScriptedModel } from "../helpers/scripted-model.ts";
import { call, now, text, turnFixture } from "./fixtures.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database.cleanup(); });

function provider(overrides: Partial<ToolProvider> = {}): ToolProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "test",
    calls,
    tools: async () => [{ name: "echo_app", description: "Echo", inputSchema: { type: "object", properties: { value: { type: "string" } } } }],
    instructions: async () => ["Connected apps: Gmail."],
    status: () => "searching_email",
    execute: async (use) => {
      calls.push(use.name);
      return { result: { type: "tool_result", toolUseId: use.id, content: [{ type: "text", text: "{\"ok\":true}" }] }, endTurn: false };
    },
    ...overrides,
  };
}

describe("tool providers", () => {
  test("offers, routes and labels provider tools; instructions reach the system prompt", async () => {
    const { input, recording } = await turnFixture(database.db);
    const extra = provider();
    const llm = new RegisteredScriptedModel([[call("echo_app", { value: "x" }, "e1")], [text("done")]]);
    const result = await createAgentRuntime({ db: database.db, llm, config: { DATABASE_URL: database.url }, now, providers: [extra] }).runTurn(input);
    expect(result.status).toBe("completed");
    expect(extra.calls).toEqual(["echo_app"]);
    expect(recording.statuses).toEqual(["thinking", "searching_email", "thinking", null]);
    const names = llm.requests[0]!.tools!.map((tool) => tool.name);
    expect(names.at(-1)).toBe("echo_app");
    // M11: remember moved to the memory provider; search_past_chats is still a built-in.
    expect(names).toContain("search_past_chats");
    expect(llm.requests[0]!.system).toContain("Connected apps: Gmail.");
  });

  test("a provider can't shadow a built-in, and a throwing tool becomes an error result", async () => {
    const { input } = await turnFixture(database.db);
    const extra = provider({
      tools: async () => [
        { name: "search_past_chats", description: "shadow", inputSchema: { type: "object" } },
        { name: "boom", description: "Throws", inputSchema: { type: "object" } },
      ],
      execute: async () => { throw new Error("secret detail"); },
    });
    const llm = new RegisteredScriptedModel([[call("boom", {}, "b1")], [text("sorry")]]);
    const result = await createAgentRuntime({ db: database.db, llm, config: { DATABASE_URL: database.url }, now, providers: [extra] }).runTurn(input);
    expect(result.status).toBe("completed");
    expect(llm.requests[0]!.tools!.filter((tool) => tool.name === "search_past_chats")).toHaveLength(1);
    const toolResult = llm.requests[1]!.messages.at(-1)!.content[0]!;
    expect(toolResult).toMatchObject({ type: "tool_result", toolUseId: "b1", isError: true });
    expect(JSON.stringify(toolResult)).not.toContain("secret detail");
  });

  test("a provider whose tools() fails is skipped, and providers added later are seen", async () => {
    const { input } = await turnFixture(database.db);
    const providers: ToolProvider[] = [provider({ name: "broken", tools: async () => { throw new Error("down"); } })];
    const llm = new RegisteredScriptedModel([[text("hi")]]);
    const runtime = createAgentRuntime({ db: database.db, llm, config: { DATABASE_URL: database.url }, now, providers });
    providers.push(provider({ name: "late", tools: async () => [{ name: "late_tool", description: "Late", inputSchema: { type: "object" } }] }));
    expect((await runtime.runTurn(input)).status).toBe("completed");
    expect(llm.requests[0]!.tools!.map((tool) => tool.name)).toContain("late_tool");
  });

  test("the run kind picks the model role", async () => {
    const { input } = await turnFixture(database.db);
    const llm = new RegisteredScriptedModel([[text("brief")]]);
    llm.models.models.push({ ...llm.models.models[0]!, id: "proactive-model" });
    llm.models.roles.proactive = ["proactive-model"];
    const result = await createAgentRuntime({ db: database.db, llm, config: { DATABASE_URL: database.url }, now }).runTurn({ ...input, kind: "checkin" });
    expect(result.status).toBe("completed");
    expect(llm.requests[0]!.role).toBe("proactive");
  });
});
