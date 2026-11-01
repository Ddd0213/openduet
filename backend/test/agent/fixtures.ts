import { Message } from "../../src/contract/messages.ts";
import type { StatusKey } from "../../src/contract/common.ts";
import type { Db } from "../../src/db.ts";
import type { MessageDraft, TurnInput, TurnSink } from "../../src/agent/types.ts";
import type { LlmEvent, ToolResultBlock } from "../../src/llm/index.ts";

export const now = () => new Date("2030-10-25T08:00:00.000Z");
export const text = (value: string): LlmEvent => ({ type: "text_delta", text: value });
export const call = (name: string, input: Record<string, unknown>, id: string = crypto.randomUUID()): LlmEvent => ({ type: "tool_call", id, name, input });
export const toolData = (block: ToolResultBlock): unknown => JSON.parse(block.content[0]?.type === "text" ? block.content[0].text : "null");

export function recordingSink(channelId = "test", taskId: string | null = null) {
  const statuses: (StatusKey | null)[] = [], typing: boolean[] = [];
  const updates: { draft: MessageDraft; at: number; id: string }[] = [];
  const messages = new Map<string, Message>();
  const sink: TurnSink = {
    async status(value) { statuses.push(value); },
    async typing(value) { typing.push(value); },
    async upsertMessage(draft) {
      const id = draft.id ?? crypto.randomUUID(), at = performance.now();
      updates.push({ draft: structuredClone(draft), at, id });
      const payload = draft.kind === "text" ? { skill: null, attachments: [] } : draft.kind === "quick_replies" ? { ...draft.payload, chosen: null } : draft.payload;
      const message = Message.parse({ id, channelId, taskId, role: draft.role, kind: draft.kind, text: "text" in draft ? draft.text ?? "" : "", status: "sent", clientId: null, reactions: [], createdAt: now().toISOString(), updatedAt: now().toISOString(), payload });
      messages.set(id, message); return message;
    },
  };
  return { sink, statuses, typing, updates, messages };
}

export async function turnFixture(db: Db, task = false) {
  const userId = crypto.randomUUID();
  await db.user.create({ data: { id: userId, name: "林思远", firstName: "思远", username: userId, authEmail: `${userId}@test.invalid`, language: "zh-Hans", timezone: "Asia/Shanghai" } });
  const channel = await db.channel.create({ data: { userId, isMain: !task, name: "发布", purpose: "准备发布评审" } });
  const taskId = task ? (await db.task.create({ data: { userId, channelId: channel.id, title: "发布" } })).id : null;
  const row = await db.message.create({ data: { userId, channelId: channel.id, taskId, role: "user", text: "帮我看看", payload: JSON.stringify({ skill: null, attachments: [] }), createdAt: now() } });
  const userMessage = Message.parse({ ...row, payload: JSON.parse(row.payload), reactions: [], createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
  const recording = recordingSink(channel.id, taskId);
  const input: TurnInput = { userId, channelId: channel.id, taskId, runId: crypto.randomUUID(), userMessage, attachments: [], skill: null, sink: recording.sink, signal: new AbortController().signal };
  return { input, recording };
}
