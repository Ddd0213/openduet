// SSE events. Both streams (the POST /messages answer and GET /api/events) send the same
// stored events: `id:` is Event.id (increasing), `event:` is the type, `data:` is the JSON
// envelope below. Reconnect with Last-Event-ID (or ?since=<id>) to catch up; the app dedups
// by id. A heartbeat comment line (": ping") goes out every ~20 s.
import { z } from "zod";
import { Approval } from "./approvals.ts";
import { ArtifactSummary } from "./artifacts.ts";
import { Channel } from "./channels.ts";
import { Id, IsoDate, Phrase, StatusKey } from "./common.ts";
import { ComputerState } from "./computer.ts";
import { CallCue } from "./m13.ts";
import { ArtifactWorkStatus, ResyncPayload } from "./m21.ts";
import { Message } from "./messages.ts";
import { RunKind } from "./runs.ts";
import { TaskSummary } from "./tasks.ts";
import { UsageState } from "./account.ts";

const envelope = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    id: z.number().int().positive(),
    type: z.literal(type),
    channelId: Id.nullable(),
    createdAt: IsoDate,
    payload,
  });

export const RunRef = z.object({
  runId: Id,
  taskId: Id.nullable(),
  /**
   * M21: which kind of run (RunKind). The app ends only the run of this kind (a build's done no
   * longer clears the chat's typing dots). Null on events stored before M21.
   */
  kind: RunKind.nullable().default(null),
});

/** Live status for the header pill and the mascot morph; null = idle. */
export const StatusEvent = envelope("status", RunRef.extend({ status: StatusKey.nullable() }));
/** Typing dots on/off. */
export const TypingEvent = envelope("typing", RunRef.extend({ typing: z.boolean() }));
/** A new or updated message (upsert by id; the user's own message echoes clientId). */
export const MessageEvent = envelope("message", z.object({ message: Message }));
export const MessageDeletedEvent = envelope("message_deleted", z.object({ messageId: Id }));
export const TaskEvent = envelope("task", z.object({ task: TaskSummary }));
/** M9: DELETE /api/tasks/:id */
export const TaskDeletedEvent = envelope("task_deleted", z.object({ taskId: Id }));
/** M9: DELETE /api/channels/:id (envelope channelId is the deleted channel) */
export const ChannelDeletedEvent = envelope("channel_deleted", z.object({ channelId: Id }));
export const ApprovalEvent = envelope("approval", z.object({ approval: Approval }));
export const ChannelEvent = envelope("channel", z.object({ channel: Channel }));
export const ArtifactEvent = envelope(
  "artifact",
  z.object({
    artifact: ArtifactSummary,
    /** Build view status line: a key while starting ("starting_up", "waking_workspace"), then the model's step text */
    buildStatus: Phrase.nullable(),
    /** M21 (m21.ts ArtifactWorkStatus): OpenDuet editing this page; null when not editing */
    editStatus: ArtifactWorkStatus.nullable().default(null),
    /** M21: a refresh of this page (schedule or Refresh now); null when not refreshing */
    refreshStatus: ArtifactWorkStatus.nullable().default(null),
  }),
);
export const UsageEvent = envelope("usage", z.object({ usage: UsageState }));
export const ComputerEvent = envelope("computer", z.object({ computer: ComputerState }));
/** Shown as a local notification when the app is inactive or the channel isn't on screen. */
export const NotificationEvent = envelope(
  "notification",
  z.object({
    title: Phrase,
    body: Phrase,
    /**
     * duet://channels/<id>[?message=<messageId>], duet://tasks/<id>[?message=<messageId>],
     * duet://artifacts/<id> (M21: `message` names the line to scroll to)
     */
    route: z.string().startsWith("duet://"),
    /**
     * M21: one id per thing (task-<id>, approval-<id>, message-<id>; M29: artifact-<id>), the same as
     * the remote push's collapse id: a newer notification for it replaces the older one, and a
     * decided approval's is removed. Null on events stored before M21.
     */
    collapseId: z.string().min(1).max(200).nullable().default(null),
    /**
     * M29: inside the user's quiet hours, a notification that follows them: show it without sound
     * (interruption level passive), the same as the remote push. False on events stored before M29.
     */
    passive: z.boolean().default(false),
  }),
);
/** End of a run. On failure the chat also gets a grey system line (never an invented reply). */
export const DoneEvent = envelope(
  "done",
  RunRef.extend({ status: z.enum(["completed", "failed", "cancelled"]), error: Phrase.nullable() }),
);
/** M13: what the voice should say during an open call (reply / notice / progress); see m13.ts CallCue. */
export const CallEvent = envelope("call", CallCue);
/** M21: reload and carry on (m21.ts ResyncPayload). Only on GET /api/events; never stored. */
export const ResyncEvent = envelope("resync", ResyncPayload);

export const DuetEvent = z.discriminatedUnion("type", [
  StatusEvent, TypingEvent, MessageEvent, MessageDeletedEvent, TaskEvent, ApprovalEvent,
  ChannelEvent, ArtifactEvent, UsageEvent, ComputerEvent, NotificationEvent, DoneEvent,
  TaskDeletedEvent, ChannelDeletedEvent, CallEvent, ResyncEvent,
]);
export type DuetEvent = z.infer<typeof DuetEvent>;
export const EVENT_TYPES = DuetEvent.options.map((o) => o.shape.type.value);
