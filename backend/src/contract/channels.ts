// Channels (the main thread is the channel with isMain = true) and their shared files.
import { z } from "zod";
import { Id, IsoDate } from "./common.ts";
import { AccessRef } from "./m11.ts";
import { ThinkingLevel } from "./m12.ts";
import { ActiveRun } from "./m21.ts";
import { FileOrigin } from "./m26.ts";

/** The 3x8 icon grid of the New channel sheet, in display order. */
export const ChannelIcon = z.enum([
  "checkbox", "calendar", "mail", "dollar", "chart", "globe", "pin", "house",
  "cube", "play", "folder", "pencil", "magnifier", "heart", "people", "briefcase",
  "book", "plane", "car", "scissors", "bag", "gift", "sprout", "music",
]);

/** The 9 colour swatches. */
export const ChannelColor = z.enum([
  "#B54C76", "#E5C0C5", "#E0BCAD", "#E69F4E", "#CAD0BA",
  "#5D927A", "#BECDDA", "#6290C2", "#C1BDD3",
]);

export const Channel = z.object({
  id: Id,
  isMain: z.boolean(),
  name: z.string(),
  icon: ChannelIcon,
  colorHex: ChannelColor,
  purpose: z.string(),
  archived: z.boolean(),
  unreadCount: z.number().int().nonnegative(),
  lastReadAt: IsoDate.nullable(),
  lastMessageAt: IsoDate.nullable(),
  createdAt: IsoDate,
  /** M11: this channel's addendum to the soul (the main thread's is always "") */
  soulExtra: z.string().default(""),
  /** M11: whether this channel reads "About you" (shared memory); the main thread always does */
  useSharedMemory: z.boolean().default(true),
  /** M12: this channel's own model (ModelEntry.id); null = the default model. The main thread's is always null. */
  modelId: Id.nullable().default(null),
  /** M12: this channel's thinking level; null = the default (clamped per model at run time) */
  thinkingLevel: ThinkingLevel.nullable().default(null),
  /** M21 (m21.ts ActiveRun): the turn running in this channel's own thread; null when none */
  activeRun: ActiveRun.nullable().default(null),
});
export type Channel = z.infer<typeof Channel>;

/** GET /api/channels (?archived=true for the Archived list). */
export const ChannelList = z.object({ channels: z.array(Channel) });

/** POST /api/channels */
export const CreateChannelRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    icon: ChannelIcon,
    colorHex: ChannelColor,
    purpose: z.string().trim().max(2000).default(""),
    /**
     * M11: skills, connectors and apps to turn on in the new channel (on top of everything with
     * scope all). Unknown or foreign ids are 400 validation_failed, field access.
     */
    access: z.array(AccessRef).max(100).default([]),
    /** M11: OpenDuet opens the channel with a short greeting and an offer of tasks (default true) */
    greet: z.boolean().default(true),
  })
  .strict();

/** PATCH /api/channels/:id */
export const UpdateChannelRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    icon: ChannelIcon,
    colorHex: ChannelColor,
    purpose: z.string().trim().max(2000),
    archived: z.boolean(),
    /** M11 (not on the main thread: 400 validation_failed) */
    soulExtra: z.string().trim().max(4000),
    useSharedMemory: z.boolean(),
    /** M12 (not on the main thread: 400): null = back to the default */
    modelId: Id.nullable(),
    thinkingLevel: ThinkingLevel.nullable(),
  })
  .partial()
  .strict();

/**
 * M9: DELETE /api/channels/:id -> 204 (the main thread: 400 validation_failed). Deletes the
 * channel with its messages, tasks, approvals, suggestions, reminders and files; its Make
 * artifacts move to the main thread (artifact events). A running turn is cancelled first.
 * Emits channel_deleted.
 */

/**
 * POST /api/channels/:id/read. M21: send `messageId` (the newest message the user saw); the server
 * reads up to that message's own createdAt. `at` alone (older apps) is still taken, with 1 ms of
 * tolerance for a time that lost its last digit. At least one of the two.
 */
export const MarkReadRequest = z
  .object({ at: IsoDate.optional(), messageId: Id.optional() })
  .strict()
  .refine((r) => r.at !== undefined || r.messageId !== undefined, { message: "at or messageId" });

/** A file in a channel. Bytes: GET /api/files/:id/content through the signed-in session. */
export const ChannelFile = z.object({
  id: Id,
  channelId: Id,
  messageId: Id.nullable(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  source: z.enum(["user", "assistant"]),
  /** relative path of the bytes, e.g. "/api/files/<id>/content" */
  url: z.string().startsWith("/api/files/"),
  createdAt: IsoDate,
  /**
   * M26 (m26.ts FileOrigin): send | write | screenshot | upload; null = from before M26 and not
   * matched (the Files page's "Other"). Older payloads parse as null.
   */
  origin: FileOrigin.nullable().default(null),
  /**
   * M26: its path in /workspace, relative to /workspace ("build/build.py"): the Files row's subtitle
   * and what "also delete from OpenDuet's computer" removes. null = none (screenshots, older rows).
   */
  workspacePath: z.string().min(1).max(1024).nullable().default(null),
  /** M26: the task whose own session made it (chat, channel and routine turns and uploads: null) */
  taskId: Id.nullable().default(null),
  /** M26: that task's current title; null without taskId or once the task is deleted */
  taskTitle: z.string().nullable().default(null),
  /**
   * M26: the Make artifact this file is the page of (workspacePath artifacts/<id>/..., the artifact
   * still there): the Files row opens the artifact instead of the preview. null otherwise.
   */
  artifactId: Id.nullable().default(null),
  /**
   * M26: when the user deleted it. Set only on chat cards (file / image payload.file, a text
   * message's attachments) and on the DELETE answer: the card shows "Deleted" and is not opened (its
   * content is 404). Lists never include deleted files.
   */
  deletedAt: IsoDate.nullable().default(null),
});
export type ChannelFile = z.infer<typeof ChannelFile>;

/**
 * GET /api/channels/:id/files: newest first, files bound to a message only. M26: deleted files are
 * left out; taskTitle and artifactId are filled in.
 */
export const ChannelFileList = z.object({ files: z.array(ChannelFile) });

/** Upload limit per file (L179). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
