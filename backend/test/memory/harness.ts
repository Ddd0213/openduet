// Test-only harness for the M11-A tests (soul, memory layers, memory tools): the real agent runtime
// + run host + tasks (card actions) + the memory module, wired like index.ts's M11-A block, on a
// role-scripted model. No server, no network.
import type { Channel as ChannelRow } from "@prisma/client";
import { registerAccountRoutes } from "../../src/account/routes.ts";
import type { ToolProvider } from "../../src/agent/types.ts";
import { actOnSoulSetup } from "../../src/memory/cards.ts";
import { createMemoryModule, type MemoryModule } from "../../src/memory/index.ts";
import type { Message } from "../../src/contract/messages.ts";
import { createTestApp, type TestApp } from "../helpers/app.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse, type SseFrames } from "../helpers/sse.ts";
import { json, messagesOf, rig, RoleScriptedLlm } from "../tasks/harness.ts";

export { call, json, messagesOf, text } from "../tasks/harness.ts";

export interface MemoryApp {
  fixture: TestApp;
  llm: RoleScriptedLlm;
  memory: MemoryModule;
  alex: SignedIn;
}

export async function startMemoryApp(opts: { extraProviders?: ToolProvider[] } = {}): Promise<MemoryApp> {
  const llm = new RoleScriptedLlm();
  let memory: MemoryModule | undefined;
  const fixture = await createTestApp({}, {
    heartbeatMs: 1000,
    setup: (core) => {
      const built = rig(core, llm);
      memory = createMemoryModule({ db: core.db, events: core.events, llm });
      built.tasks.cards.handle("memory_note", memory.cards.memoryNote);
      built.tasks.cards.handle("soul_proposal", memory.cards.soulProposal);
      // M22: as index.ts registers it (memory/index.ts has no soulSetup entry yet; see the W5 report).
      const soul = memory.soul;
      built.tasks.cards.handle("soul_setup", (row, action) => actOnSoulSetup({ db: core.db, events: core.events, soul }, row, action));
      built.providers.push(...memory.providers, ...(opts.extraProviders ?? []));
      return { agent: built.agent, runs: built.runs, routes: [...built.tasks.routes, ...memory.routes, registerAccountRoutes()] };
    },
  });
  const alex = await signUp(fixture, "alex");
  return { fixture, llm, memory: memory!, alex };
}

/** A non-main channel of the user, written straight to the database (channel create is B's). */
export function channelOf(m: MemoryApp, user: SignedIn, data: { name: string; purpose?: string; useSharedMemory?: boolean; soulExtra?: string; archived?: boolean }): Promise<ChannelRow> {
  return m.fixture.db.channel.create({ data: { userId: user.userId, isMain: false, purpose: "", ...data } });
}

/** A chat message from `user` in `channelId` (default: their main thread), read until the turn's `done`. */
export async function chatIn(m: MemoryApp, body: string, clientId: string, opts: { user?: SignedIn; channelId?: string } = {}): Promise<SseFrames> {
  const user = opts.user ?? m.alex;
  const channelId = opts.channelId ?? user.mainChannelId;
  return readSse(await m.fixture.app.request(`/api/channels/${channelId}/messages`, json(user, "POST", { text: body, clientId })), {
    until: (frames) => frames.events.some((e) => e.type === "done"),
  });
}

/** The system prompt of the latest chat-role model call. */
export function lastSystem(m: MemoryApp): string {
  const system = m.llm.sent("chat").at(-1)?.system;
  if (system === undefined) throw new Error("no chat request");
  return system;
}

/** The latest message of a kind in a turn's frames. */
export function cardOf<K extends Message["kind"]>(frames: SseFrames, kind: K): Extract<Message, { kind: K }> {
  const found = messagesOf(frames).filter((x): x is Extract<Message, { kind: K }> => x.kind === kind).at(-1);
  if (!found) throw new Error(`no ${kind} card`);
  return found;
}

/** POST /api/messages/:id/action */
export function act(m: MemoryApp, messageId: string, action: string, user: SignedIn = m.alex) {
  return m.fixture.app.request(`/api/messages/${messageId}/action`, json(user, "POST", { action }));
}
