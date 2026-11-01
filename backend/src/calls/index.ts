// M13: realtime voice calls (contract .pi/handoff/m13-contract.md). The phone talks to Gemini Live
// or StepFun Realtime directly; this module owns the call: credentials, instructions, the voice's
// four tools, the transcript, hand-offs to the assistant, cues back to the phone, the call's one line in
// the chat and the 2 h sweep.
//
// index.ts wiring (after the run host and the models module):
//   const calls = createCallsModule({ db, events, runs, realtime: modelsModule.realtime, resolver: modelsModule.resolver });
//   createApp({ routes: [...calls.routes, ...] });  await calls.start();  ...  calls.stop() on shutdown
import type { RegisterRoutes } from "../app.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import type { Fetch, ModelResolver } from "../llm/index.ts";
import { log } from "../log.ts";
import type { RealtimeModels } from "../models/realtime.ts";
import type { RunHost } from "../runs/host.ts";
import { CallCues } from "./cues.ts";
import { Dictation } from "./dictation.ts";
import { registerCallRoutes } from "./routes.ts";
import { CallService } from "./service.ts";

export { CallService } from "./service.ts";
export { CallCues } from "./cues.ts";

/** How often the sweep looks for calls idle for 2 h. */
export const SWEEP_EVERY_MS = 10 * 60_000;

export interface CallsModuleDeps {
  db: Db;
  events: EventBus;
  runs: Pick<RunHost, "send" | "stop" | "busy" | "releaseCall" | "kindOf">;
  realtime: RealtimeModels;
  resolver: ModelResolver | null;
  /** tests: the Gemini token mint's network, a clock and the cue timings */
  fetch?: Fetch;
  now?: () => Date;
  progressGapMs?: number;
  idleMs?: number;
  sweepIdleMs?: number;
  handoffGraceMs?: number;
}

export interface CallsModule {
  service: CallService;
  cues: CallCues;
  routes: RegisterRoutes[];
  /** the cue watcher (watching calls left open by a restart) and the sweep's interval */
  start(): Promise<void>;
  stop(): void;
}

export function createCallsModule(deps: CallsModuleDeps): CallsModule {
  const now = deps.now ?? (() => new Date());
  const cues = new CallCues({
    db: deps.db, events: deps.events, now: () => now().getTime(), kindOf: (runId) => deps.runs.kindOf(runId),
    ...(deps.progressGapMs !== undefined ? { progressGapMs: deps.progressGapMs } : {}),
    ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
  });
  const service = new CallService({
    db: deps.db, events: deps.events, runs: deps.runs, realtime: deps.realtime, resolver: deps.resolver, cues,
    fetch: deps.fetch ?? fetch, now, ...(deps.sweepIdleMs !== undefined ? { sweepIdleMs: deps.sweepIdleMs } : {}),
    ...(deps.handoffGraceMs !== undefined ? { handoffGraceMs: deps.handoffGraceMs } : {}),
  });
  cues.start();
  let timer: ReturnType<typeof setInterval> | null = null;
  const sweep = () => void service.sweep().then((n) => {
    if (n > 0) log.info("idle calls ended", { calls: n });
  }).catch((error: unknown) => log.warn("call sweep failed", { error: { name: (error as Error).name } }));
  return {
    service, cues,
    routes: [registerCallRoutes(service, new Dictation({ db: deps.db, realtime: deps.realtime, fetch: deps.fetch ?? fetch }))],
    start: async () => {
      await service.resumeWatching();
      sweep();
      timer ??= setInterval(sweep, SWEEP_EVERY_MS);
      (timer as { unref?: () => void }).unref?.();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
      cues.stop();
      service.handoffs.stop();
    },
  };
}
