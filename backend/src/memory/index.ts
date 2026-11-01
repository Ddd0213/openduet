// M11 (backend A): the soul, the two memory layers, the memory tools and dreaming.
//
// index.ts wiring, between the `// ---- M11-A` markers:
//   const memory = createMemoryModule({ db, events, llm });
//   tasks.cards.handle("memory_note", memory.cards.memoryNote);
//   tasks.cards.handle("soul_proposal", memory.cards.soulProposal);
//   const m11a = { providers: memory.providers, routes: memory.routes, start: () => memory.start() };
import type { ToolProvider } from "../agent/types.ts";
import type { RegisterRoutes } from "../app.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import type { ModelResolver, RegisteredLlm } from "../llm/index.ts";
import { registerSoulRoutes } from "../soul/routes.ts";
import { SoulService } from "../soul/service.ts";
import type { CardHandler } from "../tasks/cards.ts";
import { actOnSoulProposal, actOnSoulSetup, undoMemoryNote } from "./cards.ts";
import { MemoryCurator, type CuratorLimits } from "./curator.ts";
import { memoryProvider } from "./provider.ts";
import { registerMemoryRoutes } from "./routes.ts";

export { MemoryCurator } from "./curator.ts";
export { readsAsInstruction } from "./filter.ts";

export interface MemoryModule {
  soul: SoulService;
  curator: MemoryCurator;
  providers: ToolProvider[];
  routes: RegisterRoutes[];
  /** for tasks.cards.handle(kind, ...) */
  cards: { memoryNote: CardHandler; soulProposal: CardHandler; soulSetup: CardHandler };
  /** registers dreaming's interval */
  start(): void;
  stop(): void;
}

export function createMemoryModule(deps: {
  db: Db;
  events: EventBus;
  /** null = no model: dreaming never runs */
  llm: RegisteredLlm | null;
  /** M12: each user's utility model from the database (wins over `llm`) */
  resolver?: ModelResolver | null;
  now?: () => Date;
  limits?: Partial<CuratorLimits>;
}): MemoryModule {
  const soul = new SoulService({ db: deps.db });
  const curator = new MemoryCurator({ db: deps.db, llm: deps.llm, ...(deps.resolver ? { resolver: deps.resolver } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.limits ? { limits: deps.limits } : {}) });
  return {
    soul,
    curator,
    providers: [memoryProvider({ db: deps.db, soul, ...(deps.now ? { now: deps.now } : {}) })],
    routes: [registerSoulRoutes(soul), registerMemoryRoutes()],
    cards: {
      memoryNote: (row, action) => undoMemoryNote({ db: deps.db, events: deps.events }, row, action),
      soulProposal: (row, action) => actOnSoulProposal({ db: deps.db, events: deps.events, soul }, row, action),
      // M22: Apply / Not now on the chat setup's card (propose_soul_setup)
      soulSetup: (row, action) => actOnSoulSetup({ db: deps.db, events: deps.events, soul }, row, action),
    },
    start: () => curator.start(),
    stop: () => curator.stop(),
  };
}
