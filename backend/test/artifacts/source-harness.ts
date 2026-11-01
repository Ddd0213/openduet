// Test-only source provider on the real Make runtime. No production path can select it.
import type { Tool } from "../../src/llm/index.ts";
import { call, type MakeApp } from "../make/harness.ts";

export const sourceRead = (app = "HubSpot") => call("execute_app_tools", { calls: [{ tool: `${app.toUpperCase()}_GET_RECORDS`, arguments: {} }] });

export function installSourceTool(m: MakeApp, app = "HubSpot"): void {
  const provider = m.artifacts.providers[0]!;
  const tools = provider.tools.bind(provider), execute = provider.execute.bind(provider);
  const fake: Tool = { name: "execute_app_tools", description: "Test-only source", inputSchema: { type: "object", properties: { calls: { type: "array" } } } };
  provider.tools = async input => [...await tools(input), ...(input.kind === "build" ? [fake] : [])];
  provider.execute = async (call, input) => call.name !== fake.name ? execute(call, input) : {
    result: { type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: JSON.stringify({ results: [{ index: 0, status: "ok", app, tool: "Get records", data: { open: 15, owners: 1 } }] }) }] }, endTurn: false,
  };
}
