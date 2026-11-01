import type { User } from "@prisma/client";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.ts";
import { Language } from "../contract/common.ts";
import { RegionCode } from "../contract/m25.ts";
import { HttpError } from "../http.ts";
import { log } from "../log.ts";
import { modelHooks } from "../models/hooks.ts";
import { toMe, type ModelFeatures } from "./me.ts";
import { Timezone } from "./validation.ts";
import { bearerToken, DEVICE_NAME_HEADER, DeviceName, SESSION_TOUCH_INTERVAL_MS } from "../contract/m28.ts";
import { findSession } from "./sessions.ts";

const unauthorized = () => new HttpError(401, "unauthorized", "Sign in again.");

/** Ignore cookies: the API authorizes exclusively with the Keychain bearer token. */
export function bearerHeaders(c: Context): Headers {
  const headers = new Headers();
  const authorization = c.req.header("Authorization");
  if (authorization) headers.set("Authorization", authorization);
  return headers;
}

export async function syncProfile(c: Context<AppEnv>, user: User): Promise<User> {
  const { db } = c.get("deps");
  const timezone = Timezone.safeParse(c.req.header("X-Timezone"));
  const language = Language.safeParse(c.req.header("X-Locale"));
  // M25: the iPhone's region (two letters); a missing or other value keeps the stored one.
  const region = RegionCode.safeParse(c.req.header("X-Region"));
  const changes = {
    ...(timezone.success && timezone.data !== user.timezone ? { timezone: timezone.data } : {}),
    ...(language.success && language.data !== user.language ? { language: language.data } : {}),
    ...(region.success && region.data !== user.region ? { region: region.data } : {}),
  };
  return Object.keys(changes).length ? db.user.update({ where: { id: user.id }, data: changes }) : user;
}

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if ((c.req.method === "GET" && c.req.path === "/api/server-info") ||
      (c.req.method === "POST" && c.req.path === "/api/session")) return next();
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) throw unauthorized();
  const { db, clientIp } = c.get("deps");
  const now = new Date();
  const row = await findSession(db, token, now);
  if (!row) throw unauthorized();
  const user = await db.user.findUnique({ where: { id: row.userId } });
  if (!user) throw unauthorized();
  const deviceName = DeviceName.safeParse(c.req.header(DEVICE_NAME_HEADER));
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= SESSION_TOUCH_INTERVAL_MS
      || (deviceName.success && deviceName.data !== row.deviceName)) {
    try {
      const ip = await clientIp(c);
      const data = { lastUsedAt: now, lastIp: ip === "unknown" ? null : ip,
        ...(deviceName.success ? { deviceName: deviceName.data } : {}) };
      await db.session.updateMany({ where: { id: row.id }, data });
      Object.assign(row, data);
    } catch (error) {
      log.warn("session activity update failed", { error: { name: (error as Error).name } });
    }
  }
  c.set("user", await syncProfile(c, user));
  c.set("session", row);
  await next();
};

export async function profileResponse(c: Context<AppEnv>, user: User) {
  const { db, config } = c.get("deps");
  const main = await db.channel.findFirst({ where: { userId: user.id, isMain: true }, select: { id: true } });
  if (!main) throw new HttpError(500, "internal", "Something went wrong.");
  return toMe(user, main.id, config, await modelFeatures(db, user.id));
}

/**
 * M12: Features.models / webSearch from the models module (the one-time import runs first). A
 * failure there is logged and the profile answers without a usable model rather than failing.
 */
export async function modelFeatures(db: Parameters<typeof modelHooks>[0], userId: string): Promise<ModelFeatures | undefined> {
  const hooks = modelHooks(db);
  if (!hooks) return undefined;
  try {
    return await hooks.features(userId);
  } catch (error) {
    log.warn("model features unavailable", { userId, error: { name: (error as Error).name } });
    return { models: false, serverWebTools: false };
  }
}
