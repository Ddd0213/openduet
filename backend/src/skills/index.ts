// Skills (M6 backend B, L156; M11 Agent Skills folders): /api/skills (+ PATCH, files, export,
// GitHub / zip import), propose_skill, use_skill / read_skill_file / run_skill_script, the
// skill_proposal card's buttons and /<name> injection.
//
// index.ts wiring (owned by the main agent), after createTasks:
//   const skills = createSkills({ db, events, cards: tasks.cards });
//   providers.push(...skills.providers);  routes: [...skills.routes]
// M11 (index.ts M11-B block): skills.configure({ workspace, approvals }) once those exist; it also
// registers the script approval's executor.
import type { ToolProvider } from "../agent/types.ts";
import type { RegisterRoutes } from "../app.ts";
import type { ApprovalService } from "../approvals/service.ts";
import type { Workspace } from "../computer/workspace.ts";
import type { NetDeps } from "../custom-connectors/net.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { registerSkillRoutes } from "../routes/skills.ts";
import type { CardActions } from "../tasks/cards.ts";
import type { AccessService } from "../access/service.ts";
import { skillProvider } from "./provider.ts";
import { SKILL_SCRIPT_SLUG, SkillScripts } from "./scripts.ts";
import { SkillService } from "./service.ts";

export { SkillService } from "./service.ts";
export { SKILL_SCRIPT_SLUG } from "./scripts.ts";

export interface Skills {
  service: SkillService;
  scripts: SkillScripts;
  providers: ToolProvider[];
  routes: RegisterRoutes[];
  /** OpenDuet's computer and approvals for run_skill_script (built after the skills module). */
  configure(deps: { workspace?: Workspace | null; approvals?: ApprovalService | null }): void;
}

export function createSkills(deps: { db: Db; events: EventBus; cards: CardActions; access?: AccessService; net?: NetDeps }): Skills {
  const service = new SkillService({ db: deps.db, events: deps.events, ...(deps.access ? { access: deps.access } : {}) });
  const scripts = new SkillScripts(deps.db, service);
  deps.cards.handle("skill_proposal", (row, action) => service.act(row, action));
  return {
    service, scripts,
    providers: [skillProvider(service, scripts)],
    routes: [registerSkillRoutes(service, deps.net ? { net: deps.net } : {})],
    configure(next) {
      scripts.configure({
        ...(next.workspace !== undefined ? { workspace: next.workspace } : {}),
        ...(next.approvals !== undefined ? { approvals: next.approvals } : {}),
      });
      if (next.approvals) next.approvals.registerExecutor(SKILL_SCRIPT_SLUG, scripts.executeApproved);
    },
  };
}
