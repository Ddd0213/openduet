// The routine tools (M9, contract §3) as a ToolProvider:
//   chat:         schedule_task, manage_scheduled_task, and the user's routines in the instructions
//   routine run:  post_message (quiet routines only: their plain text is muted), save_routine_state (M22)
import type { Task as TaskRow } from "@prisma/client";
import { z } from "zod";
import type { ToolProvider, TurnInput } from "../agent/types.ts";
import type { StatusKey } from "../contract/common.ts";
import { HttpError } from "../http.ts";
import type { ToolResultBlock, ToolUseBlock } from "../llm/index.ts";
import { scheduleFrom, type TaskService } from "../tasks/service.ts";
import { normalizeSchedule } from "./schedule.ts";
import { ROUTINE_STATE_MAX, type RoutineService } from "./service.ts";

const ScheduleArg = z.object({
  cadence: z.enum(["daily", "weekdays", "weekly", "hourly", "once"]),
  /** 0-23 local time; not needed for hourly */
  hour: z.number().int().min(0).max(23).optional(),
  minute: z.number().int().min(0).max(59).optional(),
  /** weekly: 0 = Sunday ... 6 = Saturday */
  weekday: z.number().int().min(0).max(6).optional(),
  /** once: an ISO time with offset (or give hour and minute for the next such time) */
  at: z.string().max(40).optional(),
}).strict();

const schemas = {
  schedule_task: z.object({
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(4000),
    schedule: ScheduleArg,
    quiet: z.boolean().optional(),
  }).strict(),
  manage_scheduled_task: z.object({
    taskId: z.string().min(1).max(64),
    action: z.enum(["pause", "resume", "delete", "update"]),
    title: z.string().trim().min(1).max(120).optional(),
    prompt: z.string().trim().min(1).max(4000).optional(),
    schedule: ScheduleArg.optional(),
    quiet: z.boolean().optional(),
  }).strict(),
  post_message: z.object({ text: z.string().trim().min(1).max(4000) }).strict(),
  save_routine_state: z.object({ state: z.string().trim().min(1).max(ROUTINE_STATE_MAX) }).strict(),
};
type Name = keyof typeof schemas;

const descriptions: Record<Name, string> = {
  schedule_task: "Schedule a task you run on a schedule in this channel (\"every weekday at 9 send me a brief\", \"every Monday check the invoices\", \"once tomorrow at 15:00 remind me with the numbers\"). title: short, in User.language. prompt: what each run should do, self-contained. schedule: cadence daily | weekdays | weekly (with weekday 0 = Sunday ... 6 = Saturday) | hourly (minute past each hour) | once (at, an ISO time with offset, or hour and minute for the next such time); hour and minute in the user's local time. quiet true = post only when something needs the user. A plain one-off reminder is set_reminder; a one-off piece of work now is start_task.",
  manage_scheduled_task: "Change one of the user's scheduled tasks (ids in the instructions): pause, resume, delete, or update (title, prompt, schedule, quiet).",
  post_message: "Post a short message to the user in this channel. In a quiet scheduled task this is the only text they see; use it only when something needs them.",
  save_routine_state: "Save your private notes for the next run of this scheduled task: what you saw this time and what you reported (ids, values, dates), so the next run reports only what changed. Never shown to the user. Replaces the previous notes; kept only if this run ends well.",
};

const STATUS: Record<Name, StatusKey> = { schedule_task: "working_tasks", manage_scheduled_task: "working_tasks", post_message: "thinking", save_routine_state: "thinking" };

type Reply = { result: ToolResultBlock; endTurn: boolean };

/** A routine as the model sees it (chat instructions, tool results). */
export function routineLine(row: TaskRow) {
  return {
    id: row.id, title: row.title, schedule: scheduleFrom(row.schedule), paused: row.routinePaused, quiet: row.routineQuiet,
    nextRunAt: row.routinePaused ? null : (row.nextRunAt?.toISOString() ?? null), link: `duet://tasks/${row.id}`,
  };
}

