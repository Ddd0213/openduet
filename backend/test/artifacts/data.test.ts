import { describe, expect, test } from "bun:test";
import { applyOps, opPaths } from "../../src/artifacts/data.ts";
import { DataOp, MAX_ARTIFACT_DATA_BYTES } from "../../src/contract/m27.ts";

const ops = (items: unknown[]) => items.map(item => DataOp.parse(item));
const apply = (data: unknown, items: unknown[]) => applyOps(JSON.stringify(data), ops(items));

describe("M27 all-or-nothing data ops", () => {
  for (const [name, data, items, expected] of [
    ["set creates objects", {}, [{ op: "set", path: ["a", "b"], value: 7 }], { a: { b: 7 } }],
    ["set existing array index", { a: [1] }, [{ op: "set", path: ["a", 0], value: null }], { a: [null] }],
    ["increment missing defaults to zero", {}, [{ op: "increment", path: ["a", "b"] }], { a: { b: 1 } }],
    ["increment negative", { n: 8 }, [{ op: "increment", path: ["n"], by: -3 }], { n: 5 }],
    ["append creates array", {}, [{ op: "append", path: ["a", "b"], value: { n: 1 } }], { a: { b: [{ n: 1 }] } }],
    ["append trims oldest", { a: [1, 2, 3] }, [{ op: "append", path: ["a"], value: 4, max: 2 }], { a: [3, 4] }],
    ["remove key", { a: 1, b: 2 }, [{ op: "remove", path: ["a"] }], { b: 2 }],
    ["remove array index shifts", { a: [1, 2, 3] }, [{ op: "remove", path: ["a", 1] }], { a: [1, 3] }],
    ["remove missing path", {}, [{ op: "remove", path: ["a", "b"] }], {}],
    ["remove missing index", { a: [] }, [{ op: "remove", path: ["a", 9] }], { a: [] }],
  ] as const) test(name, () => {
    const result = apply(data, [...items]);
    expect(result.ok).toBe(true);
    if (result.ok) { expect(JSON.parse(result.data)).toEqual(expected); expect(result.changed).toBe(JSON.stringify(data) !== JSON.stringify(expected)); }
  });

  for (const [data, path, op] of [
    [{ a: [] }, ["a", 0], "set"], [{ a: 1 }, ["a", "b"], "set"],
    [{ a: "x" }, ["a"], "increment"], [{ a: 1 }, ["a"], "append"],
    [{}, ["a", 0], "set"], [{ a: [1] }, ["a", "0"], "set"],
  ] as const) test(`invalid ${op} at ${path.join(".")} on ${JSON.stringify(data)}`, () => {
    const result = apply(data, [{ op: "set", path: ["first"], value: 1 }, { op, path, value: 1 }].map(item => item.op === "increment" ? { op: item.op, path: item.path } : item));
    expect(result).toMatchObject({ ok: false, code: "invalid_op" });
    if (!result.ok) { expect(result.error).toContain("ops[1]"); expect(result.error).toContain(path.join(".")); }
    expect(data).not.toHaveProperty("first");
  });

  test("too large, depth, forbidden values, non-finite arithmetic are refused", () => {
    expect(apply({}, [{ op: "set", path: ["a"], value: "中".repeat(MAX_ARTIFACT_DATA_BYTES) }])).toMatchObject({ code: "too_large" });
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
    expect(apply({}, [{ op: "set", path: ["a"], value: deep }])).toMatchObject({ code: "invalid_data" });
    expect(apply({}, [{ op: "set", path: ["a"], value: JSON.parse('{"__proto__":1}') }])).toMatchObject({ code: "invalid_data" });
    expect(apply({ a: Number.MAX_VALUE }, [{ op: "increment", path: ["a"], by: Number.MAX_VALUE }])).toMatchObject({ code: "invalid_data" });
  });

  test("ops and their nested values are never mutated, even on refusal", () => {
    const input = ops([{ op: "set", path: ["a"], value: { b: 1 } }, { op: "increment", path: ["a", "b"] }, { op: "append", path: ["a"], value: 9 }]);
    const before = structuredClone(input);
    expect(applyOps("{}", input).ok).toBe(false);
    expect(input).toEqual(before);
  });

  test("details dedupe in order, exclude values, cap at 200 chars", () => {
    expect(opPaths(ops([{ op: "increment", path: ["total"] }, { op: "increment", path: ["categories", 0, "count"] }, { op: "remove", path: ["total"] }]))).toBe("total, categories.0.count");
    expect(opPaths([{ path: ["a".repeat(200)] }, { path: ["b"] }])).toHaveLength(200);
  });
});
