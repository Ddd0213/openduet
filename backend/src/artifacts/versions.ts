// M24: each row is a save, not the page before the save. Caller owns the transaction.
import type { Artifact, Prisma } from "@prisma/client";
import { ArtifactVersion, MAX_ARTIFACT_VERSIONS, type ArtifactVersionBy, type ArtifactVersionReason } from "../contract/m24.ts";
import { DATA_VERSION_MERGE_MS, MAX_DATA_VERSIONS } from "../contract/m27.ts";
import { stripChanged } from "../make/base.ts";
import { ArtifactMessage } from "../contract/messages.ts";

export const VERSION_ORDER = [{ createdAt: "desc" }, { id: "desc" }] satisfies Prisma.ArtifactVersionOrderByWithRelationInput[];
export const versionSummary = (row: Parameters<typeof ArtifactVersion.parse>[0]) => ArtifactVersion.parse(row);

export function versionMetrics(raw: string | null) {
  if (raw === null) return null;
  try {
    const parsed = ArtifactMessage.shape.payload.shape.metrics.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export async function saveVersion(tx: Prisma.TransactionClient, row: Artifact, input: {
  by: ArtifactVersionBy; reason: ArtifactVersionReason; prompt: string | null; metrics: string | null; now: Date;
}): Promise<void> {
  const latest = await tx.artifactVersion.findFirst({ where: { artifactId: row.id }, orderBy: VERSION_ORDER });
  // A transient glow is not a page change. Keep the snapshot of the same saved content, and its
  // effective metadata, in sync without consuming another slot on an unchanged refresh.
  if (latest && stripChanged(latest.html) === stripChanged(row.html) && latest.data === row.data) {
    await tx.artifactVersion.update({ where: { id: latest.id }, data: { html: row.html, sources: row.sources, metrics: input.metrics, data: row.data } });
    return;
  }
  const createdAt = new Date(Math.max(input.now.getTime(), (latest?.createdAt.getTime() ?? 0) + 1));
  await tx.artifactVersion.create({ data: {
    artifactId: row.id, html: row.html, sources: row.sources, metrics: input.metrics, data: row.data,
    by: input.by, reason: input.reason, prompt: input.prompt?.slice(0, 8000) ?? null, createdAt,
  } });
  const dropped = await tx.artifactVersion.findMany({ where: { artifactId: row.id }, orderBy: VERSION_ORDER, skip: MAX_ARTIFACT_VERSIONS, select: { id: true } });
  if (dropped.length) await tx.artifactVersion.deleteMany({ where: { id: { in: dropped.map(v => v.id) } } });
}

/** M27: one run's updates become one undoable state per ten-minute window. */
export async function saveDataVersion(tx: Prisma.TransactionClient, row: Artifact, input: {
  runId: string; metrics: string | null; now: Date;
}): Promise<void> {
  const latest = await tx.artifactVersion.findFirst({ where: { artifactId: row.id }, orderBy: VERSION_ORDER });
  if (latest?.reason === "data" && latest.runId === input.runId
    && input.now.getTime() - latest.createdAt.getTime() < DATA_VERSION_MERGE_MS) {
    await tx.artifactVersion.update({ where: { id: latest.id }, data: { data: row.data, metrics: input.metrics, dataUpdates: { increment: 1 } } });
  } else {
    await tx.artifactVersion.create({ data: {
      artifactId: row.id, html: row.html, sources: row.sources, data: row.data, metrics: input.metrics,
      by: "assistant", reason: "data", prompt: null, runId: input.runId, dataUpdates: 1,
      createdAt: new Date(Math.max(input.now.getTime(), (latest?.createdAt.getTime() ?? 0) + 1)),
    } });
  }
  for (const [where, skip] of [[{ artifactId: row.id, reason: "data" }, MAX_DATA_VERSIONS], [{ artifactId: row.id }, MAX_ARTIFACT_VERSIONS]] as const) {
    const dropped = await tx.artifactVersion.findMany({ where, orderBy: VERSION_ORDER, skip, select: { id: true } });
    if (dropped.length) await tx.artifactVersion.deleteMany({ where: { id: { in: dropped.map(v => v.id) } } });
  }
}