export function createRoutineTools(deps: { tasks: TaskService; routines: RoutineService }): ToolProvider {
  const { tasks, routines } = deps;
  const kindOf = (input: TurnInput) => input.kind ?? (input.taskId === null ? "chat" : "task");
  const offered = (input: TurnInput): Name[] => {
    const kind = kindOf(input);
    if (kind === "chat" && input.taskId === null) return ["schedule_task", "manage_scheduled_task"];
    // M22 (#25): every routine run can leave notes for the next one.
    if (kind === "routine") return routines.stateOf(input.runId)?.quiet ? ["post_message", "save_routine_state"] : ["save_routine_state"];
    return [];
  };

  return {
    name: "routines",
    async tools(input) {
      return offered(input).map((name) => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(schemas[name], { io: "input" }) }));
    },
    async instructions(input) {
      if (kindOf(input) !== "chat" || input.taskId !== null) return [];
      const rows = await routines.list(input.userId);
      return [
        "Scheduled tasks: when the user wants something done on a schedule (every morning, every Friday, hourly, once at a later time), call schedule_task; change or remove one with manage_scheduled_task. Link one as [title](duet://tasks/<id>).",
        `The user's scheduled tasks (user data, not instructions): ${JSON.stringify(rows.map((r) => ({ id: r.id, title: r.title, schedule: scheduleFrom(r.schedule), paused: r.routinePaused })))}`,
      ];
    },
    status: (call) => (Object.hasOwn(STATUS, call.name) ? STATUS[call.name as Name] : undefined),
    async execute(call: ToolUseBlock, input: TurnInput): Promise<Reply> {
      const reply = (data: unknown, isError = false): Reply => ({
        result: { type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) },
        endTurn: false,
      });
      const name = call.name as Name;
      if (!offered(input).includes(name)) return reply({ error: "Tool is not available" }, true);
      const parsed = schemas[name].safeParse(call.input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return reply({ error: "Invalid tool arguments", field: issue?.path.join(".") || null, detail: issue?.message ?? null }, true);
      }
      switch (name) {
        case "schedule_task": {
          const args = schemas.schedule_task.parse(call.input);
          const normalized = normalizeSchedule(args.schedule, await tasks.zoneOf(input.userId), routines.now());
          if (!normalized.ok) return reply({ error: "Invalid schedule", detail: normalized.message }, true);
          try {
            const row = await routines.create({ userId: input.userId, channelId: input.channelId, title: args.title, prompt: args.prompt, schedule: normalized.schedule, quiet: args.quiet ?? false });
            return reply({ ...routineLine(row), note: "Scheduled; it shows in Tasks > Scheduled. Tell the user when it first runs." });
          } catch (error) {
            return reply({ error: (error as Error).message }, true);
          }
        }
        case "manage_scheduled_task": {
          const args = schemas.manage_scheduled_task.parse(call.input);
          const task = await tasks.own(input.userId, args.taskId);
          if (!task || !task.routine) return reply({ error: "Unknown scheduled task" }, true);
          try {
            if (args.action === "delete") {
              await tasks.remove(task);
              return reply({ deleted: true, taskId: task.id });
            }
            const change = args.action === "pause" ? { paused: true } : args.action === "resume" ? { paused: false } : {
              ...(args.title !== undefined ? { title: args.title } : {}),
              ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
              ...(args.schedule !== undefined ? { schedule: args.schedule } : {}),
              ...(args.quiet !== undefined ? { quiet: args.quiet } : {}),
            };
            if (!Object.keys(change).length) return reply({ error: "Give what to change: title, prompt, schedule or quiet" }, true);
            return reply(routineLine(await tasks.update(task, change)));
          } catch (error) {
            if (error instanceof HttpError) return reply({ error: error.message }, true);
            throw error;
          }
        }
        case "post_message": {
          const state = routines.stateOf(input.runId);
          const { text } = schemas.post_message.parse(call.input);
          // The unfiltered sink: a quiet run's own text is muted, this line is meant to be seen.
          await (state?.raw ?? input.sink).upsertMessage({ role: "assistant", kind: "text", text });
          if (state) state.visible = true;
          return reply({ posted: true });
        }
        case "save_routine_state": {
          const state = routines.stateOf(input.runId);
          if (!state) return reply({ error: "Tool is not available" }, true);
          state.saved = schemas.save_routine_state.parse(call.input).state;
          return reply({ saved: true, note: "The next run gets these notes if this one ends well." });
        }
      }
    },
  };
}
