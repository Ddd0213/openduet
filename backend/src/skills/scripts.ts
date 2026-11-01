// run_skill_script (M11): a skill folder is copied to /workspace/.skills/<name>/ on the assistant's
// computer and one of its scripts runs there (python3 / node / bash by extension, <= 300 s).
// Scripts of a skill that came from outside (github, zip, or the assistant's own proposal) ask the user
// once per version: an approval card (kind action) that says it allows the scripts of
// /<name> v<N>, and approving it sets approvedVersion = version and runs the script. Manual
// skills (the user wrote them) run without a card. Scripts run as ./<path> (never an interpreter
// option). A background build can't ask, so there it's refused. Approved results reach the model
// on the user's next turn (instructions), like OpenDuet's computer does.
import type { Skill as SkillRow } from "@prisma/client";
import { z } from "zod";
import type { TurnInput } from "../agent/types.ts";
import { askNote } from "../approvals/gate.ts";
import { buildPreview } from "../approvals/preview.ts";
import type { ApprovalService, LocalExecutor } from "../approvals/service.ts";
import { shellQuote } from "../computer/paths.ts";
import type { Workspace } from "../computer/workspace.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import type { SkillService } from "./service.ts";

/** Approval.toolSlug of a skill script's first run (one executor for every skill). */
export const SKILL_SCRIPT_SLUG = "duet:run_skill_script";
const TIMEOUT_MS = 300_000;
const OUTPUT_MAX = 16_000;
const APPROVED_KEEP = 5;
const APPROVED_TTL_MS = 6 * 60 * 60_000;
const INTERPRETERS: Record<string, string> = { py: "python3", js: "node", mjs: "node", cjs: "node", sh: "bash" };

export const ScriptArgs = z.array(z.string().max(2000)).max(20);
const StoredCall = z.object({ skillId: z.string().min(1), name: z.string(), version: z.number().int(), path: z.string().min(1), args: ScriptArgs }).strict();

export const interpreterOf = (path: string): string | null => INTERPRETERS[path.split(".").pop()?.toLowerCase() ?? ""] ?? null;

/** github / zip / assistant skills ask before a version's first run; manual ones never do. */
export const needsApproval = (row: Pick<SkillRow, "source" | "version" | "approvedVersion">) => row.source !== "manual" && row.version > row.approvedVersion;

const clipTail = (text: string) => (text.length <= OUTPUT_MAX ? text : `…${text.slice(-OUTPUT_MAX)}`);

export interface ScriptDeps { workspace: Workspace | null; approvals: ApprovalService | null }

export type ScriptReply = { data: Record<string, unknown>; isError: boolean };

export class SkillScripts {
  private deps: ScriptDeps = { workspace: null, approvals: null };
  /** results of approved runs, told to the model on the user's next turn */
  private readonly approved = new Map<string, { approvalId: string; skill: string; path: string; at: number; result: unknown }[]>();

  constructor(private readonly db: Db, private readonly skills: SkillService) {}

  configure(deps: Partial<ScriptDeps>): void {
    this.deps = { ...this.deps, ...deps };
  }

  /** Whether run_skill_script is offered to this user (OpenDuet's computer is set up and theirs). */
  async available(userId: string): Promise<boolean> {
    const workspace = this.deps.workspace;
    if (!workspace?.configured) return false;
    return workspace.allows ? workspace.allows(userId).catch(() => false) : true;
  }

  /** The tool call: checks the skill and the script, asks first when this version hasn't been approved. */
  async request(input: TurnInput, skill: SkillRow, path: string, args: string[]): Promise<ScriptReply> {
    if (!(await this.available(input.userId))) return { data: { error: "OpenDuet's computer isn't set up, so skill scripts can't run here." }, isError: true };
    const file = await this.db.skillFile.findUnique({ where: { skillId_path: { skillId: skill.id, path } }, select: { path: true } });
    if (!file) return { data: { error: `${skill.name} has no file ${path}. use_skill lists its files.` }, isError: true };
    if (!interpreterOf(path)) return { data: { error: "Only .py, .js, .mjs, .cjs and .sh scripts can run." }, isError: true };
    if (needsApproval(skill)) {
      if ((input.kind ?? (input.taskId ? "task" : "chat")) === "build") {
        return { data: { error: "This skill's script needs the user's OK the first time, and nobody is here to give it in a background build." }, isError: true };
      }
      const approvals = this.deps.approvals;
      if (!approvals) return { data: { error: "This needs the user's approval, and approvals aren't available here." }, isError: true };
      const stored = { skillId: skill.id, name: skill.name, version: skill.version, path, args };
      const from = skill.source === "assistant" ? "OpenDuet" : skill.source === "zip" ? "a zip" : skill.source === "upload" ? "an upload" : "GitHub";
      // Approving covers the whole version (needsApproval), not just this script: the card says so.
      const { kind, preview } = buildPreview({
        kind: "action", app: `/${skill.name}`, toolName: "Run a skill script",
        args: {
          skill: `/${skill.name} v${skill.version}`, script: path, arguments: args.join(" ") || "",
          allows: `Scripts of /${skill.name} v${skill.version} (first run of this version), a skill from ${from}: later runs of any of its scripts won't ask again until the skill changes`,
        },
      });
      // M20: through approvals.ask(), so the same script still waiting or just declined posts no second card.
      const outcome = await approvals.ask({ userId: input.userId, channelId: input.channelId, taskId: input.taskId, sink: input.sink, slug: SKILL_SCRIPT_SLUG, args: stored, kind, preview });
      if (outcome.status === "allowed") return this.run(input.userId, skill, path, args, input.runId);
      if (outcome.status !== "created") return { data: askNote(outcome), isError: false };
      return {
        data: { status: "awaiting_approval", approvalId: outcome.approval.id, note: `The first run of this skill version needs the user's OK: it's an approval card, and approving it allows the scripts of /${skill.name} v${skill.version}. It runs only when they approve, and you'll see the result on your next turn. Don't ask again in text.` },
        isError: false,
      };
    }
    return this.run(input.userId, skill, path, args, input.runId);
  }

