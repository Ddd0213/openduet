import type { Handler } from "hono";
import type { AppEnv } from "../app.ts";
import { listSessions, revokeOtherSessions, revokeSessions } from "../auth/sessions.ts";
import { effectiveExpiresAt, RevokeOtherSessionsResponse } from "../contract/m28.ts";
import { HttpError } from "../http.ts";

export const getSessions: Handler<AppEnv> = async c => {
  c.header("Cache-Control", "no-store");
  return c.json(await listSessions(c.get("deps").db, c.get("user").id, c.get("session").id));
};

export const deleteSession: Handler<AppEnv> = async c => {
  const id = c.req.param("id")!;
  if (id === c.get("session").id) {
    throw new HttpError(400, "validation_failed", "id: this is the session making the request; use sign out", "id");
  }
  const deps = c.get("deps");
  const userId = c.get("user").id;
  const row = await deps.db.session.findFirst({ where: { id, userId, tokenHash: { not: null } } });
  if (!row || effectiveExpiresAt(row) <= new Date()) throw new HttpError(404, "not_found", "Not found.");
  await revokeSessions(deps, userId, [id], { alsoUnlinkedTokens: true });
  return c.body(null, 204);
};

export const revokeOthers: Handler<AppEnv> = async c => {
  const revoked = await revokeOtherSessions(c.get("deps"), c.get("user").id, c.get("session").id);
  return c.json(RevokeOtherSessionsResponse.parse({ revoked }));
};
