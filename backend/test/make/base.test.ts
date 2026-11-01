// The shared Make base (L181): one stylesheet + component set injected into every artifact
// (system fonts with PingFang SC, line length, light/dark, print), self-contained (no CDN), and a
// build prompt template per type.
import { describe, expect, test } from "bun:test";
import { ARTIFACT_CSP, ARTIFACT_VIEWPORT, BASE_CSS, BASE_SCRIPT, CHANGED_ATTR, CHART_SCRIPT, TABLE_WRAP_CLASS, checkHtml, countChanged, stripBase, stripChanged, withBase } from "../../src/make/base.ts";
import { ARTIFACT_TYPES, COMPONENTS, TYPE_TEMPLATES, buildPrompt, buildRules } from "../../src/make/prompts.ts";

describe("base stylesheet", () => {
  test("matches the app: PingFang SC in the font stack, a reading width, light and dark, a print layout", () => {
    expect(BASE_CSS).toContain("\"PingFang SC\"");
    expect(BASE_CSS).toContain("-apple-system");
    expect(BASE_CSS).toContain("--duet-measure:68ch");
    expect(BASE_CSS).toContain("@media (prefers-color-scheme:dark)");
    expect(BASE_CSS).toContain("@media print");
    expect(BASE_CSS).toContain("#D65A45");
    // self-contained: no fonts or stylesheets from anywhere
    expect(BASE_CSS).not.toMatch(/https?:|@import|url\(/);
  });

  test("the CSP keeps a page off the network (and so off the backend API)", () => {
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_CSP).toContain("connect-src 'none'");
    expect(ARTIFACT_CSP).toContain("form-action 'none'");
    expect(ARTIFACT_CSP).not.toContain("http");
  });
});

describe("withBase", () => {
  const doc = `<!doctype html><html lang="en"><head><title>T</title><style>h1{color:red}</style></head><body><h1>Hi</h1></body></html>`;

  test("injects the base right after the doctype so the page's own CSS wins, plus the CSP meta and the glow script", () => {
    const out = withBase(doc, { lang: "en", title: "T" });
    expect(out.indexOf("<style data-duet-base>")).toBeLessThan(out.indexOf("h1{color:red}"));
    expect(out.indexOf("name=\"viewport\"")).toBeLessThan(out.indexOf("<html"));
    // The CSP comes right after the doctype, before anything of the page's.
    expect(out.startsWith(`<!doctype html>\n<meta data-duet-base charset="utf-8"><meta data-duet-base http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`)).toBe(true);
    expect(out).toContain("<script data-duet-base>");
    expect(out.indexOf("<script data-duet-base>")).toBeLessThan(out.indexOf("</body>"));
  });

  test("a <head> inside an earlier comment or script can't move the CSP out of effect", () => {
    const tricky = `<!DOCTYPE html><!-- <head> --><script>var s = "<head>"; fetch("https://x.example")</script><html><head><title>T</title></head><body>x</body></html>`;
    const out = withBase(tricky, { lang: "en", title: "T" });
    const csp = out.indexOf("http-equiv=\"Content-Security-Policy\"");
    expect(csp).toBeGreaterThan(0);
    expect(out).toContain("<!-- <head> -->");
    expect(csp).toBeLessThan(out.indexOf("<!-- <head> -->"));
    expect(out.indexOf("<style data-duet-base>")).toBeLessThan(out.indexOf("<!-- <head> -->"));
    expect(csp).toBeLessThan(out.indexOf("<script>var s"));
    expect(out.startsWith("<!DOCTYPE html>\n<meta data-duet-base charset")).toBe(true);
  });

  test("is idempotent: a rebuild strips the earlier injection", () => {
    const once = withBase(doc, { lang: "en", title: "T" });
    const twice = withBase(once, { lang: "en", title: "T" });
    expect(twice).toBe(once);
    expect(stripBase(once)).not.toContain("data-duet-base");
  });

  test("wraps a fragment in a document in the user's language", () => {
    const out = withBase("<h1>你好</h1><p>正文</p>", { lang: "zh-Hans", title: "简报 & <计划>" });
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain(`<html lang="zh-Hans">`);
    expect(out).toContain("<title>简报 &#38; &#60;计划&#62;</title>");
    expect(out).toContain(`<main class="duet-page"><h1>你好</h1>`);
  });
});

