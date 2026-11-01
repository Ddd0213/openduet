// Every sample in docs/api-samples/ must match its zod schema, and every wire shape,
// message kind and event type must have at least one sample (the app decodes the same files).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contractShapes, EVENT_TYPES, MESSAGE_KINDS, type ContractShapeName } from "../src/contract/index.ts";

const samplesDir = join(import.meta.dir, "../../docs/api-samples");

type Sample = { file: string; shape: string; index: number; value: unknown };

function loadSamples(): Sample[] {
  const out: Sample[] = [];
  for (const file of readdirSync(samplesDir).filter((f) => f.endsWith(".json")).sort()) {
    const doc = JSON.parse(readFileSync(join(samplesDir, file), "utf8")) as Record<string, unknown>;
    for (const [shape, value] of Object.entries(doc)) {
      const list = Array.isArray(value) ? value : [value];
      list.forEach((v, index) => out.push({ file, shape, index, value: v }));
    }
  }
  return out;
}

const samples = loadSamples();

describe("api samples", () => {
  test("every sample names a known shape", () => {
    const unknown = samples.filter((s) => !(s.shape in contractShapes)).map((s) => `${s.file}:${s.shape}`);
    expect(unknown).toEqual([]);
  });

  test("every sample matches its schema", () => {
    const failures: string[] = [];
    for (const s of samples) {
      const schema = contractShapes[s.shape as ContractShapeName];
      if (!schema) continue;
      const r = schema.safeParse(s.value);
      if (!r.success) {
        const issues = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        failures.push(`${s.file} ${s.shape}[${s.index}]: ${issues}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("every shape has a sample", () => {
    const covered = new Set(samples.map((s) => s.shape));
    expect(Object.keys(contractShapes).filter((k) => !covered.has(k))).toEqual([]);
  });

  test("every message kind and event type has a sample", () => {
    const kinds = new Set<string>();
    const types = new Set<string>();
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(visit);
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.kind === "string" && "payload" in o && "role" in o) kinds.add(o.kind);
        if (typeof o.type === "string" && "payload" in o && "id" in o && typeof o.id === "number") types.add(o.type);
        Object.values(o).forEach(visit);
      }
    };
    samples.forEach((s) => visit(s.value));
    expect(MESSAGE_KINDS.filter((k) => !kinds.has(k))).toEqual([]);
    expect(EVENT_TYPES.filter((t) => !types.has(t))).toEqual([]);
  });
});
