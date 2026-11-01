// M24 show_card input: flat gateway schema, bounded trends, server-owned checklist ids.
import { describe, expect, test } from "bun:test";
import type { TurnInput } from "../../src/agent/types.ts";
import { buildCard, createCardTools } from "../../src/cards/tools.ts";
import { CardMessage, Message } from "../../src/contract/messages.ts";
import type { TaskService } from "../../src/tasks/service.ts";

type Card = Extract<Message, { kind: "card" }>;
const base = {
  id: "message", channelId: "channel", taskId: null, text: "", status: "sent", clientId: null, reactions: [],
  createdAt: "2027-01-12T09:00:00.000Z", updatedAt: "2027-01-12T09:00:00.000Z",
};

function harness(kind: "chat" | "task" = "chat") {
  const cards: Card[] = [];
  const tools = createCardTools({ signal: () => { throw new Error("show_card must not signal a task"); } } as unknown as TaskService);
  const input: TurnInput = {
    userId: "user", channelId: "channel", taskId: kind === "task" ? "task" : null, kind, runId: "run",
    userMessage: Message.parse({ ...base, role: "user", kind: "text", payload: { skill: null, attachments: [] } }),
    attachments: [], skill: null, signal: new AbortController().signal,
    sink: {
      status: async () => {}, typing: async () => {},
      upsertMessage: async (draft) => {
        const card = CardMessage.parse({ ...base, ...draft, id: `card${cards.length + 1}`, taskId: input.taskId });
        cards.push(card);
        return card;
      },
    },
  };
  const show = async (blocks: Record<string, unknown>[]) => {
    const reply = await tools.execute({ type: "tool_use", id: "call", name: "show_card", input: { title: "Overview", blocks } }, input);
    const content = reply.result.content[0];
    if (content?.type !== "text") throw new Error("no tool result");
    return { ...reply, data: JSON.parse(content.text) };
  };
  return { tools, input, cards, show };
}

const trend = (over: Record<string, unknown> = {}) => ({
  type: "line_chart", labels: ["Mon", "Tue"], series: [{ name: "Sales", values: [0, 4] }], ...over,
});
const checklist = (over: Record<string, unknown> = {}) => ({
  type: "checklist", checklist: [{ text: "Pack a bag", done: false }, { text: "Find tickets", done: true }], ...over,
});

describe("M24 line charts", () => {
  test("the tool schema stays flat and explains trends, categories and user-ticked lists", async () => {
    const h = harness();
    const tool = (await h.tools.tools(h.input)).find((tool) => tool.name === "show_card")!;
    const schema = JSON.stringify(tool.inputSchema);
    expect(schema).not.toContain('"oneOf"');
    expect(schema).toContain('"line_chart"');
    expect(schema).toContain('"checkable"');
    expect(tool.description).toContain("trend over time");
    expect(tool.description).toContain("compare categories");
    expect(tool.description).toContain("the user ticks off");
    expect(tool.description).toContain("status lists read-only");
  });

  for (const kind of ["chat", "task"] as const) {
    test(`line_chart works in ${kind}, allows negative values and null gaps, and carries on`, async () => {
      const h = harness(kind);
      const block = trend({ labels: ["周一", "周二", "周三"], series: [
        { name: "Actual", values: [-2, null, 0] }, { name: "Target", values: [0, 1.5, 2] },
      ], unit: "kg" });
      expect(await h.show([block])).toMatchObject({ endTurn: false, data: { shown: true, messageId: "card1" } });
      expect<unknown>(h.cards[0]!.payload.blocks).toEqual([block]);
      expect(h.cards[0]!.taskId).toBe(kind === "task" ? "task" : null);
    });
  }

  for (const [labels, series] of [[2, 1], [24, 3]] as const) {
    test(`accepts the boundary of ${labels} labels and ${series} series`, async () => {
      const h = harness();
      const block = trend({
        labels: Array.from({ length: labels }, (_, i) => i === 0 ? "x".repeat(24) : `Day ${i}`),
        series: Array.from({ length: series }, (_, i) => ({ name: i === 0 ? "s".repeat(40) : `Series ${i}`, values: Array(labels).fill(null) })),
        unit: "u".repeat(20),
      });
      expect((await h.show([block])).result.isError).not.toBe(true);
      expect<unknown>(h.cards[0]!.payload.blocks).toEqual([block]);
    });
  }

  test("omitted, null and blank units become null; nonblank labels and names are trimmed", async () => {
    const h = harness();
    for (const unit of [undefined, null, "   "]) {
      expect((await h.show([trend({ unit, labels: [" Mon ", " Tue "], series: [{ name: " Sales ", values: [1, 2] }] })])).result.isError).not.toBe(true);
      expect<unknown>(h.cards.at(-1)!.payload.blocks[0]).toEqual(trend({ unit: null, series: [{ name: "Sales", values: [1, 2] }] }));
    }
  });

  const invalid: [string, Record<string, unknown>, string][] = [
    ["missing labels", { labels: undefined }, "labels"],
    ["missing series", { series: undefined }, "series"],
    ["one label", { labels: ["Mon"] }, "labels"],
    ["25 labels", { labels: Array(25).fill("Mon") }, "labels"],
    ["blank label", { labels: ["Mon", " "] }, "labels.1"],
    ["long label", { labels: ["Mon", "x".repeat(25)] }, "labels.1"],
    ["null label", { labels: ["Mon", null] }, "labels.1"],
    ["no series", { series: [] }, "series"],
    ["four series", { series: Array(4).fill({ name: "Sales", values: [1, 2] }) }, "series"],
    ["blank name", { series: [{ name: " ", values: [1, 2] }] }, "series.0.name"],
    ["long name", { series: [{ name: "s".repeat(41), values: [1, 2] }] }, "series.0.name"],
    ["one value", { series: [{ name: "Sales", values: [1] }] }, "series.0.values"],
    ["25 values", { series: [{ name: "Sales", values: Array(25).fill(1) }] }, "series.0.values"],
    ["length mismatch", { labels: ["Mon", "Tue", "Wed"] }, "series.0.values"],
    ["second series mismatch", { series: [{ name: "A", values: [1, 2] }, { name: "B", values: [1, 2, 3] }] }, "series.1.values"],
    ["string value", { series: [{ name: "Sales", values: [1, "2"] }] }, "series.0.values.1"],
    ["infinite value", { series: [{ name: "Sales", values: [1, Infinity] }] }, "series.0.values.1"],
    ["NaN value", { series: [{ name: "Sales", values: [1, NaN] }] }, "series.0.values.1"],
    ["long unit", { unit: "u".repeat(21) }, "unit"],
  ];
  for (const [name, over, field] of invalid) {
    test(`rejects ${name} with its field path and posts nothing`, async () => {
      const h = harness();
      const reply = await h.show([{ type: "text", text: "Before the chart" }, trend(over)]);
      expect(reply).toMatchObject({ endTurn: false, result: { isError: true }, data: { field: `blocks.1.${field}` } });
      expect(h.cards).toHaveLength(0);
    });
  }

  test("buildCard itself checks each series against the labels with the contract", () => {
    expect(buildCard({ title: "Trend", blocks: [{ type: "line_chart", labels: ["A", "B", "C"], series: [{ name: "N", values: [1, 2] }] }] }))
      .toMatchObject({ ok: false, field: "blocks.0.series.0.values", error: "needs 3 values, one per label" });
  });
});

