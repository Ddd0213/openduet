// Results: <out>/<suite>-<model label>-<YYYY-MM-DD-HHMM>/results.json + results.md. Everything
// written goes through the run records' redactor first (the provider key the resolver decrypted,
// the eval's own tokens, secret-looking patterns), so a results file never carries a secret.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Redactor } from "../../src/runs/redact.ts";

export const slug = (text: string): string =>
  text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "model";

/** Local time, YYYY-MM-DD-HHMM. */
export function stamp(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
}

/** A markdown table cell: one line, pipes escaped, capped. */
export function cell(value: unknown, max = 160): string {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  const one = text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function table(head: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map((v) => cell(v)).join(" | ")} |`),
  ].join("\n");
}

export interface RunHeader {
  suite: string;
  model: { id: string; label: string };
  startedAt: string;
  finishedAt: string;
  modelCalls: number;
  httpRequests: number;
  budget: number | null;
  stoppedByBudget: boolean;
  repeat: number;
  notes: string[];
}

/** Writes results.json and results.md under `out`; returns the run's directory. */
export function writeResults(out: string, header: RunHeader, json: unknown, markdown: string, redact: Redactor): string {
  const dir = join(out, `${header.suite}-${slug(header.model.label)}-${stamp(new Date(header.startedAt))}`);
  mkdirSync(dir, { recursive: true });
  const head = [
    `# ${header.suite} · ${header.model.label}`,
    "",
    `- model: ${header.model.label} (ModelEntry ${header.model.id})`,
    `- run: ${header.startedAt} → ${header.finishedAt}`,
    `- model calls: ${header.modelCalls} (HTTP requests ${header.httpRequests}${header.budget !== null ? `, cap ${header.budget}` : ""})${header.stoppedByBudget ? " · STOPPED: call cap reached" : ""}`,
    ...(header.repeat > 1 ? [`- repeat: ${header.repeat}`] : []),
    ...header.notes.map((n) => `- ${n}`),
    "",
  ].join("\n");
  writeFileSync(join(dir, "results.json"), `${JSON.stringify(redact.value({ ...header, ...(json as object) }), null, 2)}\n`);
  writeFileSync(join(dir, "results.md"), `${redact.text(`${head}\n${markdown}`)}\n`);
  return dir;
}
