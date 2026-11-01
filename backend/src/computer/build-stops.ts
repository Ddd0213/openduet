// M20 (the 09:54 incident): why a Make build's turn stopped, when the computer knows better than
// "didn't finish". The computer provider notes it when a build gives up waiting for the user to
// hand the browser back; the artifact service takes it once when the run settles and fails the
// build with that reason (artifact.user_in_control) instead of the generic artifact.not_finished.
// In memory, by run id (unique), small and capped: a missed entry only means the generic reason.

export type BuildStop = "user_in_control";

const MAX = 200;
const stops = new Map<string, BuildStop>();

/** A build run stopped for this reason (computer provider). */
export function noteBuildStop(runId: string, reason: BuildStop): void {
  if (stops.size >= MAX) stops.delete(stops.keys().next().value as string);
  stops.set(runId, reason);
}

/** Why this build run stopped, once (artifact service, when the run settles); null = nothing known. */
export function takeBuildStop(runId: string): BuildStop | null {
  const reason = stops.get(runId) ?? null;
  stops.delete(runId);
  return reason;
}
