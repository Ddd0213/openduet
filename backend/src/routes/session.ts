import { APIError } from "better-auth/api";
import type { Handler } from "hono";
import type { AppEnv } from "../app.ts";
import { profileResponse, syncProfile } from "../auth/middleware.ts";
import { SignInRequest, SignInResponse } from "../contract/auth.ts";
import { errorBody, HttpError, readJson } from "../http.ts";
import { log } from "../log.ts";
import { signInSession, revokeSessions } from "../auth/sessions.ts";
import { DEVICE_NAME_HEADER, DeviceName } from "../contract/m28.ts";

export const signIn: Handler<AppEnv> = async (c) => {
  const input = await readJson(c, SignInRequest);
  const { db, auth, loginRateLimiter, clientIp } = c.get("deps");
  const username = input.username.toLowerCase();
  const ip = await clientIp(c);
  const retryAfter = loginRateLimiter.retryAfter(ip, username);
  if (retryAfter) {
    log.warn("sign-in locked", { username, ip, retryAfter });
    c.header("Retry-After", String(retryAfter));
    return c.json(errorBody("rate_limited", "Too many attempts. Try again in a moment."), 429);
  }
  const slowdown = loginRateLimiter.slowdown(username);
  if (slowdown) await Bun.sleep(slowdown * 1000);
  let result;
  const slot: { token?: string; id?: string } = {};
  try {
    // Do not forward client cookies, forwarding headers, callback URLs or request bodies.
    result = await signInSession.run(slot, () => auth.api.signInUsername({ body: { username, password: input.password } }));
  } catch (error) {
    if (!(error instanceof APIError) || error.statusCode >= 500) throw error;
    loginRateLimiter.failure(ip, username);
    log.warn("sign-in failed", { username, ip, locked: loginRateLimiter.retryAfter(ip, username) > 0 });
    throw new HttpError(401, "invalid_credentials", "Wrong username or password.");
  }
  if (!slot.token || !slot.id) {
    log.error("sign-in session slot missing");
    throw new HttpError(500, "internal", "Something went wrong.");
  }
  loginRateLimiter.success(ip, username);
  const deviceName = DeviceName.safeParse(c.req.header(DEVICE_NAME_HEADER));
  await db.session.update({ where: { id: slot.id }, data: {
    ipAddress: ip === "unknown" ? null : ip,
    userAgent: c.req.header("User-Agent")?.slice(0, 1024) ?? null,
    deviceName: deviceName.success ? deviceName.data : null,
    lastUsedAt: new Date(), lastIp: ip === "unknown" ? null : ip,
  } });
  log.info("sign-in ok", { username, ip });
  const user = await db.user.findUniqueOrThrow({ where: { id: result.user.id } });
  return c.json(SignInResponse.parse({
    token: slot.token,
    user: await profileResponse(c, await syncProfile(c, user)),
  }));
};

export const signOut: Handler<AppEnv> = async (c) => {
  const deps = c.get("deps");
  await revokeSessions(deps, c.get("user").id, [c.get("session").id]);
  return c.body(null, 204);
};
