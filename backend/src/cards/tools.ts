// The tools behind the cards the assistant writes (M9, contract §2): ask_form posts a native question card
// and ends the turn (in a task the task then waits for the user: needs_input), show_card posts an
// information card and the turn carries on. The input schemas are flat (no oneOf) so every gateway
// accepts them; the rules per field / block type are checked here and a bad call gets an error the
// model can fix, never a malformed card.
import { z } from "zod";
import type { ToolProvider, TurnInput } from "../agent/types.ts";
import { CardIcon, CardTint, type StatusKey } from "../contract/common.ts";
import { CardMessage, ConnectionRequestMessage, FormMessage } from "../contract/messages.ts";
import { LineChartBlock } from "../contract/m24.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import type { ToolResultBlock, ToolUseBlock } from "../llm/index.ts";
import type { TaskService } from "../tasks/service.ts";
import { emitStored, storedPayload } from "../tasks/thread.ts";

const label = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

const FormOptionInput = z.object({ label: label(120), detail: optionalText(200) }).strict();
const FormFieldInput = z.object({
  type: z.enum(["single", "multi", "text"]),
  label: label(300),
  /** default: true for single / multi, false for text */
  required: z.boolean().optional(),
  /** single / multi: 2-8 (single) or 2-10 (multi) choices */
  options: z.array(FormOptionInput).max(10).optional(),
  /** single / multi: add an "Other" chip with a text field */
  allowOther: z.boolean().optional(),
  /** text only */
  placeholder: optionalText(120),
  multiline: z.boolean().optional(),
}).strict();

const RowInput = z.object({ title: label(160), detail: optionalText(300), value: optionalText(60), icon: CardIcon.optional() }).strict();
const MetricInput = z.object({ label: label(60), value: label(40), delta: optionalText(20), trend: z.enum(["up", "down", "flat"]).optional() }).strict();
const BlockInput = z.object({
  type: z.enum(["text", "rows", "metrics", "progress", "checklist", "bars", "line_chart"]),
  /** text */
  text: optionalText(2000),
  /** rows: 1-12 */
  rows: z.array(RowInput).max(12).optional(),
  /** metrics: 1-6 */
  metrics: z.array(MetricInput).max(6).optional(),
  /** progress: label, value 0..1, detail */
  label: optionalText(120),
  value: z.number().min(0).max(1).optional(),
  detail: optionalText(120),
  /** checklist: 1-12 */
  checklist: z.array(z.object({ text: label(200), done: z.boolean() }).strict()).max(12).optional(),
  /** checklist only: let the user tick items; ids are assigned by the server */
  checkable: z.boolean().optional(),
  /** bars: 2-12, with an optional unit */
  bars: z.array(z.object({ label: label(40), value: z.number().nonnegative() }).strict()).max(12).optional(),
  /** line_chart: 2-24 labels, 1-3 series, one value per label (null for a gap) */
  labels: z.array(label(24)).min(2).max(24).optional(),
  series: z.array(z.object({ name: label(40), values: z.array(z.number().nullable()).min(2).max(24) }).strict()).min(1).max(3).optional(),
  unit: optionalText(20).nullable(),
}).strict();
const ActionInput = z.object({
  label: label(40),
  type: z.enum(["send", "open_url", "open_route"]),
  value: label(2000),
  style: z.enum(["primary", "secondary"]).optional(),
}).strict();

const schemas = {
  ask_form: z.object({
    title: label(120),
    description: optionalText(600),
    icon: CardIcon.optional(),
    submitLabel: optionalText(40),
    fields: z.array(FormFieldInput).min(1).max(8),
    /** an optional line above the card */
    text: optionalText(2000),
  }).strict(),
  show_card: z.object({
    title: label(120),
    subtitle: optionalText(200),
    icon: CardIcon.optional(),
    tint: CardTint.optional(),
    blocks: z.array(BlockInput).max(8).optional(),
    actions: z.array(ActionInput).max(3).optional(),
    text: optionalText(2000),
  }).strict(),
  withdraw_card: z.object({
    title: label(120).optional(),
    all: z.boolean().optional(),
  }).strict(),
};
type Name = keyof typeof schemas;

