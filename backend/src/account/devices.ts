// POST /api/devices registers this iPhone's APNs token; DELETE /api/devices/:id on sign out.
// A token remains owned by its user until explicitly unregistered (including iOS sign-out).
import type { Handler } from "hono";
import type { AppEnv } from "../app.ts";
import { RegisterDeviceRequest, RegisterDeviceResponse } from "../contract/account.ts";
import { HttpError, readJson } from "../http.ts";

export const registerDevice: Handler<AppEnv> = async (c) => {
  const input = await readJson(c, RegisterDeviceRequest);
  const { db } = c.get("deps");
  const userId = c.get("user").id;
  // APNs tokens are hex; one spelling so the same device never gets two rows.
  const token = input.token.toLowerCase();
  const fields = { environment: input.environment, locale: input.locale, sessionId: c.get("session").id };
  const row = await db.$transaction(async tx => {
    const row = await tx.deviceToken.upsert({
      where: { provider_token: { provider: input.provider, token } },
      create: { provider: input.provider, token, userId, ...fields },
      update: fields,
    });
    // Roll back even the metadata update if the token belongs to another user.
    if (row.userId !== userId) throw new HttpError(404, "not_found", "Not found.");
    return row;
  });
  return c.json(RegisterDeviceResponse.parse({ deviceId: row.id }));
};

export const deleteDevice: Handler<AppEnv> = async (c) => {
  const { db } = c.get("deps");
  const id = c.req.param("id");
  if (!id) throw new HttpError(404, "not_found", "Not found.");
  const removed = await db.deviceToken.deleteMany({ where: { id, userId: c.get("user").id } });
  if (removed.count === 0) throw new HttpError(404, "not_found", "Not found.");
  return c.body(null, 204);
};
