// M27: all-or-nothing path updates on a copy of the stored compact JSON text.
import { artifactDataBytes, artifactDataProblem, MAX_ARTIFACT_DATA_BYTES, type DataOp } from "../contract/m27.ts";

export type AppliedData = { ok: true; data: string; changed: boolean } | { ok: false; code: "invalid_op" | "invalid_data" | "too_large"; error: string };

export function checkedData(data: unknown, previous: string): AppliedData {
  const bytes = artifactDataBytes(data);
  if (bytes > MAX_ARTIFACT_DATA_BYTES) return { ok: false, code: "too_large", error: `The data would be ${bytes} bytes; at most ${MAX_ARTIFACT_DATA_BYTES}. Keep only what the page shows.` };
  const problem = artifactDataProblem(data);
  if (problem) return { ok: false, code: "invalid_data", error: `${problem} Nothing was saved.` };
  const text = JSON.stringify(data);
  return { ok: true, data: text, changed: text !== previous };
}

export function applyOps(data: string, ops: readonly DataOp[]): AppliedData {
  const copy = JSON.parse(data) as Record<string, unknown>;
  for (const [index, op] of ops.entries()) {
    const path = op.path.join(".");
    const invalid = (why: string): AppliedData => ({ ok: false, code: "invalid_op", error: `ops[${index}]: ${path}: ${why}. Nothing was saved.` });
    let node: unknown = copy;
    let missing = false;
    for (let i = 0; i < op.path.length; i++) {
      const key = op.path[i]!;
      if (node === null || typeof node !== "object") return invalid("the path goes through a scalar");
      const array = Array.isArray(node);
      if (array ? typeof key !== "number" : typeof key !== "string") return invalid(array ? "an array needs an existing index" : "an index needs an existing array");
      const obj = node as Record<string | number, unknown>;
      const exists = Object.hasOwn(obj, key);
      if (array && !exists) {
        if (op.op === "remove") { missing = true; break; }
        return invalid("the index is past the end of the array");
      }
      if (i < op.path.length - 1) {
        if (!exists) {
          if (op.op === "remove") { missing = true; break; }
          obj[key] = {};
        }
        node = obj[key];
        continue;
      }
      if (op.op === "remove") {
        if (exists) { if (array) (node as unknown[]).splice(key as number, 1); else delete obj[key]; }
      } else if (op.op === "set") obj[key] = structuredClone(op.value);
      else if (op.op === "increment") {
        const value = exists ? obj[key] : 0;
        if (typeof value !== "number") return invalid("increment needs a number");
        obj[key] = value + op.by;
      } else {
        if (!exists) obj[key] = [];
        const value = obj[key];
        if (!Array.isArray(value)) return invalid("append needs an array");
        // Copy before appending: an earlier set may hold an object from the caller's ops.
        obj[key] = [...value, structuredClone(op.value)].slice(op.max === null ? 0 : -op.max);
      }
    }
    if (missing) continue;
  }
  return checkedData(copy, data);
}

/** Run-step detail: paths only, no values, stable order and bounded display length. */
export function opPaths(ops: readonly Pick<DataOp, "path">[]): string {
  return [...new Set(ops.map(op => op.path.join(".")))].join(", ").slice(0, 200);
}
