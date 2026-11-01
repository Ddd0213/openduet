// M18: a task's result in the chat, and what the user adds in the chat while a task runs.
// - taskResult: on the OpenDuet text message the server posts in the task's channel (main timeline,
//   taskId null) when the task is done. The message's text is the task's final result (markdown);
//   the app draws a footer "title · N sources · See how ›" that opens the task's conversation.
//   status: resolved (done, nothing to check) or ready_for_review (it touched the user's things:
//   an approval, or a write in one of their apps).
// - forwarded: on a user message in a task's thread that OpenDuet passed on from the chat
//   (tell_task); the app labels it "From chat". Every other message, and older payloads: null.
// A failed task, or one waiting for the user, gets a plain text line with its link in the
// channel (no new field). Additive only: older apps show these as ordinary text.
import { z } from "zod";
import { Id } from "./common.ts";

export const TaskResult = z.object({
  taskId: Id,
  title: z.string(),
  status: z.enum(["resolved", "ready_for_review"]),
  /** the task's resources (sources, files, links) */
  sourceCount: z.number().int().min(0),
});

export const Forwarded = z.enum(["chat"]);
