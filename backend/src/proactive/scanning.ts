// "Is an Up next scan running?" for GET /api/up-next. Up next scans are kind "scan" runs with no
// scheduledFor; the first-day scan is a "scan" run with scheduledFor = User.onboardedAt.
import type { Db } from "../db.ts";

export async function upNextScanning(db: Db, userId: string): Promise<boolean> {
  return (await db.run.count({ where: { userId, kind: "scan", scheduledFor: null, status: { in: ["queued", "running"] } } })) > 0;
}
