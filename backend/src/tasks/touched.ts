// M18: did a task touch the user's things? Decided by the server from its records, never by the
// model: any approval of the task (any status), or a step of one of its runs that called a
// connector tool (Composio app tool, custom MCP tool, call_api) whose access is write or unknown.
// The assistant's own tools (computer_*, make_artifact, web_search, web_fetch, task and memory tools,
// the connector meta tools) don't count. A connector step that can't be classified counts.
import type { Db } from "../db.ts";
import { modelToolName } from "../custom-connectors/provider.ts";
import { API_TOOL } from "../custom-connectors/service.ts";
import { classify } from "../policy/classify.ts";

/** A Composio tool slug as RunStep.tool stores it (upper case, e.g. GMAIL_SEND_EMAIL). */
const COMPOSIO_SLUG = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/;

/** True when the task had an approval or one of its runs ran a write (or unclassifiable) connector tool. */
export async function touchedUserThings(db: Db, userId: string, taskId: string): Promise<boolean> {
  if ((await db.approval.count({ where: { taskId, userId } })) > 0) return true;
  const steps = await db.runStep.findMany({
    where: { kind: "tool", run: { taskId, userId } },
    select: { tool: true, input: true },
  });
  if (!steps.length) return false;
  let mcp: Map<string, "read" | "write"> | null = null;
  for (const step of steps) {
    const tool = step.tool ?? "";
    if (!tool) continue;
    // execute_app_tools without a readable nested call: we can't tell what it ran.
    if (tool === "execute_app_tools") return true;
    if (COMPOSIO_SLUG.test(tool)) {
      if (classify({ slug: tool, toolkit: null }) !== "read") return true;
      continue;
    }
    if (tool === API_TOOL) {
      if (!apiRead(step.input)) return true;
      continue;
    }
    if (tool.startsWith("mcp_")) {
      mcp ??= await mcpAccess(db, userId);
      if (mcp.get(tool) !== "read") return true;
    }
    // Anything else is one of the assistant's own tools.
  }
  return false;
}

/** call_api's stored input: a GET / HEAD is a read; anything else, or an unreadable input, is not. */
function apiRead(input: string | null): boolean {
  if (!input) return false;
  try {
    const value: unknown = JSON.parse(input);
    const method = value && typeof value === "object" ? (value as Record<string, unknown>).method : undefined;
    return typeof method === "string" && /^(GET|HEAD)$/i.test(method);
  } catch {
    return false;
  }
}

/** The user's custom MCP tools by the name the model calls them (mcp_<6>_<tool>) -> stored access. */
async function mcpAccess(db: Db, userId: string): Promise<Map<string, "read" | "write">> {
  const rows = await db.customConnector.findMany({ where: { userId }, select: { id: true, tools: true } });
  const out = new Map<string, "read" | "write">();
  for (const row of rows) {
    let tools: unknown;
    try {
      tools = JSON.parse(row.tools);
    } catch {
      continue;
    }
    if (!Array.isArray(tools)) continue;
    for (const t of tools) {
      if (!t || typeof t !== "object") continue;
      const { name, access } = t as Record<string, unknown>;
      if (typeof name !== "string") continue;
      out.set(modelToolName(row.id, name), access === "read" ? "read" : "write");
    }
  }
  return out;
}