describe("checkHtml (self-contained pages only)", () => {
  test("accepts inline CSS/JS, data: images and plain links", () => {
    expect(checkHtml(`<html><body><style>p{}</style><script>1</script><img src="data:image/png;base64,AA"><a href="https://example.com">x</a></body></html>`)).toBeNull();
  });

  test("names what the page would load from the internet", () => {
    for (const html of [
      `<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>`,
      `<link rel="stylesheet" href="//fonts.googleapis.com/css?family=Inter">`,
      `<img src="http://example.com/a.png">`,
      `<style>@import url("https://example.com/a.css");</style>`,
      `<div style="background:url(https://example.com/bg.jpg)"></div>`,
    ]) {
      const problem = checkHtml(`<html><body>${html}</body></html>`);
      expect(problem).toContain("self-contained");
    }
    expect(checkHtml("")).toContain("empty");
    expect(checkHtml("just text")).toContain("doesn't look like HTML");
  });
});

describe("edit markers", () => {
  test("are counted and stripped", () => {
    const html = `<p ${CHANGED_ATTR}>new</p><li ${CHANGED_ATTR}="1">two</li><p>same</p>`;
    expect(countChanged(html)).toBe(2);
    expect(stripChanged(html)).toBe(`<p>new</p><li>two</li><p>same</p>`);
  });
});

describe("build prompts", () => {
  test("every type has its own template", () => {
    expect(ARTIFACT_TYPES).toEqual(["web_page", "docs", "slides", "dashboard", "design", "design_system"]);
    for (const type of ARTIFACT_TYPES) expect(TYPE_TEMPLATES[type].length).toBeGreaterThan(50);
    expect(TYPE_TEMPLATES.docs).toContain("duet-toc");
    expect(TYPE_TEMPLATES.slides).toContain("duet-slide");
    expect(TYPE_TEMPLATES.dashboard).toContain("metrics");
  });

  test("create / edit / refresh name the file; edit asks for the change marker; rules require finish_build", () => {
    const base = { type: "dashboard" as const, id: "a1", prompt: "Sales funnel", title: "Funnel" };
    expect(buildPrompt({ ...base, mode: "create" })).toContain("/workspace/artifacts/a1/index.html");
    const edit = buildPrompt({ ...base, mode: "edit", edit: "Add a churn tile" });
    expect(edit).toContain(CHANGED_ATTR);
    expect(edit).toContain("Add a churn tile");
    const refresh = buildPrompt({ ...base, mode: "refresh", sources: [{ name: "Deals", app: "HubSpot", detail: "open deals" }] });
    expect(refresh).toContain("Refresh the dashboard");
    expect(refresh).toContain("HubSpot");
    expect(buildRules().join("\n")).toContain("finish_build");
  });

  test("dashboards: serif title, panels, funnel rows with deltas and compare bars, duetBars charts, a legend, a notes card", () => {
    for (const piece of ["duet-dash-title", "duet-panel", "duet-funnel-row", "duet-delta duet-up", "duet-compare-bar", "duetBars(", "duet-legend", "duet-notes", "How each step is counted"]) {
      expect(TYPE_TEMPLATES.dashboard).toContain(piece);
    }
    expect(TYPE_TEMPLATES.dashboard).toContain("never draw charts by hand or load a chart library");
    expect(COMPONENTS).toContain("duetBars(element or selector, data, options)");
  });
});