  /** Copies the folder to .skills/<name>/ and runs the script there. */
  private async run(userId: string, skill: SkillRow, path: string, args: string[], runId?: string): Promise<ScriptReply> {
    const workspace = this.deps.workspace;
    if (!workspace?.configured) return { data: { error: "OpenDuet's computer isn't set up." }, isError: true };
    const interpreter = interpreterOf(path)!;
    const dir = `.skills/${skill.name}`;
    try {
      for (const file of await this.skills.folder(skill)) await workspace.writeFile(userId, `${dir}/${file.path}`, file.bytes, runId ? { runId } : {});
      // "./": a stored path like "--require=x.js" is a file, never an interpreter option.
      const command = [interpreter, shellQuote(`./${path}`), ...args.map(shellQuote)].join(" ");
      const result = await workspace.exec(userId, command, { cwd: dir, timeoutMs: TIMEOUT_MS, ...(runId ? { runId } : {}) });
      return {
        data: { status: "ran", skill: `/${skill.name}`, script: path, folder: `/workspace/${dir}`, exitCode: result.exitCode, stdout: clipTail(result.stdout), stderr: clipTail(result.stderr) },
        isError: false,
      };
    } catch (error) {
      log.warn("skill script failed", { skillId: skill.id, error: { name: (error as Error)?.name ?? "Error" } });
      return { data: { error: "The script couldn't run on OpenDuet's computer. Try again in a moment." }, isError: true };
    }
  }

  /** ApprovalService executor: the approved version only (a newer version asks again). */
  readonly executeApproved: LocalExecutor = async (call) => {
    const parsed = StoredCall.safeParse(call.args);
    if (!parsed.success) return { ok: false, error: "This request isn't valid any more." };
    const { skillId, version, path, args } = parsed.data;
    const skill = await this.db.skill.findFirst({ where: { id: skillId, userId: call.userId } });
    if (!skill) return { ok: false, error: "This skill was deleted." };
    if (skill.version !== version) return { ok: false, error: "This skill changed since the card was made. Ask OpenDuet to run it again." };
    const file = await this.db.skillFile.findUnique({ where: { skillId_path: { skillId, path } }, select: { path: true } });
    if (!file || !interpreterOf(path)) return { ok: false, error: "This script isn't in the skill any more." };
    if (!this.deps.workspace?.configured) return { ok: false, error: "OpenDuet's computer isn't set up." };
    await this.db.skill.updateMany({ where: { id: skill.id, userId: call.userId, approvedVersion: { lt: version } }, data: { approvedVersion: version } });
    const reply = await this.run(call.userId, skill, path, args);
    if (reply.isError) return { ok: false, error: String(reply.data.error ?? "The script couldn't run.") };
    const list = (this.approved.get(call.userId) ?? []).filter((r) => r.approvalId !== call.approvalId);
    list.push({ approvalId: call.approvalId, skill: `/${skill.name}`, path, at: Date.now(), result: reply.data });
    this.approved.set(call.userId, list.slice(-APPROVED_KEEP));
    return { ok: true, output: reply.data };
  };

  /** Approved runs since the user's last turn (data for the model), told once. */
  takeApproved(userId: string): { approvalId: string; skill: string; path: string; result: unknown }[] {
    const list = (this.approved.get(userId) ?? []).filter((r) => Date.now() - r.at < APPROVED_TTL_MS);
    this.approved.delete(userId);
    return list.map(({ approvalId, skill, path, result }) => ({ approvalId, skill, path, result }));
  }
}
