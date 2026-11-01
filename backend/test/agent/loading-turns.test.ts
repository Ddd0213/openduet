// M29 tools on demand across turns (agent/loading.ts, runs/tool-history.ts), wired like index.ts:
// a connector's tools wait under "More tools"; the ones a thread's history window used or loaded
// start the next turn loaded (that thread only); a message naming a connector starts with the
// user's most-used tools from it (none without history: nothing is guessed).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LOAD_TOOLS } from "../../src/agent/loading.ts";
import { CustomConnectorResponse } from "../../src/contract/m11.ts";
import { modelToolName } from "../../src/custom-connectors/provider.ts";
import { call, chatIn, FakeMcp, json, newChannel, startChannels, text, toolNames, type ChannelApp } from "../channels/harness.ts";

let m: ChannelApp;
const mcp = new FakeMcp();
let id = "";
const tool = (name: string) => modelToolName(id, name);
const mcpNames = (names: string[]) => names.filter((n) => n.startsWith("mcp_"));

beforeAll(async () => {
  m = await startChannels();
  mcp.tools = ["search", "fetch", "list", "comment"].map((name) => ({ name, description: `${name} the team wiki. Details.`, annotations: { readOnlyHint: true } }));
  m.net.route("wiki.example.com", mcp.handler);
  const res = await m.fixture.app.request("/api/custom-connectors", json(m.alex, "POST", { kind: "mcp", name: "Wiki", url: "https://wiki.example.com/mcp", headers: [] }));
  id = CustomConnectorResponse.parse(await res.json()).connector.id;
});
afterAll(() => m.cleanup());

/** One chat turn in a channel; the requests it sent. */
async function turnIn(channelId: string, message: string, ...script: Parameters<ChannelApp["llm"]["script"]>[1][]) {
  m.llm.script("chat", ...script);
  const before = m.llm.sent("chat").length;
  await chatIn(m, m.alex, channelId, message);
  await m.runs.idle();
  return m.llm.sent("chat").slice(before);
}

describe("across turns", () => {
  test("no history: naming the connector loads nothing; its tools are in the index", async () => {
    const channel = await newChannel(m, m.alex, { name: "Fresh" });
    const [first] = await turnIn(channel.id, "what's on the wiki?", [text("Let me look.")]);
    expect(mcpNames(toolNames(first))).toEqual([]);
    expect(toolNames(first)).toContain(LOAD_TOOLS);
    for (const name of ["search", "fetch", "list", "comment"]) expect(first!.system).toContain(`\n- ${tool(name)}: ${name} the team wiki.`);
    expect(first!.system).toContain("Wiki (connector):");
    expect(first!.system).not.toContain("Already loaded for this turn");
  });

  test("what a thread used or loaded starts its next turn loaded (that thread only)", async () => {
    const channel = await newChannel(m, m.alex, { name: "Research" });
    const one = await turnIn(channel.id, "find the roadmap",
      [call(tool("search"), { query: "roadmap" })],
      [call(LOAD_TOOLS, { tools: [tool("fetch")] })],
      [text("Found the roadmap.")],
    );
    expect(mcpNames(toolNames(one[1]))).toEqual([tool("search")]);
    expect(mcpNames(toolNames(one[2]))).toEqual([tool("search"), tool("fetch")]);

    const [next] = await turnIn(channel.id, "open it", [text("Opening.")]);
    // Newest first: fetch was loaded after search ran.
    expect(mcpNames(toolNames(next))).toEqual([tool("fetch"), tool("search")]);
    expect(next!.system).toContain(`Already loaded for this turn, call them directly: ${tool("fetch")}, ${tool("search")}.`);
    expect(next!.system).not.toContain(`\n- ${tool("search")}:`);
    expect(next!.system).toContain(`\n- ${tool("list")}:`);
    // The digest of the earlier turn names the connector call, never load_tools.
    expect(JSON.stringify(next!.messages)).not.toContain(LOAD_TOOLS);

    const other = await newChannel(m, m.alex, { name: "Elsewhere" });
    const [elsewhere] = await turnIn(other.id, "hello", [text("Hi.")]);
    expect(mcpNames(toolNames(elsewhere))).toEqual([]);
  });

  test("a message naming the connector starts with the user's most-used tools from it (most calls first)", async () => {
    const busy = await newChannel(m, m.alex, { name: "Busy" });
    await turnIn(busy.id, "comment twice and list",
      [call(tool("comment"), {})],
      [call(tool("comment"), {})],
      [call(tool("list"), {})],
      [text("Done.")],
    );
    const fresh = await newChannel(m, m.alex, { name: "Later" });
    const [named] = await turnIn(fresh.id, "anything new in the Wiki today?", [text("Checking.")]);
    // comment 2 calls; search and list 1 each (the connector's order); fetch was loaded, never called.
    expect(mcpNames(toolNames(named))).toEqual([tool("comment"), tool("search"), tool("list")]);
    expect(named!.system).toContain(`\n- ${tool("fetch")}:`);

    const quiet = await newChannel(m, m.alex, { name: "Quiet" });
    const [plain] = await turnIn(quiet.id, "how's the weather?", [text("Sunny.")]);
    expect(mcpNames(toolNames(plain))).toEqual([]);
  });
});
