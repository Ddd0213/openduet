// M21: the user's quiet hours for pushes (User.quietStart / quietEnd in User.timezone), the same
// window the proactive gate uses for messages initiated by the assistant (proactive/gate.ts inQuietHours).
import type { Db } from "../db.ts";
import { inQuietHours } from "../proactive/gate.ts";
import { localParts, safeZone } from "../scheduler/slots.ts";

/** Whether `now` is inside the user's quiet hours; false for an unknown user. */
export async function inUserQuietHours(db: Db, userId: string, now: Date): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { quietStart: true, quietEnd: true, timezone: true } });
  if (!user) return false;
  const local = localParts(now, safeZone(user.timezone));
  return inQuietHours(local.hour * 60 + local.minute, user.quietStart, user.quietEnd);
}