const descriptions: Record<Name, string> = {
  ask_form: "Ask the user something through a native form card instead of a list to answer by typing (never \"reply 1A 2B\"). Not to confirm sending, paying, signing or deleting: call that tool, its approval card asks (a form first would ask twice). 1-8 fields: type single (2-8 options, one answer), multi (2-10 options, any number) or text (typed answer); allowOther adds an \"Other\" chip with a text field; required defaults to true for single / multi and false for text. Options are { label, detail? }. Optional title icon (one of the CardIcon keys) and text: a line above the card. Ends this turn; the user's answers arrive as their next message.",
  show_card: "Show structured information as a native card instead of a long block of text: a summary, a status, a comparison, a short plan. title, subtitle, icon, tint (orange, blue, green, purple, amber, red, grey) and up to 8 blocks: text {text}, rows {rows: [{title, detail?, value?, icon?}]}, metrics {metrics: [{label, value, delta?, trend?}]}, progress {label, value 0..1, detail?}, checklist {checklist: [{text, done}], checkable?}, bars {bars: [{label, value}], unit?}, line_chart {labels, series: [{name, values}], unit?}. Use line_chart for a trend over time, bars to compare categories. Line charts need 2-24 labels (at most 24 characters each), 1-3 named series with exactly one number per label (null for a gap); unit is optional or null. Set checkable: true on a plan, to-do or packing checklist the user ticks off; leave status lists read-only (the default). Never supply checklist item ids: the server assigns them. Up to 3 actions: send (value is sent as the user's message), open_url (an https URL), open_route (a duet:// link). The turn carries on.",
  withdraw_card: "When the user asks you to retract or cancel a question or connection request you sent, withdraw your own open form or connection request in this thread. Provide exactly one of title (trimmed, case-insensitive) or all: true. It only changes those two card kinds; approval cards cannot be withdrawn this way and instead expire or are declined by the user. Say a card is withdrawn only when this tool's result lists it.",
};

const STATUS: Record<Name, StatusKey> = { ask_form: "thinking", show_card: "thinking", withdraw_card: "thinking" };

/** ask_form / show_card in chat, a task's session, a morning brief and a routine run (not quiet check-ins, scans or builds). */
const OFFERED_KINDS = new Set(["chat", "task", "brief", "routine"]);

export interface CardToolDeps { db: Db; events: EventBus }

type OpenCard = { id: string; taskId: string | null; kind: "form" | "connection_request"; raw: string; payload: Record<string, unknown>; title: string };