describe("M24 checkable checklist input", () => {
  test("only checkable lists get server ids, unique across blocks and starting afresh per card", async () => {
    const h = harness();
    const blocks = [checklist(), checklist({ checkable: true }), checklist({ checkable: false }), checklist({ checkable: true })];
    const before = structuredClone(blocks);
    for (let i = 0; i < 2; i++) {
      expect((await h.show(blocks)).result.isError).not.toBe(true);
      const items = h.cards.at(-1)!.payload.blocks.flatMap((b) => b.type === "checklist" ? b.items : []);
      expect(items.map((item) => item.id)).toEqual([null, null, "c1", "c2", null, null, "c3", "c4"]);
      expect(items.map((item) => item.done)).toEqual([false, true, false, true, false, true, false, true]);
      expect(h.cards.at(-1)!.payload.blocks.every((b) => !("checkable" in b))).toBe(true);
    }
    expect(blocks).toEqual(before);
  });

  test("the maximum 8 blocks of 12 checkable items have 96 distinct ids", async () => {
    const h = harness();
    const blocks = Array.from({ length: 8 }, () => checklist({ checkable: true, checklist: Array.from({ length: 12 }, (_, i) => ({ text: `Item ${i}`, done: false })) }));
    expect((await h.show(blocks)).result.isError).not.toBe(true);
    const ids = h.cards[0]!.payload.blocks.flatMap((b) => b.type === "checklist" ? b.items.map((item) => item.id) : []);
    expect(ids).toEqual(Array.from({ length: 96 }, (_, i) => `c${i + 1}`));
  });

  const invalid: [string, Record<string, unknown>, string][] = [
    ["model-supplied id", { checklist: [{ text: "Pack", done: false, id: "c50" }] }, "checklist.0"],
    ["string checkable flag", { checkable: "true" }, "checkable"],
    ["empty list", { checklist: [] }, "checklist"],
    ["missing list", { checklist: undefined }, "checklist"],
    ["13 items", { checklist: Array(13).fill({ text: "Pack", done: false }) }, "checklist"],
  ];
  for (const [name, over, field] of invalid) {
    test(`rejects ${name} without posting a card`, async () => {
      const h = harness();
      expect(await h.show([checklist({ checkable: true, ...over })])).toMatchObject({ result: { isError: true }, data: { field: `blocks.0.${field}` } });
      expect(h.cards).toHaveLength(0);
    });
  }
});
