// Make (M6 backend B): artifacts, their builds on OpenDuet's computer, refresh schedules, make_artifact.
//
// index.ts wiring (owned by the main agent), after the run host and `computer` (backend A):
//   const artifacts = createArtifacts({ db, events, runs, usage, workspace: computer.workspace, notify });  // M29: notify
//   providers.push(...artifacts.providers);
//   await artifacts.service.recoverAfterRestart();   // BEFORE runs.recoverStaleRuns()
//   routes: [...artifacts.routes]
//   after listen: artifacts.service.start();  on shutdown, before runs.shutdown(): artifacts.service.stop();
import type { ToolProvider } from "../agent/types.ts";
import type { RegisterRoutes } from "../app.ts";
import { registerArtifactRoutes } from "../routes/artifacts.ts";
import { makeProvider } from "./provider.ts";
import { ArtifactService, type ArtifactDeps } from "./service.ts";

export { ArtifactService } from "./service.ts";

export interface Artifacts {
  service: ArtifactService;
  providers: ToolProvider[];
  routes: RegisterRoutes[];
}

export function createArtifacts(deps: ArtifactDeps): Artifacts {
  const service = new ArtifactService(deps);
  return { service, providers: [makeProvider(service)], routes: [registerArtifactRoutes(service)] };
}
