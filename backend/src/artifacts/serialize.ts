// Artifact rows -> contract shapes, and the refresh schedule an artifact may have (L151).
import type { Artifact as ArtifactRow } from "@prisma/client";
import { z } from "zod";
import { ArtifactDetail, ArtifactSource, ArtifactSummary, RefreshSchedule } from "../contract/artifacts.ts";

/** Artifact.refreshSchedule (contract: RefreshSchedule). */
export { RefreshSchedule };

export const Sources = z.array(ArtifactSource).max(20);
export type Source = z.infer<typeof ArtifactSource>;

const json = (text: string | null): unknown => {
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return undefined; }
};

export function scheduleOf(row: Pick<ArtifactRow, "refreshSchedule">): RefreshSchedule | null {
  const parsed = RefreshSchedule.safeParse(json(row.refreshSchedule));
  return parsed.success ? parsed.data : null;
}

export function sourcesOf(row: Pick<ArtifactRow, "sources">): Source[] {
  const parsed = Sources.safeParse(json(row.sources));
  return parsed.success ? parsed.data : [];
}

/** M27: content time, the later of the page's save (Artifact.updatedAt) and the live data's last change. */
export function contentUpdatedAt(row: Pick<ArtifactRow, "updatedAt" | "dataUpdatedAt">): Date {
  return row.dataUpdatedAt && row.dataUpdatedAt > row.updatedAt ? row.dataUpdatedAt : row.updatedAt;
}

export function toSummary(row: ArtifactRow): ArtifactSummary {
  return ArtifactSummary.parse({
    id: row.id, channelId: row.channelId, type: row.type, title: row.title, status: row.status,
    sourceCount: sourcesOf(row).length, refreshSchedule: scheduleOf(row), pinnedToTabBar: row.pinnedToTabBar,
    pinned: row.pinnedAt !== null, createdAt: row.createdAt.toISOString(), updatedAt: contentUpdatedAt(row).toISOString(),
    lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
    // M27: the row's updatedAt is the page's save time (data-only writes keep it); dataVersion as stored
    pageUpdatedAt: row.updatedAt.toISOString(), dataVersion: row.dataVersion,
  });
}

export function toDetail(row: ArtifactRow): z.infer<typeof ArtifactDetail> {
  return ArtifactDetail.parse({ ...toSummary(row), prompt: row.prompt, sources: sourcesOf(row) });
}

/** A first title from the prompt until the build names it (first line, at most 80 characters). */
export function draftTitle(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/)[0]!.trim();
  return line.length <= 80 ? line : `${line.slice(0, 79).trimEnd()}…`;
}
