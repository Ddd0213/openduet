// POST /api/feedback: Good / Bad on a response, or "Send feedback" from the profile sheet (L128).
// Thanks the user with a grey system line in the rated message's thread (main thread otherwise).
import type { Handler } from "hono";
import type { AppEnv } from "../app.ts";
import { FeedbackRequest } from "../contract/messages.ts";
import { HttpError, readJson } from "../http.ts";
import { loadMessage } from "../runs/serialize.ts";

export const sendFeedback: Handler<AppEnv> = async (c) => {
  const input = await readJson(c, FeedbackRequest);
  if (input.rating === null && input.text.trim() === "") {
    throw new HttpError(400, "validation_failed", "text: rating or text is required", "text");
  }
  const { db, events } = c.get("deps");
  const user = c.get("user");
  let thread: { channelId: string; taskId: string | null };
  if (input.messageId !== null) {
    const rated = await db.message.findFirst({ where: { id: input.messageId, userId: user.id }, select: { channelId: true, taskId: true } });
    if (!rated) throw new HttpError(404, "not_found", "Not found.");
    thread = rated;
  } else {
    const main = await db.channel.findFirst({ where: { userId: user.id, isMain: true }, select: { id: true } });
    if (!main) throw new HttpError(500, "internal", "Something went wrong.");
    thread = { channelId: main.id, taskId: null };
  }
  await db.feedback.create({ data: { userId: user.id, messageId: input.messageId, rating: input.rating, text: input.text } });
  const line = await db.message.create({
    data: { userId: user.id, channelId: thread.channelId, taskId: thread.taskId, role: "system", kind: "system", text: "", payload: JSON.stringify({ phrase: { key: "system.feedback_thanks" } }) },
  });
  const message = await loadMessage(db, line.id);
  if (message) await events.emit(user.id, thread.channelId, "message", { message });
  return c.body(null, 204);
};
