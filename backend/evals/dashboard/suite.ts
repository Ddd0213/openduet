// Real chat -> real Make build -> real task, with no build/task model stubs.
import { createHash } from "node:crypto";
import { Session, TURN_TIMEOUT_MS } from "../lib/session.ts";
import type { Suite } from "../lib/suite.ts";
import { table } from "../lib/output.ts";
import type { ToolEvent } from "../score/types.ts";
import { UpdateArtifactDataResult } from "../../src/contract/m27.ts";
import { BATCHES } from "./fixtures.ts";
import { scoreDashboard } from "./score.ts";

export const dashboard: Suite = {
  id: "dashboard", calls: "one build + three task batches, at most 80", skip: async () => null,
  async run(env, opts) {
    env.agent.setStubbedKinds(new Set()); env.computer.enableFileStore(true);
    const results = [];
    try {
      for (let repeat = 1; repeat <= opts.repeat && !env.meter.exhausted; repeat++) {
        await env.tidy(); env.computer.files.clear();
        const session = await Session.fresh(env, "en");
        const build = await session.say("Make a dashboard of the links we collect: total, per category, the latest 5. Start empty: total 0, categories [{name: 'AI', count: 0}, {name: 'Programming', count: 0}, {name: 'Other', count: 0}], recent []. We'll collect links in a task later. Keep recent in oldest-to-newest order, with title, url and category. Do not start a collection task yet.");
        const initial = await env.db.artifact.findFirst({ where: { userId: env.user.id, type: "dashboard", status: "ready" }, orderBy: { createdAt: "desc" } });
        let taskId: string | null = null, taskCompleted = false;
        if (initial) {
          for (const [index, batch] of BATCHES.entries()) env.computer.files.set(`links/batch-${index + 1}.json`, JSON.stringify(batch, null, 2));
          const task = await env.tasks.service.create({ userId: env.user.id, channelId: session.channelId, title: "Collect links in three batches", prompt: `Collect the links from /workspace/links/batch-1.json, batch-2.json and batch-3.json in that order using computer_files_read. These fixtures are the collected links; their category field is authoritative. After EACH batch, update the existing dashboard ${initial.id} once via update_artifact_data before reading the next batch. Call read_artifact first and pass expectedVersion. Add each batch to total and the categories array's counts (AI, Programming, Other); keep the latest 5 links in recent, oldest-to-newest, with title, url and category. Do not refresh_artifact or edit_artifact or make another dashboard or build. Finish the task after the third saved update.` });
          taskId = task.id;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const idle = await Promise.race([env.runs.idle().then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), TURN_TIMEOUT_MS); })]);
            if (!idle) { await env.runs.cancel({ userId: env.user.id, channelId: session.channelId, taskId }); await env.runs.idle(); }
            taskCompleted = idle;
          } finally { clearTimeout(timer); }
        }
        const runs = await env.db.run.findMany({ where: { userId: env.user.id }, orderBy: { createdAt: "asc" } });
        const logs = runs.map(run => env.agent.log(run.id)).filter(log => log !== undefined);
        const calls = logs.flatMap(log => log.timeline.filter((event): event is ToolEvent => event.type === "tool"));
        const savedUpdates = calls.filter(call => {
          if (call.name !== "update_artifact_data" || !call.ok || !call.output) return false;
          try { const result = UpdateArtifactDataResult.parse(JSON.parse(call.output)); return "status" in result && result.status === "updated"; } catch { return false; }
        }).length;
        const final = initial ? await env.db.artifact.findUnique({ where: { id: initial.id } }) : null;
        const score = scoreDashboard({ buildRuns: runs.filter(run => run.kind === "build").length, savedUpdates, calls,
          before: initial ? { html: initial.html, pageUpdatedAt: initial.updatedAt.toISOString() } : null,
          after: final ? { html: final.html, pageUpdatedAt: final.updatedAt.toISOString(), dataVersion: final.dataVersion, data: final.data ? JSON.parse(final.data) : null } : null });
        results.push({ repeat, ...score, buildStatus: build.status, taskId, taskCompleted, savedUpdates,
          htmlHashBefore: initial ? createHash("sha256").update(initial.html).digest("hex") : null,
          htmlHashAfter: final ? createHash("sha256").update(final.html).digest("hex") : null,
          runs: runs.map(run => ({ id: run.id, kind: run.kind, status: run.status })), logs });
        process.stderr.write(`  dashboard three-batches: ${score.pass ? "pass" : "FAIL"} (${savedUpdates} saved updates)\n`);
      }
    } finally { env.agent.setStubbedKinds(new Set(["build", "task", "routine"])); env.computer.enableFileStore(false); env.computer.files.clear(); }
    const pass = results.length === opts.repeat && results.every(result => result.pass);
    return { pass, summary: `dashboard: ${results.filter(result => result.pass).length}/${results.length} → ${pass ? "PASS" : "FAIL"}`,
      json: { results }, markdown: table(["repeat", "check", "result", "actual"], results.flatMap(result => result.checks.map(check => [String(result.repeat), check.name, check.pass ? "PASS" : "FAIL", JSON.stringify(check.actual)]))) };
  },
};
