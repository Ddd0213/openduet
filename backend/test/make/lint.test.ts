import { describe, expect, test } from "bun:test";
import { lintPage, slideWords, SLIDE_BULLET_LIMIT, SLIDE_WORD_LIMIT } from "../../src/make/lint.ts";
import { lintStylesheet } from "../../src/make/lint-css.ts";
import { PageQualityGate, PAGE_LINT_ATTEMPTS } from "../../src/make/quality-gate.ts";
import { withBase } from "../../src/make/base.ts";
import { DESIGN_TOOL_GUIDANCE, MAKE_ARTIFACT_TYPE, MakeArtifactType } from "../../src/make/chat-types.ts";
import { TYPE_TEMPLATES, buildRules } from "../../src/make/prompts.ts";

const page = (body: string, css = "") => `<html><head><title>Weekly notes</title><style>${css}</style></head><body>${body}</body></html>`;
const codes = (html: string) => lintPage(html, { type: "docs" }).errors.map((i) => i.code);
const slide = (content: string) => `<section class="duet-slide">${content}</section>`;

describe("page lint: layout and content", () => {
  test("returns every independent error and warning, not just the first six", () => {
    const html = Array.from({ length: 8 }, (_, i) => `<div id="x${i}" style="width:${500 + i}px">lorem ipsum</div>`).join("");
    const result = lintPage(html, { type: "docs", mode: "edit" });
    expect(result.errors).toHaveLength(9);
    expect(result.warnings.map((i) => i.code)).toEqual(["content.title", "edit.unmarked"]);
    expect(result.errors[7]?.path).toContain("x7");
  });
  test.each(["width:361px", "min-width:720px", "WIDTH:400PX!important"])("rejects unbounded %s", (css) => {
    expect(codes(page(`<div style="${css}">Content</div>`))).toEqual(["layout.fixed_width"]);
  });
  test("accepts responsive caps but min-width still wins over max-width", () => {
    expect(codes(page('<div style="width:800px;max-width:100%">Content</div>'))).toEqual([]);
    expect(codes(page('<div style="min-width:800px;max-width:100%">Content</div>'))).toEqual(["layout.fixed_width"]);
    expect(codes(page("<p>Content</p>", ".x{max-width:1100px;width:100%;min-width:0}"))).toEqual([]);
  });
  test("100vw and fixed percentage overflow are separate issues", () => {
    const result = codes(page("<div>Content</div>", ".a{width:calc(100vw - 20px)}.b{position:fixed;width:120%}.c{position:fixed;min-width:105%}"));
    expect(result).toEqual(["layout.viewport_width", "layout.fixed_overflow", "layout.fixed_overflow"]);
    expect(codes(page("<p>Content</p>", ".a{position:fixed;width:100%}.b{width:80vw}"))).toEqual([]);
  });
  test("ignores CSS comments, string literals, desktop-only, print and keyframe rules", () => {
    const css = `/* .a{width:900px} */.x::after{content:"width:900px;100vw"}@media print{.x{width:900px}}@media (min-width:600px){.x{min-width:800px}}@media screen and (min-width:30em){.x{width:900px}}@keyframes bar{from{width:500px}}`;
    expect(lintStylesheet(css, "style[1]")).toEqual([]);
    expect(lintStylesheet('@media (min-width:600px), (max-width:400px){.x{width:800px}}', "style[1]")).toHaveLength(1);
    expect(lintStylesheet('@supports (display:grid){.x{width:800px}}', "style[1]")).toHaveLength(1);
  });
  test("eval regression: wide table min-width is safe in its automatic scroll wrapper", () => {
    expect(codes(page('<table class="dt" style="min-width:700px"><tr><td>A</td></tr></table>', 'table.dt{width:100%;min-width:660px}'))).toEqual([]);
    expect(codes(page('<svg viewBox="0 0 900 900" style="width:900px"></svg>'))).toEqual([]);
    expect(codes(page('<svg style="min-width:900px"></svg>'))).toEqual(["layout.fixed_width"]);
  });
  test("does not lint the server's injected base or its copied bodies", () => {
    const own = page('<h1>Ready</h1>');
    expect(lintPage(withBase(own, { lang: "en", title: "Ready" }), { type: "docs" })).toEqual(lintPage(own, { type: "docs" }));
  });
  test("filler is visible text, not script, style, hidden text, code or input attributes", () => {
    const html = page('<h1>Daily todo</h1><input placeholder="Your name"><div hidden>lorem ipsum</div><p style="display:none">lorem ipsum</p><script>var placeholder="lorem ipsum"</script><pre>TODO: lorem ipsum https://example.com</pre><a href="https://example.com">Example domain source</a>');
    expect(lintPage(html, { type: "design_system" })).toEqual({ errors: [], warnings: [] });
    expect(codes(page('<p>lorem <b>ipsum</b></p>'))).toEqual(["content.lorem_ipsum"]);
    expect(codes(page('<p>lorem&nbsp;ipsum</p>'))).toEqual(["content.lorem_ipsum"]);
  });
  test("unfinished copy is only a warning; intentional todo lists are not filler", () => {
    expect(lintPage(page('<p>TODO: fill this in</p>'), { type: "docs" }).warnings.map((i) => i.code)).toEqual(["content.unfinished"]);
    expect(lintPage(page('<p>Daily todo list</p>'), { type: "dashboard" }).warnings).toEqual([]);
  });
  test("title and changed marker warnings reflect elements, not strings in scripts", () => {
    expect(lintPage('<h1><b>Plan</b></h1><p data-duet-changed>Done</p>', { type: "docs", mode: "edit" }).warnings).toEqual([]);
    expect(lintPage('<script>var s="<h1 data-duet-changed>Plan</h1>"</script><p>Done</p>', { type: "docs", mode: "edit" }).warnings.map((i) => i.code)).toEqual(["content.title", "edit.unmarked"]);
  });
  test("empty and plain-text files are identified", () => {
    expect(codes("")).toContain("html.empty");
    expect(codes("not html")).toContain("html.not_html");
  });
});

