import type { Prisma } from "@prisma/client";
import type { Handler } from "hono";
import type { AppEnv } from "../app.ts";
import { profileResponse } from "../auth/middleware.ts";
import { UpdateMeRequest } from "../contract/auth.ts";
import { readJson } from "../http.ts";

export const getMe: Handler<AppEnv> = async (c) => c.json(await profileResponse(c, c.get("user")));

const pad = (n: number) => String(n).padStart(2, "0");

/** PATCH /api/me: profile sheet > Notifications (brief time, weekends) and the name the assistant uses. */
export const updateMe: Handler<AppEnv> = async (c) => {
  const input = await readJson(c, UpdateMeRequest);
  const { db } = c.get("deps");
  const user = c.get("user");
  const data: Prisma.UserUpdateInput = {
    ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
    // Stored as local "HH:mm"; the scheduler reads it in User.timezone.
    ...(input.briefTime !== undefined ? { briefTime: `${pad(input.briefTime.hour)}:${pad(input.briefTime.minute)}` } : {}),
    ...(input.weekendsOn !== undefined ? { weekendsOn: input.weekendsOn } : {}),
  };
  const updated = Object.keys(data).length ? await db.user.update({ where: { id: user.id }, data }) : user;
  return c.json(await profileResponse(c, updated));
};