async function openCards(db: Db, input: Pick<TurnInput, "userId" | "channelId" | "taskId">): Promise<OpenCard[]> {
  const rows = await db.message.findMany({
    where: { userId: input.userId, channelId: input.channelId, taskId: input.taskId, callId: null, role: "assistant", kind: { in: ["form", "connection_request"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, taskId: true, kind: true, payload: true },
  });
  return rows.flatMap((row): OpenCard[] => {
    if (row.kind === "form") {
      const raw = storedPayload(row.payload);
      const parsed = FormMessage.shape.payload.safeParse(raw);
      if (!parsed.success || parsed.data.state !== "open") return [];
      const title = parsed.data.title.trim();
      return title ? [{ id: row.id, taskId: row.taskId, kind: row.kind, raw: row.payload, payload: raw, title }] : [];
    }
    if (row.kind !== "connection_request") return [];
    const raw = storedPayload(row.payload);
    const parsed = ConnectionRequestMessage.shape.payload.safeParse(raw);
    if (!parsed.success || parsed.data.state !== "open") return [];
    const title = parsed.data.name.trim();
    return title ? [{ id: row.id, taskId: row.taskId, kind: row.kind, raw: row.payload, payload: raw, title }] : [];
  });
}

const turnKind = (input: TurnInput) => input.kind ?? (input.taskId === null ? "chat" : "task");

type Reply = { result: ToolResultBlock; endTurn: boolean };
type FormPayload = z.input<typeof FormMessage.shape.payload>;
type CardPayload = z.input<typeof CardMessage.shape.payload>;
type Built<T> = { ok: true; payload: T } | { ok: false; error: string; field?: string };

const bad = <T>(error: string, field?: string): Built<T> => ({ ok: false, error, ...(field ? { field } : {}) });

/** ask_form's arguments as a form card's payload (ids are the server's), or what's wrong with them. */
export function buildForm(args: z.output<typeof schemas.ask_form>): Built<FormPayload> {
  const fields: FormPayload["fields"] = [];
  for (const [i, field] of args.fields.entries()) {
    const at = `fields.${i}`;
    const id = `f${i + 1}`;
    if (field.type === "text") {
      if (field.options?.length) return bad("a text field has no options; use type single or multi for choices", `${at}.options`);
      fields.push({ id, type: "text", label: field.label, required: field.required ?? false, placeholder: field.placeholder || null, multiline: field.multiline ?? false });
      continue;
    }
    const options = field.options ?? [];
    const max = field.type === "single" ? 8 : 10;
    if (options.length < 2 || options.length > max) return bad(`a ${field.type} field needs 2-${max} options`, `${at}.options`);
    const labels = options.map((o) => o.label.toLowerCase());
    if (new Set(labels).size !== labels.length) return bad("two options have the same label", `${at}.options`);
    if (field.placeholder !== undefined || field.multiline !== undefined) return bad("placeholder and multiline are for text fields only", at);
    fields.push({
      id, type: field.type, label: field.label, required: field.required ?? true, allowOther: field.allowOther ?? false,
      options: options.map((o, j) => ({ id: `${id}o${j + 1}`, label: o.label, detail: o.detail || null })),
    });
  }
  const payload: FormPayload = {
    title: args.title, description: args.description || null, icon: args.icon ?? "question", fields,
    submitLabel: args.submitLabel || null, state: "open", answers: null,
  };
  const parsed = FormMessage.shape.payload.safeParse(payload);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? "invalid form", parsed.error.issues[0]?.path.join("."));
  return { ok: true, payload };
}

const ROUTE = /^duet:\/\/[a-z]+(\/[A-Za-z0-9_-]+)?$/;

/** show_card's arguments as a card's payload, or what's wrong with them. */
export function buildCard(args: z.output<typeof schemas.show_card>): Built<CardPayload> {
  const blocks: CardPayload["blocks"] = [];
  let checklistItem = 0;
  for (const [i, block] of (args.blocks ?? []).entries()) {
    const at = `blocks.${i}`;
    switch (block.type) {
      case "text":
        if (!block.text) return bad("a text block needs text", `${at}.text`);
        blocks.push({ type: "text", text: block.text });
        break;
      case "rows":
        if (!block.rows?.length) return bad("a rows block needs 1-12 rows", `${at}.rows`);
        blocks.push({ type: "rows", rows: block.rows.map((r) => ({ icon: r.icon ?? null, title: r.title, detail: r.detail || null, value: r.value || null })) });
        break;
      case "metrics":
        if (!block.metrics?.length) return bad("a metrics block needs 1-6 metrics", `${at}.metrics`);
        blocks.push({ type: "metrics", items: block.metrics.map((m) => ({ label: m.label, value: m.value, delta: m.delta || null, trend: m.trend ?? null })) });
        break;
      case "progress":
        if (!block.label || block.value === undefined) return bad("a progress block needs label and value (0 to 1)", at);
        blocks.push({ type: "progress", label: block.label, value: block.value, detail: block.detail || null });
        break;
      case "checklist":
        if (!block.checklist?.length) return bad("a checklist block needs 1-12 items", `${at}.checklist`);
        blocks.push({ type: "checklist", items: block.checklist.map((item) => ({ ...item, id: block.checkable ? `c${++checklistItem}` : null })) });
        break;
      case "bars":
        if (!block.bars || block.bars.length < 2) return bad("a bars block needs 2-12 bars", `${at}.bars`);
        blocks.push({ type: "bars", items: block.bars, unit: block.unit || null });
        break;
      case "line_chart": {
        const parsed = LineChartBlock.safeParse({ type: block.type, labels: block.labels, series: block.series, unit: block.unit || null });
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return bad(issue?.message ?? "invalid line chart", `${at}.${issue?.path.join(".")}`);
        }
        blocks.push(parsed.data);
        break;
      }
    }
  }
  const actions: CardPayload["actions"] = [];
  for (const [i, action] of (args.actions ?? []).entries()) {
    if (action.type === "open_url" && !/^https:\/\/\S+$/.test(action.value)) return bad("open_url takes an https URL", `actions.${i}.value`);
    if (action.type === "open_route" && !ROUTE.test(action.value)) return bad("open_route takes a duet:// link (duet://tasks/<id>, duet://artifacts/<id> ...)", `actions.${i}.value`);
    actions.push({ label: action.label, type: action.type, value: action.value, style: action.style ?? (i === 0 ? "primary" : "secondary") });
  }
  const payload: CardPayload = {
    icon: args.icon ?? "sparkle", tint: args.tint ?? "orange", title: args.title, subtitle: args.subtitle || null, blocks, actions,
  };
  const parsed = CardMessage.shape.payload.safeParse(payload);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? "invalid card", parsed.error.issues[0]?.path.join("."));
  return { ok: true, payload };
}

