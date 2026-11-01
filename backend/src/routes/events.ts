// GET /api/events: the app's background stream (L73). Subscribe first and hold live events, replay
// what was missed since Last-Event-ID / ?since=, then release the held events skipping ids
// already sent, so a reconnect neither loses nor repeats anything.
//
// M21: this stream (and only this one, not the POST /messages answer) marks the user online for
// push delivery (EventBus.present). A reconnect that would replay more than RESYNC_REPLAY_LIMIT
// events, or whose Last-Event-ID is older than what is kept, gets one `resync` envelope instead
// (never stored; its id is the newest stored event, the app's new cursor), then live events
// continue on the same stream (docs/API.md M21).
import type { Handler } from "hono";
import type { AppEnv } from "../app.ts";
import { DuetEvent } from "../contract/events.ts";
import { resumeFrom } from "../events/bus.ts";
import { sseResponse } from "../events/sse.ts";
import { RESYNC_REPLAY_LIMIT } from "../contract/m21.ts";

export const streamEvents: Handler<AppEnv> = (c) => {
  const { events, heartbeatMs, connections } = c.get("deps");
  const userId = c.get("user").id;
  const since = resumeFrom(c.req.header("Last-Event-ID"), c.req.query("since"));
  return sseResponse(async (sink) => {
    const held: DuetEvent[] = [];
    let live = false;
    let lastId = since ?? 0;
    const send = (event: DuetEvent) => {
      if (event.id <= lastId) return;
      lastId = event.id;
      sink.send(event);
    };
    const unsubscribe = events.subscribe(userId, (event) => (live ? send(event) : held.push(event)));
    const release = events.present(userId);
    const unregister = connections.register(c.get("session").id, sink.close);
    const stop = () => {
      unsubscribe();
      release();
      unregister();
    };
    try {
      if (since !== null) {
        const plan = await events.resumePlan(userId, since);
        if (plan.kind === "resync") {
          // Sent as is (its id may be below a cursor from a restored database); held events newer
          // than it follow, older ones are covered by the app's reload.
          sink.send(DuetEvent.parse({ id: plan.id, type: "resync", channelId: null, createdAt: new Date().toISOString(), payload: { reason: plan.reason } }));
          lastId = plan.id;
        } else {
          // Capped: anything after the first RESYNC_REPLAY_LIMIT was stored after the plan, so it's held.
          for await (const page of events.replayAll(userId, since, RESYNC_REPLAY_LIMIT)) {
            if (sink.closed) break;
            for (const event of page) send(event);
          }
        }
      }
    } catch (error) {
      stop();
      throw error;
    }
    for (const event of held.splice(0)) send(event);
    live = true;
    return stop;
  }, { heartbeatMs, signal: c.req.raw.signal });
};
