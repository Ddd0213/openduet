// Make tab artifacts: self-contained HTML built on OpenDuet's computer.
import { z } from "zod";
import { AppName, Id, IsoDate, Schedule } from "./common.ts";

export const ArtifactType = z.enum(["web_page", "docs", "slides", "dashboard", "design", "design_system"]);

export const ArtifactSource = z.object({
  name: z.string(),
  app: AppName.nullable(),
  detail: z.string(),
});

export const ArtifactSummary = z.object({
  id: Id,
  channelId: Id,
  type: ArtifactType,
  title: z.string(),
  status: z.enum(["building", "ready", "failed"]),
  sourceCount: z.number().int().nonnegative(),
  refreshSchedule: Schedule.nullable(),
  pinnedToTabBar: z.boolean(),
  /**
   * M10: pinned in Make (sorts first, newest pin first). Separate from pinnedToTabBar: any number
   * can be pinned and both can be true. Older payloads parse as false.
   */
  pinned: z.boolean().default(false),
  createdAt: IsoDate,
  /**
   * Content time ("Updated now", Changed today, Last modified, thumbnails). M27: the later of the
   * page's last save (pageUpdatedAt) and its live data's last change, so a data update moves it too.
   */
  updatedAt: IsoDate,
  /**
   * M24: when the user last opened it (GET /api/artifacts/:id writes it; updatedAt stays). null =
   * made and never opened: the gallery's "Just made" border and badge. Older payloads parse as null.
   */
  lastOpenedAt: IsoDate.nullable().default(null),
  /**
   * M27 (m27.ts): when the page itself was last saved (a build, an edit, a page refresh, a restore that
   * changed the page). The viewer reloads the page only when this moves; when only dataVersion moves it
   * hands the new data to the open page (GET /api/artifacts/:id/data). null = an older server: use
   * updatedAt (reload on every change, as before).
   */
  pageUpdatedAt: IsoDate.nullable().default(null),
  /**
   * M27: +1 on every change of the live data; 0 = never had data (every artifact before M27, and every
   * type but dashboard). An open viewer showing an older one fetches the data.
   */
  dataVersion: z.number().int().nonnegative().default(0),
});
export type ArtifactSummary = z.infer<typeof ArtifactSummary>;

/**
 * GET /api/artifacts/:id (the HTML itself: GET /api/artifacts/:id/html, text/html). M24: this is
 * "opened" (the viewer, the tab-bar page, a duet://artifacts link): it sets lastOpenedAt.
 */
export const ArtifactDetail = ArtifactSummary.extend({
  prompt: z.string(),
  sources: z.array(ArtifactSource),
});

/** GET /api/artifacts */
export const ArtifactList = z.object({ artifacts: z.array(ArtifactSummary) });

/** POST /api/artifacts (Describe sheet / gallery hero composer). Build progress arrives as events. */
export const CreateArtifactRequest = z
  .object({
    type: ArtifactType,
    prompt: z.string().trim().min(1).max(8000),
    channelId: Id,
  })
  .strict();

/** POST /api/artifacts/:id/edit (✎: ask OpenDuet for changes). */
export const EditArtifactRequest = z.object({ prompt: z.string().trim().min(1).max(8000) }).strict();

/** An artifact's refresh schedule: daily / weekdays / hourly at a local time in the user's timezone. */
export const RefreshSchedule = z
  .object({
    cadence: z.enum(["daily", "weekdays", "hourly"]),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  })
  .strict();
export type RefreshSchedule = z.infer<typeof RefreshSchedule>;

/**
 * PATCH /api/artifacts/:id (Add to tab bar / Remove from tab bar, rename, change or clear the
 * refresh schedule). Only one artifact is pinned to the tab bar at a time: pinning one unpins the
 * previous. M10: `pinned` (Pin / Unpin in Make) is separate; any number can be pinned.
 */
export const UpdateArtifactRequest = z
  .object({
    pinnedToTabBar: z.boolean(),
    pinned: z.boolean(),
    title: z.string().trim().min(1).max(200),
    refreshSchedule: RefreshSchedule.nullable(),
  })
  .partial()
  .strict();

export const ArtifactResponse = z.object({ artifact: ArtifactSummary });