export function createCardTools(tasks: TaskService, deps?: CardToolDeps): ToolProvider {
  const offered = (input: TurnInput) => OFFERED_KINDS.has(turnKind(input));
  const withdrawOffered = (input: TurnInput) => !!deps && (turnKind(input) === "chat" || turnKind(input) === "task");
  return {
    name: "cards",
    async tools(input) {
      if (!offered(input)) return [];
      return (Object.keys(schemas) as Name[])
        .filter((name) => name !== "withdraw_card" || withdrawOffered(input))
        .map((name) => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(schemas[name], { io: "input" }) }));
    },
    status: (call) => (Object.hasOwn(STATUS, call.name) ? STATUS[call.name as Name] : undefined),
    async execute(call: ToolUseBlock, input: TurnInput): Promise<Reply> {
      const reply = (data: unknown, isError = false, endTurn = false): Reply => ({
        result: { type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) },
        endTurn,
      });
      const name = call.name as Name;
      if (!offered(input) || !Object.hasOwn(schemas, name) || (name === "withdraw_card" && !withdrawOffered(input))) return reply({ error: "Tool is not available" }, true);
      const parsed = schemas[name].safeParse(call.input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return reply({ error: "Invalid tool arguments", field: issue?.path.join(".") || null, detail: issue?.message ?? null }, true);
      }
      if (name === "ask_form") {
        const args = schemas.ask_form.parse(call.input);
        const built = buildForm(args);
        if (!built.ok) return reply({ error: "Invalid form", field: built.field ?? null, detail: built.error }, true);
        const card = await input.sink.upsertMessage({ role: "assistant", kind: "form", text: args.text ?? "", payload: built.payload });
        // In a task's session the task waits for the user (needs_input) until the answers come in.
        if (input.taskId !== null) tasks.signal(input.runId, "ask");
        return reply({ shown: true, messageId: card.id, waitingForAnswers: true, note: "The user's answers arrive as their next message." }, false, true);
      }
      if (name === "withdraw_card") {
        if (!deps) return reply({ error: "Tool is not available" }, true);
        const args = schemas.withdraw_card.parse(call.input);
        const hasTitle = args.title !== undefined;
        const hasAll = args.all !== undefined;
        if (hasTitle === hasAll || args.all === false) return reply({ error: "Invalid tool arguments", field: null, detail: "Provide exactly one of title or all: true." }, true);
        const cards = await openCards(deps.db, input);
        const wanted = args.title?.toLowerCase();
        const selected = args.all === true ? cards : cards.filter((card) => card.title.toLowerCase() === wanted);
        const withdrawn: string[] = [];
        const tasksToRefresh = new Set<string>();
        for (const card of selected) {
          const next = { ...card.payload, state: "dismissed" as const, closedBy: "assistant" as const };
          const claimed = await deps.db.message.updateMany({ where: { id: card.id, payload: card.raw }, data: { payload: JSON.stringify(next) } });
          if (claimed.count !== 1) continue;
          withdrawn.push(card.title);
          await emitStored(deps.db, deps.events, input.userId, card.id);
          if (card.taskId) tasksToRefresh.add(card.taskId);
        }
        for (const taskId of tasksToRefresh) await tasks.refresh(taskId);
        const remaining = await openCards(deps.db, input);
        return reply({
          withdrawn,
          remaining: remaining.map((card) => card.title),
          note: withdrawn.length ? `Withdrew ${withdrawn.length} card${withdrawn.length === 1 ? "" : "s"}.` : "No matching open form or connection request was found.",
        });
      }
      const args = schemas.show_card.parse(call.input);
      const built = buildCard(args);
      if (!built.ok) return reply({ error: "Invalid card", field: built.field ?? null, detail: built.error }, true);
      const card = await input.sink.upsertMessage({ role: "assistant", kind: "card", text: args.text ?? "", payload: built.payload });
      return reply({ shown: true, messageId: card.id });
    },
  };
}
