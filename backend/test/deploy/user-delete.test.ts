import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { deleteUser } from "../../src/cli/user-delete.ts";
import { createTestDatabase } from "../helpers/db.ts";

let ctx: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { ctx = await createTestDatabase(); });
afterAll(async () => { await ctx.cleanup(); });

test("deletes the user and its sessions; unknown users report false", async () => {
  const id = randomUUID();
  await ctx.db.user.create({ data: { id, name: "Smoke Test", authEmail: "smoke_x@users.invalid", username: "smoke_x" } });
  await ctx.db.session.create({ data: {
    id: randomUUID(), userId: id, token: randomUUID(), expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(), updatedAt: new Date(),
  } });
  expect(await deleteUser(ctx.db, "Smoke_X")).toBe(true);
  expect(await ctx.db.user.count({ where: { id } })).toBe(0);
  expect(await ctx.db.session.count({ where: { userId: id } })).toBe(0);
  expect(await deleteUser(ctx.db, "smoke_x")).toBe(false);
});
