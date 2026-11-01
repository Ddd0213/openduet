// M21: reliability. New shapes only; the fields they add to older shapes (RunRef, Channel,
// MessagePage, MarkReadRequest, the artifact event) are declared next to those shapes and point
// back here.
//
// Additive, so an app built before M21 keeps decoding every message: RunRef.kind and the two
// artifact statuses are extra fields with a null default, `activeRun` is null when nothing runs,
// MarkReadRequest still takes `at` alone, and `resync` is an event type older apps ignore.
import { z } from "zod";
import { Id, IsoDate, Phrase } from "./common.ts";
import { RunKind } from "./runs.ts";

// ---------------------------------------------------------------- the running turn (#11, #14)

/**
 * Channel.activeRun and MessagePage.activeRun: the turn running (or queued first) in the channel's
 * own thread right now, so a cold start can show the typing dots and Stop again. Null when nothing
 * runs there. Only the channel's own turns count (chat, and the channel turns of a routine);
 * a task's turns live on the task, a build's on its artifact.
 */
export const ActiveRun = z.object({
  runId: Id,
  kind: RunKind,
  /** when it started; its queue time while it is still waiting */
  startedAt: IsoDate,
});
export type ActiveRun = z.infer<typeof ActiveRun>;

// ---------------------------------------------------------------- event stream (#15)

/**
 * `resync` (only on GET /api/events, never stored or replayed): the stream would have to replay
 * more than its limit, or the Last-Event-ID is older than what the server keeps. The app reloads
 * what it shows (channels, the open thread, tasks, approvals) and takes the envelope's `id` as its
 * new Last-Event-ID; live events follow on the same stream.
 * replay_limit: more than RESYNC_REPLAY_LIMIT events were missed. pruned: the events after the
 * client's id were already cleaned up.
 */
export const ResyncPayload = z.object({ reason: z.enum(["replay_limit", "pruned"]) });
export type ResyncPayload = z.infer<typeof ResyncPayload>;

/** Above this many missed events the stream sends `resync` instead of replaying them. */
export const RESYNC_REPLAY_LIMIT = 2000;

// ---------------------------------------------------------------- Make edits and refreshes (#9, #10)

/**
 * The artifact event's editStatus / refreshStatus while OpenDuet changes an existing page
 * (an edit from the viewer or the chat, or a refresh): working while it runs, failed with a
 * reason when it gave up; null again once the page is saved (the artifact keeps status "ready").
 */
export const ArtifactWorkStatus = z.object({
  state: z.enum(["working", "failed"]),
  /** failed only: why, e.g. artifact.user_in_control, artifact.page_shrank, artifact.not_finished */
  reason: Phrase.nullable(),
});
export type ArtifactWorkStatus = z.infer<typeof ArtifactWorkStatus>;

/** Who started an artifact's first build (Artifact.startedBy): Retry runs it with the same trust. */
export const ArtifactStartedBy = z.enum(["user", "assistant"]);
export type ArtifactStartedBy = z.infer<typeof ArtifactStartedBy>;
