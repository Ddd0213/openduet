// Run records (M8): every run's steps (tool calls, reply text, thinking, errors), already
// redacted and capped, for the app's "full run" view. GET /api/runs and GET /api/runs/:id; no SSE:
// while a run is queued or running the app polls its detail about every 2 s.
import { z } from "zod";
import { AppName, Id, IsoDate, Phrase } from "./common.ts";

/** M9: "routine" = a scheduled task's run (schedule_task); its title is the task title (text). */
export const RunKind = z.enum(["chat", "task", "brief", "checkin", "scan", "build", "routine"]);
export const RunStatus = z.enum(["queued", "running", "completed", "resolved", "skipped", "failed"]);
export const RunStepKind = z.enum(["tool", "text", "thinking", "error"]);
export const RunStepStatus = z.enum(["running", "ok", "error", "denied", "awaiting_approval"]);

export const RunStep = z.object({
  id: Id,
  index: z.number().int().nonnegative(),
  kind: RunStepKind,
  /** model tool name for kind "tool" (e.g. "computer_exec", "web_search", "GMAIL_SEND_EMAIL"); null otherwise */
  tool: z.string().nullable(),
  /** app display name ("OpenDuet's computer", "Gmail") or null */
  app: AppName.nullable(),
  /** short title: a run.step.* key, or text (Composio tool display names) */
  title: Phrase,
  /** one grey line under the title: a command (first 200 chars), URL, path, query, first line of text */
  detail: z.string(),
  status: RunStepStatus,
  /** expandable bodies, already redacted and capped (8 KB each); null when there is nothing to show */
  input: z.string().nullable(),
  output: z.string().nullable(),
  approvalId: Id.nullable(),
  startedAt: IsoDate,
  finishedAt: IsoDate.nullable(),
});

export const RunSummary = z.object({
  id: Id,
  kind: RunKind,
  channelId: Id.nullable(),
  taskId: Id.nullable(),
  /** chat: the user's message (first 120 chars, as text); task: the task title (text); others: key run.title.<kind> */
  title: Phrase,
  status: RunStatus,
  stepCount: z.number().int().nonnegative(),
  /** the latest step's title + detail for the row subtitle; null with no steps */
  latest: z.object({ title: Phrase, detail: z.string() }).nullable(),
  error: Phrase.nullable(),
  createdAt: IsoDate,
  startedAt: IsoDate.nullable(),
  finishedAt: IsoDate.nullable(),
});

/** GET /api/runs?taskId= | ?channelId= (neither = every run), &before=<runId>&limit=30 (max 100); newest first. */
export const RunList = z.object({ runs: z.array(RunSummary), hasMore: z.boolean() });
/** GET /api/runs/:id: steps oldest first, at most the newest 300. */
export const RunDetail = RunSummary.extend({ steps: z.array(RunStep) });

export type RunStep = z.infer<typeof RunStep>;
export type RunSummary = z.infer<typeof RunSummary>;
export type RunDetail = z.infer<typeof RunDetail>;
