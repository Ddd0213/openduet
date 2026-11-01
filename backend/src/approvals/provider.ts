// The agent's approval tools: update_approval (edit by chat, L67 / L163) and request_payment (L71,
// L108, L158; test mode, nothing is ever charged). instructions() lists the cards in this thread so
// "change it" in chat finds the card and the next turn knows how each one ended.
import { z } from "zod";
import type { ToolProvider, TurnInput } from "../agent/types.ts";
import { markUntrusted } from "../agent/untrusted.ts";
import type { Tool, ToolResultBlock, ToolUseBlock } from "../llm/index.ts";
import { displayName, toolDisplayName } from "../composio/names.ts";
import { checkArgs } from "../connectors/args.ts";
import type { ConnectorCatalog } from "../connectors/catalog.ts";
import { approvalKind } from "../policy/classify.ts";
import { isCurrency } from "./money.ts";
import { buildPreview } from "./preview.ts";
import { summarize } from "./serialize.ts";
import { PAYMENT_TOOL, type ApprovalService } from "./service.ts";

const ARGS_IN_PROMPT_MAX = 4000;

const schemas = {
  update_approval: z.object({
    approvalId: z.string().min(1).max(64),
    /** argument name -> new value; null removes the argument */
    changes: z.record(z.string().min(1).max(100), z.unknown()),
  }).strict(),
  request_payment: z.object({
    amount: z.number().positive().max(1_000_000),
    currency: z.string().trim().length(3).optional(),
    merchant: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000),
    item: z.string().trim().min(1).max(500).optional(),
  }).strict(),
};
type Name = keyof typeof schemas;

const descriptions: Record<Name, string> = {
  update_approval: "Change a pending approval card when the user asks for edits in chat (\"add a line saying...\", \"cc Sam\", \"make it 3pm\"). Give the approvalId and only the arguments that change, with their full new values (null removes one). The card updates in place; the user still approves it.",
  request_payment: "Ask the user to approve a payment (test mode: nothing is charged). amount is in major units (16.49), currency an ISO code (default USD). With an item it shows a Link-style spend request with an order summary; without, a payment card. Returns the approvalId; the payment counts as made only once the user approves.",
};

export interface ApprovalProviderDeps {
  approvals: ApprovalService;
  /** null when Composio isn't configured (then there are no connector cards to edit) */
  catalog: ConnectorCatalog | null;
}

const reply = (call: ToolUseBlock, data: unknown, isError = false): { result: ToolResultBlock; endTurn: boolean } => ({
  result: { type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) },
  endTurn: false,
});

const tool = (name: Name): Tool => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(schemas[name], { io: "input" }) as Record<string, unknown> });

export function approvalProvider(deps: ApprovalProviderDeps): ToolProvider {
  const { approvals, catalog } = deps;

  async function update(input: TurnInput, args: z.infer<typeof schemas.update_approval>) {
    const result = await approvals.edit(input.userId, args.approvalId, async ({ slug, args: stored, approval }) => {
      const merged: Record<string, unknown> = { ...stored };
      for (const [key, value] of Object.entries(args.changes)) {
        if (value === null) delete merged[key]; else merged[key] = value;
      }
      const definition = catalog ? (await catalog.gateway.getTools([slug]).catch(() => []))[0] : undefined;
      if (definition) {
        const problems = checkArgs(definition.inputSchema, merged);
        if (problems.length) return { error: `These changes don't fit the tool: ${problems.join("; ")}` };
      }
      const toolkit = definition?.toolkit || slug.split("_")[0]!.toLowerCase();
      const app = "app" in approval.preview ? approval.preview.app : displayName(toolkit);
      const toolName = approval.preview.kind === "action" ? approval.preview.toolName : toolDisplayName(slug, definition?.name, toolkit);
      return { args: merged, ...buildPreview({ kind: approvalKind({ slug, toolkit, tags: definition?.tags }), app, toolName, args: merged }) };
    });
    if (!result.ok) return { error: result.message, reason: result.reason };
    return {
      status: result.changed ? "updated" : "unchanged",
      approvalId: result.approval.id,
      version: result.approval.version,
      changedFields: result.approval.changedFields,
      note: "The card shows the new version; it still runs only when the user approves it.",
    };
  }

  async function pay(input: TurnInput, args: z.infer<typeof schemas.request_payment>) {
    const currency = (args.currency ?? "USD").toUpperCase();
    if (!isCurrency(currency)) return { error: "Unknown currency; use an ISO code such as USD, EUR, JPY." };
    try {
      const { approval, spendRequestId } = await approvals.createPayment({
        userId: input.userId, channelId: input.channelId, taskId: input.taskId, sink: input.sink,
        amount: args.amount, currency, merchant: args.merchant, description: args.description, item: args.item ?? null,
      });
      return {
        status: "awaiting_approval", approvalId: approval.id, card: spendRequestId ? "spend_request" : "payment",
        testMode: true, expiresAt: approval.expiresAt,
        note: "Test mode: nothing is charged. Don't say it's paid until the user approves the card.",
      };
    } catch (error) {
      if (error instanceof RangeError) return { error: `Invalid amount for ${currency}.` };
      throw error;
    }
  }

  async function instructions(input: TurnInput): Promise<string[]> {
    const items = await approvals.forContext(input.userId, { channelId: input.channelId, taskId: input.taskId });
    const lines = [
      "Approval cards: a write or payment the user hasn't set to Always waits for them to tap Approve / Send or Not now on the card; never ask for approval in text. When the user asks in chat to change a pending card, call update_approval with its id instead of making a new one.",
    ];
    if (!items.length) return lines;
    let detailed = 0;
    const rows = items.map(({ approval, slug, args }) => {
      const status = approval.status === "pending" && approval.result?.ok === false ? "failed (the user can retry or ask for edits)" : approval.status;
      const row: Record<string, unknown> = { approvalId: approval.id, status, version: approval.version, summary: summarize(approval) };
      if (approval.status === "pending" && slug !== PAYMENT_TOOL && detailed < 3) {
        detailed++;
        const text = JSON.stringify(args);
        row.arguments = text.length <= ARGS_IN_PROMPT_MAX ? args : `${text.slice(0, ARGS_IN_PROMPT_MAX)}…`;
      }
      return row;
    });
    lines.push(`Approval cards in this conversation, newest first:\n${markUntrusted(JSON.stringify(rows), "approval card")}`);
    return lines;
  }

  return {
    name: "approvals",
    tools: async () => (catalog ? [tool("update_approval"), tool("request_payment")] : [tool("request_payment")]),
    instructions,
    status: (call) => (call.name === "update_approval" ? "writing_draft" : "checking"),
    async execute(call, input) {
      if (!Object.hasOwn(schemas, call.name) || (call.name === "update_approval" && !catalog)) return reply(call, { error: "Tool is not available" }, true);
      const name = call.name as Name;
      const parsed = schemas[name].safeParse(call.input);
      if (!parsed.success) return reply(call, { error: "Invalid tool arguments", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "input"}: ${i.message}`) }, true);
      const data = name === "update_approval"
        ? await update(input, schemas.update_approval.parse(call.input))
        : await pay(input, schemas.request_payment.parse(call.input));
      return reply(call, data, "error" in data);
    },
  };
}