describe("slides and dashboard lint", () => {
  test("budgets are shared with the prompt and count every over-budget slide", () => {
    const long = Array.from({ length: SLIDE_WORD_LIMIT + 1 }, () => "word").join(" ");
    const bullets = `<ul>${"<li>Item</li>".repeat(SLIDE_BULLET_LIMIT + 1)}</ul>`;
    const out = lintPage(page(slide(long) + slide(bullets) + slide(long)), { type: "slides" });
    expect(out.errors.map((i) => [i.code, i.path])).toEqual([["slides.words", ".duet-slide[1]"], ["slides.bullets", ".duet-slide[2]"], ["slides.words", ".duet-slide[3]"]]);
    expect(TYPE_TEMPLATES.slides).toContain(`25–${SLIDE_WORD_LIMIT}`);
    expect(TYPE_TEMPLATES.slides).toContain(`at most ${SLIDE_BULLET_LIMIT} short bullets`);
  });
  test("CJK, numeric entities and mixed words count; inline emphasis does not add words", () => {
    expect(slideWords("中文测试 hello &#x4E2D;&#25991; &amp;" )).toBe(4);
    expect(lintPage(page(slide("中文".repeat(36))), { type: "slides" }).errors[0]?.code).toBe("slides.words");
    expect(lintPage(page(slide("<p>hel<b>lo</b></p>".repeat(35))), { type: "slides" }).errors).toEqual([]);
  });
  test("hidden slides and invisible list items do not inflate the visible budget", () => {
    const html = page(slide('<h2>Title</h2><ul><li>One</li><li hidden>Two</li></ul><div hidden>' + "word ".repeat(100) + '</div>') + '<section class="duet-slide" hidden>' + "word ".repeat(100) + '</section>');
    expect(lintPage(html, { type: "slides" }).errors).toEqual([]);
    expect(lintPage(page("<p>Normal page</p>"), { type: "slides" }).warnings[0]?.code).toBe("slides.structure");
  });
  test("checks explicit metrics metadata without pretending absent historical metadata is empty", () => {
    for (const metrics of [[], [1], [1, 2, 3, 4, 5]]) expect(lintPage(page("<h1>Queue</h1>"), { type: "dashboard", metrics }).errors[0]?.code).toBe("dashboard.metrics");
    for (const metrics of [null, undefined, [1, 2], [1, 2, 3, 4]]) expect(lintPage(page("<h1>Queue</h1>"), { type: "dashboard", metrics }).errors).toEqual([]);
  });
  test("literal chart selectors missing targets are errors; existing ids and DOM arguments work", () => {
    const html = page('<div id="ok"></div><script>duetBars("#missing",[]);duetBars("#ok",[]);duetBars(document.getElementById("also-missing"),[])</script>');
    expect(lintPage(html, { type: "dashboard" }).errors.map((i) => i.path)).toEqual(["#missing", "#also-missing"]);
  });
  test("eval regression: a lazily created chart is not a missing target", () => {
    const html = page(`<script>if(nights.length){field.innerHTML='<div id="duration-chart"></div>';duetBars("#duration-chart",nights);}</script>`);
    expect(lintPage(html, { type: "dashboard" }).errors).toEqual([]);
  });
  test("empty unrendered chart is a warning, not a forced funnel requirement", () => {
    expect(lintPage(page('<div id="empty-chart"></div>'), { type: "dashboard" }).warnings[0]?.code).toBe("dashboard.chart_empty");
    for (const html of [page('<div id="custom-chart"><svg></svg></div>'), page('<div id="dynamic-chart"></div><script>duetBars(target,data)</script>'), page('<ul class="duet-list"><li>Reply</li></ul>')]) {
      expect(lintPage(html, { type: "dashboard" }).warnings).toEqual([]);
    }
    for (const layout of ["(a) Funnel", "(b) Queue", "(c) Timeline", "Choose exactly ONE"]) expect(TYPE_TEMPLATES.dashboard).toContain(layout);
  });
});

