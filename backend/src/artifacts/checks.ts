// M24: evidence from this job's completed tool steps, never a model's claimed source list.
// Observe the same descriptions as RunRecorder synchronously: its DB writes are deliberately
// asynchronous, so querying RunStep inside finish_build can miss a read that just completed.
import { posix } from "node:path";
import { z } from "zod";
import type { RunSteps } from "../agent/types.ts";
import type { ToolUseBlock } from "../llm/index.ts";
import type { PageIssue } from "../make/lint.ts";
import { describeCall, describeResult } from "../runs/describe.ts";
import { Redactor } from "../runs/redact.ts";
import type { Metric } from "./service.ts";
import type { Source } from "./serialize.ts";
import { pageText } from "./text.ts";

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const readVerb = /(?:^|_)(?:get|list|read|fetch|search|query|retrieve|find|count|batch_get)(?:_|$)/i;
const writeVerb = /(?:^|_)(?:create|update|delete|send|write|remove|insert|patch|post|modify)(?:_|$)/i;
const urls = (text: string) => (text.match(/https?:\/\/[^\s<>"\\]+/g) ?? []).flatMap(raw => {
  try { const url = new URL(raw); url.hash = ""; return [url.href]; } catch { return []; }
});
const fileNames = (text: string) => {
  try {
    const input = JSON.parse(text) as { path?: unknown };
    if (typeof input.path !== "string") return [];
    const path = posix.normalize(input.path.replace(/^\/workspace\//, ""));
    return [path, posix.basename(path)];
  } catch { return []; }
};
const LinkResult = z.object({ url: z.string().optional(), results: z.array(z.object({ url: z.string().optional() })).optional() });

export class BuildEvidence {
  private readonly apps = new Set<string>();
  private readonly links = new Set<string>();
  private readonly files = new Set<string>();

  steps(raw?: RunSteps): RunSteps {
    const calls = new Map<string, ToolUseBlock>();
    return {
      text: delta => raw?.text(delta), thinking: delta => raw?.thinking(delta), endRound: () => raw?.endRound(),
      toolStart: call => {
        const handle = raw?.toolStart(call) ?? crypto.randomUUID();
        calls.set(handle, call);
        return handle;
      },
      toolEnd: (handle, result) => {
        raw?.toolEnd(handle, result);
        const call = calls.get(handle);
        calls.delete(handle);
        if (!call || typeof result === "string" || result.isError) return;
        const redact = new Redactor([]);
        const outcome = describeResult(call, result, redact);
        const records = outcome.nested ?? [{ ...describeCall(call, redact), ...outcome }];
        for (const step of records) {
          if (step.status !== "ok" || !(readVerb.test(step.tool) || step.tool === "computer_navigate") || writeVerb.test(step.tool)) continue;
          if (step.app && !step.tool.startsWith("computer_")) this.apps.add(normalize(step.app));
          if (["web_fetch", "web_search", "computer_read", "computer_navigate"].includes(step.tool)) {
            // URL metadata only. URLs mentioned in the page body or search query are not reads.
            try {
              const parsed = LinkResult.safeParse(JSON.parse(result.content.filter(p => p.type === "text").map(p => p.text).join("")));
              if (parsed.success) {
                const links = [parsed.data.url, ...(parsed.data.results ?? []).map(r => r.url)];
                if (step.tool === "web_fetch" || step.tool === "computer_navigate") links.push(typeof call.input.url === "string" ? call.input.url : undefined);
                for (const link of links) if (link) for (const url of urls(link)) this.links.add(url);
              }
            } catch { /* unreadable result metadata proves no URL */ }
          }
          if (step.tool === "computer_files_read") {
            // Reading the generated page is not reading a source of fresh data.
            const paths = fileNames(step.input ?? "");
            if (!paths.some(p => /^artifacts\//.test(p))) for (const path of paths) this.files.add(path);
          }
        }
      },
    };
  }

  checked(source: Source): boolean {
    if (source.app) return this.apps.has(normalize(source.app));
    const claimed = urls(`${source.name} ${source.detail}`);
    if (claimed.some(url => this.links.has(url))) return true;
    return this.files.has(source.name) || this.files.has(source.detail);
  }

  check(sources: Source[]): { verified: number; warnings: PageIssue[] } {
    const warnings = sources.flatMap((source, i) => this.checked(source) ? [] : [{
      code: "source.unverified", path: `finish_build.sources[${i}]`,
      message: "This build has no successful matching read for this source. It is unverified; do not claim it was checked.",
    }]);
    return { verified: sources.length - warnings.length, warnings };
  }
}

/** Warning-only: different locales and compact numeric formats can lose precision. No guessing
 * about which source value was used in a calculation; this checks the card against visible HTML. */
export function metricWarnings(page: string, metrics: readonly Metric[], data?: unknown): PageIssue[] {
  if (data !== undefined && data !== null) {
    const numbers = new Set<number>();
    const walk = (value: unknown): void => {
      if (typeof value === "number") numbers.add(value);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(data);
    return metrics.flatMap((metric, i) => numbers.has(metric.value) ? [] : [{ code: "metric.not_visible", path: `finish_build.metrics[${i}].value`, message: "This card value was not found as a number in the dashboard data. Check the data and card against the source; do not invent data to make them match." }]);
  }
  const text = pageText(page, Infinity).text.toLocaleLowerCase().replace(/[\u00a0\u202f]/g, " ");
  return metrics.flatMap((metric, i) => {
    const forms = new Set([String(metric.value)]);
    for (const locale of ["en-US", "de-DE", "fr-FR", "zh-CN"]) {
      forms.add(metric.value.toLocaleString(locale, { maximumFractionDigits: 10 }));
      forms.add(metric.value.toLocaleString(locale, { notation: "compact", maximumFractionDigits: 1 }));
    }
    const found = [...forms].some(form => {
      const escaped = form.toLocaleLowerCase().replace(/[\u00a0\u202f]/g, " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<![\\p{L}\\p{N}.,+−-])${escaped}(?![\\p{L}\\p{N}]|[.,]\\d)`, "u").test(text);
    });
    return found ? [] : [{ code: "metric.not_visible", path: `finish_build.metrics[${i}].value`, message: "This card value was not found in the page's visible text. Check the page and card against the source; do not invent data to make them match." }];
  });
}
