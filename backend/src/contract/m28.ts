// M28 (security review M4): login sessions. A fixed 90-day lifetime, only sha256(token) kept on the
// server, the signed-in devices list, revoking one or all the others, and open streams closed when
// their session goes. The rules zod can't express are in docs/API.md "M28 sessions".
//
// Better Auth 1.7.12 can't keep only a hash (it creates, finds, refreshes and deletes sessions by the
// raw `token` column: dist/db/internal-adapter.mjs 259-370, 425-500), so the server still lets it
// create the session at sign-in, with a `session.create.before` database hook that writes
// `hashedTokenPlaceholder` and `tokenHash` in place of the raw token before the insert, and does
// every lookup itself by `Session.tokenHash`.
import { createHash } from "node:crypto";
import { z } from "zod";
import { Id, IsoDate } from "./common.ts";

/** A session lives 90 days from its sign-in, whatever it does; nothing extends it. */
export const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** `lastUsedAt` / `lastIp` are written when they are at least this old (or the device name changed). */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
/** How often the server re-checks the sessions of open streams (expired, or deleted by the CLI). */
export const SESSION_STREAM_CHECK_MS = 60 * 1000;
/** WebSocket close code for "your session ended" (private-use range 4000-4999). */
export const SESSION_ENDED_CLOSE_CODE = 4001;
/** The header every M28 app request carries: its own label for the device. */
export const DEVICE_NAME_HEADER = "X-Device-Name";

/**
 * X-Device-Name: printable ASCII (headers carry no other text safely), 1-64 characters after
 * trimming. A missing or invalid value is ignored and keeps the stored one (like X-Timezone).
 */
export const DeviceName = z.string().trim().min(1).max(64).regex(/^[\x20-\x7E]+$/);

/** `Authorization: Bearer <token>`: the token, or null for anything else (the same rule as before M28). */
export function bearerToken(authorization: string | null | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  return match ? match[1]! : null;
}

/** What `Session.tokenHash` holds: sha256 of the bearer token's exact bytes, 64 lowercase hex. */
export function sessionTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * What `Session.token` holds once `tokenHash` is set. It must stay unique (the column is) and must
 * never work as a credential, also on a server rolled back to before M28: the space means no
 * `Authorization: Bearer` header can carry it (`bearerToken` and every older server require \S+).
 */
export function hashedTokenPlaceholder(sessionId: string): string {
  return `hashed ${sessionId}`;
}

/** A session's expiry: sign-in time + 90 days. */
export function sessionExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + SESSION_MAX_AGE_MS);
}

/**
 * The expiry a stored row really has: never past createdAt + 90 days. Rows from before M28 carry
 * Better Auth's rolling 365-day expiry; the startup conversion writes this value back.
 */
export function effectiveExpiresAt(row: { createdAt: Date; expiresAt: Date }): Date {
  const cap = sessionExpiresAt(row.createdAt);
  return row.expiresAt.getTime() < cap.getTime() ? row.expiresAt : cap;
}

/**
 * One signed-in device: a live session of this user (GET /api/sessions). Never carries the token
 * or its hash. Times are ISO; the app formats them.
 */
export const SessionInfo = z.object({
  id: Id,
  /** the session making this request ("This iPhone"); exactly one row is current */
  current: z.boolean(),
  /** sign-in time */
  createdAt: IsoDate,
  /** the last request (written at most every 5 minutes; the current row's is about now); null = none since M28 */
  lastUsedAt: IsoDate.nullable(),
  /** createdAt + 90 days: then it signs out by itself */
  expiresAt: IsoDate,
  /** the app's X-Device-Name ("iPhone 15 Pro"); null = an app before M28, or none sent */
  deviceName: z.string().nullable(),
  /** the sign-in's User-Agent as stored (at most 1024 characters); null = none (also an empty one) */
  userAgent: z.string().nullable(),
  /** the sign-in's client IP; null = unknown */
  signInIp: z.string().nullable(),
  /** the last request's client IP; null = none since M28 */
  lastIp: z.string().nullable(),
  /** an APNs token registered from this session gets pushes (false: none, or registered before M28) */
  push: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

/** GET /api/sessions: every live session of this user, the current one first, then the most recently used. */
export const SessionList = z.object({ sessions: z.array(SessionInfo) });
export type SessionList = z.infer<typeof SessionList>;

/** POST /api/sessions/revoke-others: how many sessions (other devices) were signed out; 0 is fine. */
export const RevokeOtherSessionsResponse = z.object({ revoked: z.number().int().nonnegative() });
export type RevokeOtherSessionsResponse = z.infer<typeof RevokeOtherSessionsResponse>;
