// Reactions (M6 backend B, L157): the routes and the assistant's react tool.
//
// index.ts wiring (owned by the main agent):
//   const reactions = createReactions({ db, events });
//   providers.push(...reactions.providers);  routes: [...reactions.routes]
import { z } from "zod";
import type { ToolProvider } from "../agent/types.ts";
import type { RegisterRoutes } from "../app.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import type { Tool, ToolResultBlock, ToolUseBlock } from "../llm/index.ts";
import { registerReactionRoutes } from "../routes/reactions.ts";
import { Emoji, ReactionService } from "./service.ts";

export { ReactionService } from "./service.ts";

/** messageId: optional; the default is the user's message this turn answers. */
const ReactArgs = z.object({
  emoji: Emoji,
  messageId: z.string().min(1).max(64).optional(),
  final: z.boolean().optional().describe("true when this emoji is your whole reply: the turn ends here with no text"),
}).strict();

/** M14b (Codync chat/outbox.rs): when a person would react, and that a reaction can be the whole reply. */
const REACT: Tool = {
  name: "react",
  description: "Put one emoji on the user's message this turn answers, shown as a small badge on their bubble. Reactions are rare: only where a person would (❤️ to thanks, 👍 to a plain OK, 🎉 to big news, 😂 to a real joke), never on a question, a request, an error, a payment or a deletion. For a plain OK, thanks or 'got it' that needs no words, set final: true: the reaction is your whole reply and ends the turn here; do not write an acknowledgement or a parenthetical stage direction. When it needs neither words nor a reaction, end your turn by replying exactly \"(pass)\". It never replaces a reply when one is needed.",
  inputSchema: z.toJSONSchema(ReactArgs, { io: "input" }) as Record<string, unknown>,
};

const SPACING_NOTE = "You reacted in this chat a moment ago and reactions stay rare: no reaction this time. If the message needs no words, end your turn by replying exactly \"(pass)\"; don't tell the user about this.";

const reply = (call: ToolUseBlock, data: unknown, isError = false, endTurn = false): { result: ToolResultBlock; endTurn: boolean } => ({
  result: { type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) },
  endTurn,
});

/** Turns that answer a stored user message (chat, a reply in a task's session). */
const answersUser = (input: Parameters<ToolProvider["tools"]>[0]) => input.kind !== "build" && !input.userMessage.id.startsWith("turn_");

export function reactProvider(reactions: ReactionService): ToolProvider {
  return {
    name: "reactions",
    tools: async (input) => (answersUser(input) ? [REACT] : []),
    status: () => "working",
    async execute(call, input) {
      if (call.name !== "react" || input.kind === "build") return reply(call, { error: "Tool is not available" }, true);
      const parsed = ReactArgs.safeParse(call.input);
      if (!parsed.success) return reply(call, { error: "Invalid tool arguments", issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "input"}: ${i.message}`) }, true);
      const target = parsed.data.messageId ?? input.userMessage.id;
      const outcome = await reactions.assistant(input.userId, input.channelId, target, parsed.data.emoji);
      if (outcome.status === "not_allowed") return reply(call, { error: "You can only react to the user's messages in this conversation." }, true);
      // Not an error: the turn goes on, and the model is told how to end it (Codync's wording).
      if (outcome.status === "too_soon") return reply(call, { status: "not_reacted", note: SPACING_NOTE });
      return reply(call, { status: "reacted", messageId: outcome.message.id, emoji: parsed.data.emoji }, false, parsed.data.final === true);
    },
  };
}

export interface Reactions { service: ReactionService; providers: ToolProvider[]; routes: RegisterRoutes[] }

export function createReactions(deps: { db: Db; events: EventBus }): Reactions {
  const service = new ReactionService(deps);
  return { service, providers: [reactProvider(service)], routes: [registerReactionRoutes(service)] };
}