describe("dashboard components", () => {
  test("the classes are in the base stylesheet: serif title, radius-16 hairline panels, green / red deltas, light and dark", () => {
    for (const cls of [".duet-dash-title", ".duet-dash-sub", ".duet-panel", ".duet-funnel-row", ".duet-funnel-value", ".duet-delta.duet-up", ".duet-delta.duet-down", ".duet-compare-bar", ".duet-chart-grid", ".duet-chart-axis", ".duet-legend", ".duet-notes"]) {
      expect(BASE_CSS).toContain(cls);
    }
    expect(BASE_CSS).toMatch(/\.duet-dash-title\{font-family:var\(--duet-serif\)/);
    expect(BASE_CSS).toMatch(/\.duet-panel\{[^}]*border:1px solid var\(--duet-border\);border-radius:16px/);
    expect(BASE_CSS).toMatch(/\.duet-delta\.duet-up\{color:var\(--duet-green\)\}/);
  });

  test("duetBars is valid, offline script injected into <head> before the page's own scripts", () => {
    expect(() => new Function(CHART_SCRIPT)).not.toThrow();
    expect(CHART_SCRIPT).not.toMatch(/https?:|url\(|@import|<\/script|fetch\(|XMLHttpRequest|import\(/i);
    const page = `<!doctype html><html><head><script>duetBars("#c", [])</script></head><body><div id="c"></div></body></html>`;
    const out = withBase(page, { lang: "en", title: "T" });
    expect(out.indexOf("<script data-duet-base data-duet-charts>")).toBeGreaterThan(0);
    expect(out.indexOf("<script data-duet-base data-duet-charts>")).toBeLessThan(out.indexOf("<script>duetBars"));
    expect(checkHtml(out)).toBeNull();
    expect(stripBase(out)).not.toContain("duetBars=");
  });

  test("draws stacked per-day bars with a 3-tick grid, month labels and a legend; escapes labels; shows an empty state", () => {
    const listeners: Record<string, (() => void)[]> = {};
    const el = { innerHTML: "", textContent: "", clientWidth: 600, classList: { list: new Set<string>(), contains(c: string) { return this.list.has(c); }, add(c: string) { this.list.add(c); } } };
    const win: Record<string, unknown> = { addEventListener: (type: string, f: () => void) => { (listeners[type] ??= []).push(f); } };
    const doc = { documentElement: { lang: "en", contains: () => true }, querySelector: () => el };
    new Function("window", "document", CHART_SCRIPT)(win, doc);
    const duetBars = win.duetBars as (el: unknown, data: unknown, opts?: unknown) => void;

    const days = Array.from({ length: 40 }, (_, i) => ({ label: new Date(Date.UTC(2026, 8, 20 + i)).toISOString().slice(0, 10), value: (i * 37) % 90 }));
    duetBars(el, days, { label: "Signups" });
    expect(el.classList.contains("duet-chart")).toBe(true);
    expect((el.innerHTML.match(/class="duet-chart-grid"/g) ?? []).length).toBe(3);
    const axis = [...el.innerHTML.matchAll(/class="duet-chart-axis"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(axis).toEqual(["0", "50", "100", "Sep", "Oct"]);
    expect((el.innerHTML.match(/<path /g) ?? []).length).toBe(39); // one day is 0
    expect(el.innerHTML).toContain("fill:var(--duet-accent)");
    expect(el.innerHTML).not.toContain("duet-legend");

    duetBars(el, { labels: ["2026-10-01", "2026-10-02"], series: [{ name: "Organic", values: [3, 4] }, { name: "Paid <ads>", values: [1, 2], color: "blue" }] });
    expect(el.innerHTML).toContain("duet-legend");
    expect(el.innerHTML).toContain("Paid &#60;ads&#62;");
    expect(el.innerHTML).toContain("fill:var(--duet-blue)");

    duetBars(el, [], { empty: "No data yet" });
    expect(el.innerHTML).toBe("<div class=\"duet-chart-empty\">No data yet</div>");
    // A resize redraws without throwing.
    expect(() => listeners.resize?.forEach((f) => f())).not.toThrow();
  });
});

describe("phone width (M9, contract §6)", () => {
  test("the viewport is fixed to the device width, and the page's own viewport meta is dropped", () => {
    expect(ARTIFACT_VIEWPORT).toBe("width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover");
    const page = `<!doctype html><html><head><meta name="viewport" content="width=1024"><title>T</title></head><body><p>x</p></body></html>`;
    const out = withBase(page, { lang: "en", title: "T" });
    expect(out).toContain(`<meta data-duet-base name="viewport" content="${ARTIFACT_VIEWPORT}">`);
    expect(out).not.toContain("width=1024");
    expect(out.match(/name="viewport"/g)?.length).toBe(1);
    expect(withBase(out, { lang: "en", title: "T" })).toBe(out);
  });

  test("no sideways page scroll: html/body clip x, media shrink, tables scroll in their own wrapper, no 100vw", () => {
    expect(BASE_CSS).toContain("html,body{overflow-x:hidden;max-width:100%;touch-action:pan-y;-webkit-text-size-adjust:100%");
    expect(BASE_CSS).toContain("img,svg,canvas,video{max-width:100%");
    expect(BASE_CSS).toContain(`.${TABLE_WRAP_CLASS}{max-width:100%;overflow-x:auto`);
    expect(BASE_CSS).toContain("overflow-wrap:break-word");
    expect(BASE_CSS).toMatch(/\.duet-panel-head\{display:flex;flex-wrap:wrap/);
    expect(BASE_CSS).not.toContain("100vw");
    expect(buildRules().join("\n")).toContain("390 pt");
    expect(buildRules().join("\n")).toContain("never 100vw");
  });

  test("the end-of-body script wraps every bare table once and still scrolls to the first change", () => {
    expect(() => new Function(BASE_SCRIPT)).not.toThrow();
    type Node = { tag: string; className: string; children: Node[]; parentNode: Node | null; classList: { contains(c: string): boolean } };
    const node = (tag: string, className = ""): Node => {
      const n: Node = { tag, className, children: [], parentNode: null, classList: { contains: (c) => n.className.split(" ").includes(c) } };
      return n;
    };
    const body = node("body");
    const add = (parent: Node, child: Node) => { child.parentNode = parent; parent.children.push(child); return child; };
    const bare = add(body, node("table"));
    const wrapped = add(add(body, node("div", TABLE_WRAP_CLASS)), node("table"));
    const scrolled: unknown[] = [];
    const changed = { scrollIntoView: (opts: unknown) => scrolled.push(opts) };
    const doc = {
      querySelectorAll: (sel: string) => (sel === "table" ? [bare, wrapped] : []),
      querySelector: (sel: string) => (sel === `[${CHANGED_ATTR}]` ? changed : null),
      createElement: (tag: string) => node(tag),
    };
    // insertBefore / appendChild on the fake nodes
    for (const n of [body, wrapped.parentNode!]) Object.assign(n, {
      insertBefore(this: Node, child: Node, ref: Node) { child.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, child); Object.assign(child, { appendChild(this: Node, c: Node) { c.parentNode!.children.splice(c.parentNode!.children.indexOf(c), 1); c.parentNode = this; this.children.push(c); } }); },
    });
    new Function("document", BASE_SCRIPT)(doc);
    expect(bare.parentNode?.className).toBe(TABLE_WRAP_CLASS);
    expect(bare.parentNode?.parentNode).toBe(body);
    expect(wrapped.parentNode?.parentNode?.className).not.toBe(TABLE_WRAP_CLASS);
    expect(body.children.map((c) => c.className)).toEqual([TABLE_WRAP_CLASS, TABLE_WRAP_CLASS]);
    expect(scrolled).toEqual([{ block: "center" }]);
  });
});
