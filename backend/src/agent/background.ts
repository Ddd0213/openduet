// M20 seam (contract step): background turns (morning brief, check-in, scans) can only read, and
// that boundary is enforced in code, never by telling the model. Two places use it:
//  - agent/runtime.ts (W2): the tools a background turn is offered and every call it makes are
//    checked against a read-only whitelist, again right before execution; anything else is refused;
//  - connectors/provider.ts (W3): inside execute_app_tools each nested call runs only when
//    classify() says "read"; write / unknown get the refusal below, never an approval card.
// Routines are the user's own scheduled tasks: not background here, they ask as usual.
import type { RunKind, TurnInput } from "./types.ts";

export const BACKGROUND_KINDS: ReadonlySet<RunKind> = new Set<RunKind>(["brief", "checkin", "scan"]);

export function isBackgroundTurn(input: Pick<TurnInput, "kind">): boolean {
  return input.kind !== undefined && BACKGROUND_KINDS.has(input.kind);
}

/** The tool result a refused background call gets (model-facing English). Nothing ran. */
export function backgroundRefusal(tool: string): Record<string, unknown> {
  return {
    status: "refused",
    tool,
    note: "Background turns can only read. Nothing was run and no card was posted. Offer it instead: add_up_next, or propose_task for the user to start.",
  };
}
