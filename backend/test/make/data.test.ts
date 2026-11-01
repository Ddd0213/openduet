import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { DATA_SCRIPT, stripInjected, withBase, withData } from "../../src/make/base.ts";
import { TYPE_TEMPLATES, COMPONENTS, buildPrompt } from "../../src/make/prompts.ts";

test("M27 serve blocks follow charts, escape script closings, strip both blocks", () => {
  const original = '<html><head></head><body><h1>Links</h1><script>if(window.duetOnData)duetOnData(function(data){});</script></body></html>';
  const base = withBase(original, { title: "Links", lang: "en" });
  const json = '{"title":"</script><script>alert(1)</script>"}';
  const html = withData(base, json, 7);
  expect(html).toContain('id="duet-data" data-version="7" data-duet-base>');
  expect(html).toContain('\\u003c/script>'); expect(html).not.toContain(json);
  expect(html.indexOf('id="duet-data"')).toBeGreaterThan(html.indexOf("data-duet-charts"));
  expect(html.indexOf('id="duet-data"')).toBeLessThan(html.indexOf("<html>"));
  expect(html.split(DATA_SCRIPT)).toHaveLength(2);
  expect(stripInjected(html)).toBe(stripInjected(base));
  expect(stripInjected(`<script>${DATA_SCRIPT}</script>`)).toBe("");
});

for (const [page, prefix] of [
  ['<head><meta data-duet-base charset="utf-8"><meta data-duet-base name="viewport"></head>', '<meta data-duet-base name="viewport">'],
  ['<html><head lang="en"></head></html>', '<head lang="en">'],
  ['<h1>Old fragment</h1>', ''],
] as const) test(`M27 fallback injection ${prefix || "at start"}`, () => {
  expect(withData(page, "{}", 1)).toContain(prefix + '<script type="application/json" id="duet-data"');
});

test("M27 runtime calls once/newer versions, observer and event coalesce, parse/callback errors preserve last good", () => {
  const el = { textContent: '{"total":0}', version: "1", getAttribute() { return this.version; } };
  let event: () => void = () => {}, observer: () => void = () => {};
  let observed: unknown;
  const win: Record<string, any> = {};
  class Observer { constructor(fn: () => void) { observer = fn; } observe(element: unknown, options: unknown) { observed = { element, options }; } }
  win.MutationObserver = Observer;
  runInNewContext(DATA_SCRIPT, { window: win, document: { getElementById: () => el, addEventListener: (name: string, fn: () => void) => { expect(name).toBe("duet:data"); event = fn; } }, MutationObserver: Observer });
  const seen: number[] = []; win.duetOnData(() => { throw new Error("callback"); }); win.duetOnData((data: { total: number }) => seen.push(data.total));
  expect(seen).toEqual([0]); expect(observed).toBeDefined(); event(); observer(); expect(seen).toEqual([0]);
  el.version = "2"; el.textContent = '{"total":8}'; event(); observer(); expect(seen).toEqual([0, 8]);
  el.version = "3"; el.textContent = "{"; observer(); expect(win.duetData.total).toBe(8);
  el.textContent = '{"total":9}'; observer(); expect(seen).toEqual([0, 8, 9]);
  el.version = "2"; el.textContent = '{"total":4}'; event(); expect(seen).toEqual([0, 8, 9]);
  expect(DATA_SCRIPT).not.toContain("\\"); expect(DATA_SCRIPT).not.toContain("${");
});

test("M27 build instructions require data, end-of-body callback, safe complete redraw and data-only refresh", () => {
  for (const instruction of [TYPE_TEMPLATES.dashboard, COMPONENTS]) for (const text of ["textContent", "duetOnData", "arrays", "64 KB", "HTML"]) expect(instruction.toLowerCase()).toContain(text.toLowerCase());
  const input = { id: "a1", type: "dashboard" as const, mode: "refresh" as const, title: "Links", prompt: "Links" };
  expect(buildPrompt({ ...input, liveData: true })).toContain("Leave index.html as it is");
  expect(buildPrompt({ ...input, liveData: false })).toContain("Refresh the dashboard");
});
