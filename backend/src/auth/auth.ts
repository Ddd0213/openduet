// Better Auth is called only from our server routes; its HTTP handler is never mounted.
import { betterAuth, generateId } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { bearer, username } from "better-auth/plugins";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { Session } from "@prisma/client";
import { hashedTokenPlaceholder, SESSION_MAX_AGE_MS, sessionExpiresAt, sessionTokenHash } from "../contract/m28.ts";
import { signInSession } from "./sessions.ts";

export function createAuth(config: Config, db: Db) {
  // Better Auth's environment opt-in overrides telemetry.enabled; enforce self-hosted privacy.
  process.env.BETTER_AUTH_TELEMETRY = "false";
  process.env.BETTER_AUTH_TELEMETRY_DEBUG = "false";
  return betterAuth({
    database: prismaAdapter(db, { provider: "sqlite" }),
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.PUBLIC_URL,
    user: { fields: { email: "authEmail" } },
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    plugins: [username(), bearer()],
    session: {
      expiresIn: SESSION_MAX_AGE_MS / 1000,
      disableSessionRefresh: true,
      additionalFields: { tokenHash: { type: "string", required: false, input: false, returned: false } },
      cookieCache: { enabled: false },
    },
    databaseHooks: { session: { create: { before: async (data) => {
      const slot = signInSession.getStore();
      if (!slot) throw new Error("Session creation requires a sign-in request");
      const id = generateId(32);
      slot.token = data.token;
      slot.id = id;
      return { data: { ...data, id, token: hashedTokenPlaceholder(id),
        tokenHash: sessionTokenHash(data.token), expiresAt: sessionExpiresAt(data.createdAt) } };
    } } } },
    // Our socket-aware proxy policy, not Better Auth's header defaults, determines IPs.
    advanced: { ipAddress: { disableIpTracking: true } },
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    logger: { disabled: true },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = Session;
