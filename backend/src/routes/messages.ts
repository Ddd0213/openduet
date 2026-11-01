// POST /api/channels/:id/messages: answers with SSE until this run's `done` (L73). Validation and
// usage errors are plain JSON (4xx) because the stream only starts once the message is stored.
import type { Handler } from "hono";
import type { AppEnv } from "../app.ts";
import { SendMessageRequest } from "../contract/messages.ts";
import { readJson } from "../http.ts";
import { tapChannel } from "../runs/stream.ts";
import { ownChannel } from "./channels.ts";

export const sendMessage: Handler<AppEnv> = async (c) => {
  const channel = await ownChannel(c);
  const input = await readJson(c, SendMessageRequest);
  const { events, runs, heartbeatMs, connections } = c.get("deps");
  const userId = c.get("user").id;
  const tap = tapChannel(events, userId, channel.id);
  try {
    const { runId } = await runs.send({ userId, channelId: channel.id, ...input });
    return tap.respond(runId, { heartbeatMs, signal: c.req.raw.signal, session: { sessionId: c.get("session").id, connections } });
  } catch (error) {
    tap.stop();
    throw error;
  }
};