describe("bounded build-quality gate (per-job integration API)", () => {
  test("check -> fix -> check, all errors in one tool result and only the fixed page may save", () => {
    const gate = new PageQualityGate();
    const bad = gate.check(page('<p style="width:700px">lorem ipsum</p>'), { type: "docs" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain("layout.fixed_width");
      expect(bad.error).toContain("content.lorem_ipsum");
      expect(bad.error).toContain("Fix all listed problems together");
    }
    expect(gate.check(page('<h1>Real notes</h1><p>Ready</p>'), { type: "docs" })).toMatchObject({ ok: true, attempt: 2, degraded: false });
    expect(buildRules().join("\n")).toContain("never tell the user about lint limits");
  });
  test("third quality failure becomes warnings, while a new job gets a fresh budget", () => {
    const gate = new PageQualityGate(), bad = page('<p>lorem ipsum</p>');
    for (let i = 1; i < PAGE_LINT_ATTEMPTS; i++) expect(gate.check(bad, { type: "docs" }).ok).toBe(false);
    const allowed = gate.check(bad, { type: "docs" });
    expect(allowed).toMatchObject({ ok: true, attempt: 3, degraded: true });
    expect(allowed.warnings[0]?.code).toBe("content.lorem_ipsum");
    expect(new PageQualityGate().check(bad, { type: "docs" }).ok).toBe(false);
  });
  test("security/basic HTML refusals never use up or bypass the quality budget", () => {
    const gate = new PageQualityGate();
    for (let i = 0; i < 4; i++) expect(gate.check('<img src="https://cdn.invalid/a.png">', { type: "docs" }).ok).toBe(false);
    expect(gate.check(page('<p>lorem ipsum</p>'), { type: "docs" })).toMatchObject({ ok: false, attempt: 1 });
    gate.check(page('<p>lorem ipsum</p>'), { type: "docs" });
    gate.check(page('<p>lorem ipsum</p>'), { type: "docs" });
    expect(gate.check("", { type: "docs" }).ok).toBe(false);
    expect(gate.check("plain text", { type: "docs" }).ok).toBe(false);
  });
  test("title/edit warnings alone do not block a save", () => {
    expect(new PageQualityGate().check('<p>Updated</p>', { type: "docs", mode: "edit" })).toMatchObject({ ok: true, degraded: false });
  });
});

test("chat type integration API preserves doc and includes design/design_system with guidance", () => {
  for (const type of ["doc", "dashboard", "web_page", "slides", "design", "design_system"] as const) {
    expect(MakeArtifactType.parse(type)).toBe(type);
    expect(TYPE_TEMPLATES[MAKE_ARTIFACT_TYPE[type]]).toBeTruthy();
  }
  expect(MAKE_ARTIFACT_TYPE.doc).toBe("docs");
  expect(MakeArtifactType.safeParse("unknown").success).toBe(false);
  expect(DESIGN_TOOL_GUIDANCE).toContain("logo");
  expect(DESIGN_TOOL_GUIDANCE).toContain("type design_system");
});
