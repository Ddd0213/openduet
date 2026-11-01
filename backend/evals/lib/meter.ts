// Counts model calls: every llm.stream() the resolver's model makes (one per round of a turn) and
// every HTTP request to the provider (retries included). With a cap, the call past it throws
// before anything is sent: that turn fails ("model unreachable") and the runner stops.
import type { Fetch, LlmOptions, ModelConfig, RegisteredLlm } from "../../src/llm/index.ts";
import { createLlm } from "../../src/llm/index.ts";

export class BudgetExceeded extends Error {
  constructor(max: number) { super(`Model call budget reached (${max})`); this.name = "BudgetExceeded"; }
}

export class ModelMeter {
  calls = 0;
  requests = 0;
  /** calls since the last beginTurn() */
  turnCalls = 0;
  exhausted = false;

  constructor(readonly max: number | null) {}

  beginTurn(): void {
    this.turnCalls = 0;
  }

  /** The resolver's buildLlm: production createLlm, with each stream() counted (and capped). */
  readonly buildLlm = (config: ModelConfig, opts: LlmOptions): RegisteredLlm => {
    const inner = createLlm(config, opts);
    return {
      models: inner.models,
      roleModels: (role) => inner.roleModels(role),
      stream: (request) => {
        if (this.max !== null && this.calls >= this.max) {
          this.exhausted = true;
          throw new BudgetExceeded(this.max);
        }
        this.calls++;
        this.turnCalls++;
        return inner.stream(request);
      },
    };
  };

  /** The fetch the model layer uses (the real one), counting requests. */
  readonly fetch: Fetch = (input, init) => {
    this.requests++;
    return fetch(input, init);
  };
}
