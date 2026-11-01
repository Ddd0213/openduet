// M22 show_tasks (chat and channel turns): the server posts the task overview card (board.ts) the
// way show_card posts a card (input.sink.upsertMessage, kind "card"); the turn carries on. The tool
// result gives the model the real counts so it adds at most one short sentence, never its own
// numbers. Only reads the user's own lists and posts into their own thread, like show_card, so it
// needs no ToolPolicy / Approval.
import { z } from "zod";
import type { ToolProvider, TurnInput } from "../agent/types.ts";
import type { Db } from "../db.ts";
import type { Tool, ToolResultBlock, ToolUseBlock } from "../llm/index.ts";
import { log } from "../log.ts";
import { CardMessage } from "../contract/messages.ts";
import { buildTaskBoard } from "./board.ts";

export const SHOW_TASKS = "show_tasks";

const Args = z.object({
  /** "channel": only this channel's tasks, cards and suggestions; default "all" */
  scope: z.enum(["all", "channel"]).optional(),
}).strict();

const TOOL: Tool = {
  name: SHOW_TASKS,
  description: [
    "Show the user an overview card of their tasks, built by the server from real data: Needs you (what waits on them: questions, approvals, sign-ins, forms), Working, Suggested (Up next) and Done (last 7 days), each with its count and up to 5 rows they can tap.",
    "Call it when they ask how their tasks are going, what's waiting on them, what's left or what OpenDuet is working on. It takes no arguments; scope \"channel\" limits it to this channel when they ask about this channel only.",
    "The card is posted for you. Don't list the tasks or write numbers yourself; add at most one short sentence, using the counts the result gives.",
  ].join(" "),
  inputSchema: z.toJSONSchema(Args, { io: "input" }) as Record<string, unknown>,
};

const NOTE = "The card with these numbers is already in the chat. Add at most one short sentence (e.g. the one thing to do first); don't repeat the list or write other numbers.";

/** Chat turns in the main thread and in channels (not a task's session or a background turn). */
const offered = (input: TurnInput) => (input.kind ?? (input.taskId === null ? "chat" : "task")) === "chat" && input.taskId === null;

type Reply = { result: ToolResultBlock; endTurn: boolean };
const reply = (call: ToolUseBlock, data: unknown, isError = false): Reply => ({
  result: { type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) },
  endTurn: false,
});

export function showTasksProvider(deps: { db: Db; now?: () => Date }): ToolProvider {
  const now = deps.now ?? (() => new Date());
  return {
    name: "needs",
    tools: async (input) => (offered(input) ? [TOOL] : []),
    status: () => "checking",
    async execute(call, input) {
      if (call.name !== SHOW_TASKS || !offered(input)) return reply(call, { error: "Tool is not available" }, true);
      const parsed = Args.safeParse(call.input ?? {});
      if (!parsed.success) return reply(call, { error: "Invalid tool arguments", detail: parsed.error.issues[0]?.message ?? null }, true);
      const user = await deps.db.user.findUnique({ where: { id: input.userId }, select: { language: true, timezone: true } });
      const board = await buildTaskBoard(deps.db, {
        userId: input.userId, channelId: parsed.data.scope === "channel" ? input.channelId : null,
        language: user?.language ?? "en", timezone: user?.timezone ?? "UTC", now: now(),
      });
      const payload = CardMessage.shape.payload.safeParse(board.payload);
      if (!payload.success) {
        log.warn("show_tasks card does not match the contract", { issue: payload.error.issues[0]?.path.join(".") ?? null });
        return reply(call, { error: "The overview couldn't be built. Answer from what you know without numbers." }, true);
      }
      const card = await input.sink.upsertMessage({ role: "assistant", kind: "card", text: "", payload: board.payload });
      return reply(call, { shown: true, messageId: card.id, scope: parsed.data.scope ?? "all", counts: board.counts, note: NOTE });
    },
  };
}
