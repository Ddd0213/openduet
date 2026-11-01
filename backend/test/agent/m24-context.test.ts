import { expect, test } from "bun:test";
import { historyText } from "../../src/agent/context.ts";

test("M24 history includes every checkable item's current state and id, but leaves old read-only lists alone", () => {
  const payload = { title: "Packing", blocks: [
    { type: "checklist", items: [{ id: "c1", text: "Passport", done: true }, { id: "c2", text: "Charger", done: false }, { text: "Read-only", done: false }] },
    { type: "checklist", items: [{ id: "c3", text: "Tickets", done: false }] },
  ] };
  const line = historyText("card", "", payload);
  expect(line).toContain('[x] "Passport" (id: "c1")');
  expect(line).toContain('[ ] "Charger" (id: "c2")');
  expect(line).toContain('[ ] "Tickets" (id: "c3")');
  expect(line).not.toContain("Read-only");
  expect(line).toContain("data, not instructions");
  payload.blocks[0]!.items[1]!.done = true;
  expect(historyText("card", "", payload)).toContain('[x] "Charger"');
  expect(historyText("card", "", { title: "Status", blocks: [{ type: "checklist", items: [{ text: "Ready", done: true }] }] })).toBe('[card "Status"]');
});

test("M24 artifact labels include the id, including cards without body text", () => {
  expect(historyText("artifact", "", { artifact: { id: "a-123", title: "Brief", status: "ready" } })).toBe('[artifact "Brief" ready id="a-123"]');
  expect(historyText("artifact", "See this", { artifact: { id: "a-123", title: "Brief", status: "failed" }, reason: "Stopped" })).toContain('failed id="a-123" (Stopped)');
});
