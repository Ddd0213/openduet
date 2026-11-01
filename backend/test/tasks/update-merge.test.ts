// M16: the same server-built "Decisions and updates" row right after itself is one row with a
// count (a retry that failed the same way), never model-written text or rows apart.
import { describe, expect, test } from "bun:test";
import { mergeUpdate, type Update } from "../../src/tasks/serialize.ts";
import { TaskUpdate } from "../../src/contract/tasks.ts";

const unreachable = (at: string, reason = "network error"): Update => ({
  text: { key: "system.model_unreachable", params: { reason: { type: "text", value: reason } } },
  source: "Claude",
  at,
});

describe("mergeUpdate", () => {
  test("the same failure again becomes one row: count, first time in since, latest in at", () => {
    let list: Update[] = [];
    list = mergeUpdate(list, unreachable("2026-10-26T03:30:00.000Z"));
    list = mergeUpdate(list, unreachable("2026-10-26T03:31:00.000Z"));
    list = mergeUpdate(list, unreachable("2026-10-26T03:52:00.000Z"));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ count: 3, since: "2026-10-26T03:30:00.000Z", at: "2026-10-26T03:52:00.000Z" });
    expect(TaskUpdate.safeParse(list[0]).success).toBe(true);
  });

  test("a different reason, source or anything in between keeps rows apart", () => {
    let list: Update[] = [unreachable("2026-10-26T03:30:00.000Z")];
    list = mergeUpdate(list, unreachable("2026-10-26T03:31:00.000Z", "timeout"));
    expect(list).toHaveLength(2);
    list = mergeUpdate(list, { ...unreachable("2026-10-26T03:32:00.000Z", "timeout"), source: "Gmail" });
    expect(list).toHaveLength(3);
    list = mergeUpdate(list, { text: { text: "Tried again." }, source: "Claude", at: "2026-10-26T03:33:00.000Z" });
    list = mergeUpdate(list, unreachable("2026-10-26T03:34:00.000Z"));
    expect(list).toHaveLength(5);
    expect(list.every((u) => u.count === undefined)).toBe(true);
  });

  test("model-written text is never merged, even when equal", () => {
    const line: Update = { text: { text: "Checked the sources." }, source: "Claude", at: "2026-10-26T03:30:00.000Z" };
    expect(mergeUpdate([line], { ...line, at: "2026-10-26T03:31:00.000Z" })).toHaveLength(2);
  });

  test("a merged row keeps counting and keeps its first time", () => {
    const merged: Update = { ...unreachable("2026-10-26T03:40:00.000Z"), count: 4, since: "2026-10-26T03:30:00.000Z" };
    const [row] = mergeUpdate([merged], unreachable("2026-10-26T03:45:00.000Z"));
    expect(row).toMatchObject({ count: 5, since: "2026-10-26T03:30:00.000Z", at: "2026-10-26T03:45:00.000Z" });
  });

  test("a row once stays as before (no count, no since)", () => {
    const [row] = mergeUpdate([], unreachable("2026-10-26T03:30:00.000Z"));
    expect(row).not.toHaveProperty("count");
    expect(row).not.toHaveProperty("since");
  });
});
