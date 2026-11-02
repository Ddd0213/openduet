// The answer stream of POST /api/channels/:id/messages and POST /api/tasks/:id/messages
// (docs/API.md "SSE"). It subscribes before the user's message is stored, so nothing between
// "stored" and "the response started" is lost, then forwards this thread's events (and
// account-wide ones such as usage) until this run's `done`. Closing it never cancels the run.
// M21: it is a plain subscriber and never calls EventBus.present(), so an answer stream left open
// after the app was suspended doesn't count as "online": pushes still go out (only GET
// /api/events marks the user online; notify/notifier.ts reads EventBus.onlineCount).
import type { DuetEvent } from "../contract/events.ts";
import type { EventBus } from "../events/bus.ts";
import { sseResponse, type SseSink } from "../events/sse.ts";
import type { SessionConnections } from "../auth/connections.ts";

export interface RunTap {
  /**
   * Starts streaming the buffered and live events; closes after `done` of `runId`, or right after
   * the buffered echo when there is no run left to wait for (null).
   */
  respond(runId: string | null, opts: {
    heartbeatMs?: number; signal?: AbortSignal; session?: { sessionId: string; connections: SessionConnections };
    /**
     * The run that answers this stream's message now (RunHost.runOf). A steering correction the
     * model never read runs as its own turn after Stop: at the stopped run's `done` the stream
     * moves on to that turn instead of closing.
     */
    follow?: () => string | null;
  }): Response;
  /** Drops the subscription when the send was rejected. */
  stop(): void;
}

/** A channel's stream: everything in that channel (its timeline and its tasks) plus account-wide events. */
export function tapChannel(events: EventBus, userId: string, channelId: string): RunTap {
  return tap(events, userId, (event) => event.channelId === channelId || event.channelId === null);
}

/**
 * A task session's stream: this task's own messages, runs and summary, plus account-wide events.
 * The channel's chat (another queue) never leaks into it.
 */
export function tapTask(events: EventBus, userId: string, taskId: string): RunTap {
  return tap(events, userId, (event) => event.channelId === null || belongsToTask(event, taskId));
}

export function belongsToTask(event: DuetEvent, taskId: string): boolean {
  switch (event.type) {
    case "message": return event.payload.message.taskId === taskId;
    case "status": case "typing": case "done": return event.payload.taskId === taskId;
    case "task": return event.payload.task.id === taskId;
    case "approval": return event.payload.approval.taskId === taskId;
    default: return false;
  }
}

function tap(events: EventBus, userId: string, wanted: (event: DuetEvent) => boolean): RunTap {
  const buffer: DuetEvent[] = [];
  let sink: SseSink | null = null;
  let runId: string | null = null;

  let follow: (() => string | null) | undefined;
  const deliver = (event: DuetEvent) => {
    if (!sink) return void buffer.push(event);
    sink.send(event);
    if (event.type !== "done" || event.payload.runId !== runId) return;
    const next = follow?.();
    if (next && next !== runId) runId = next;
    else sink.close();
  };
  const unsubscribe = events.subscribe(userId, (event) => {
    if (wanted(event)) deliver(event);
  });

  return {
    respond(id, opts) {
      runId = id;
      follow = opts.follow;
      return sseResponse((s) => {
        sink = s;
        const unregister = opts.session?.connections.register(opts.session.sessionId, s.close);
        for (const event of buffer.splice(0)) deliver(event);
        if (runId === null) s.close();
        return () => { unregister?.(); unsubscribe(); };
      }, opts);
    },
    stop: unsubscribe,
  };
}
