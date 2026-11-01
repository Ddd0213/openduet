// The eval's own data stays valid (no model, no database): every suite's cases parse, emails.jsonl
// is what build-set.ts writes, and the fakes serve what the cases point at.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Case as ChipCase } from "../../evals/chips/suite.ts";
import { Case as HonestyCase } from "../../evals/honesty/suite.ts";
import { Case as InjectionCase } from "../../evals/injection/suite.ts";
import { Case as SkillCase } from "../../evals/skill/suite.ts";
import { Case as SoulCase } from "../../evals/soul/suite.ts";
import { Case as ToneCase } from "../../evals/tone/suite.ts";
import { buildSet, EMAILS_FILE, toJsonl } from "../../evals/triage/build-set.ts";
import { FakeComposio } from "../../evals/lib/fake-composio.ts";
import { FakeWeb } from "../../evals/lib/fake-web.ts";
import { calendar, EVALS_DIR, inbox, persona, readJson } from "../../evals/lib/fixtures.ts";
import { toolExists } from "../../evals/lib/session.ts";
import { slug, table } from "../../evals/lib/output.ts";

const cases = <T extends z.ZodTypeAny>(suite: string, schema: T) => readJson(`${suite}/cases.json`, z.array(schema)) as z.infer<T>[];
const unique = (ids: string[]) => expect(new Set(ids).size).toBe(ids.length);

describe("eval cases", () => {
  test("every suite's cases.json parses, with unique ids", () => {
    for (const [suite, schema] of [["chips", ChipCase], ["tone", ToneCase], ["injection", InjectionCase], ["honesty", HonestyCase], ["soul", SoulCase], ["skill", SkillCase]] as const) {
      const list = cases(suite, schema as z.ZodTypeAny) as { id: string }[];
      expect(list.length).toBeGreaterThan(0);
      unique(list.map((c) => c.id));
    }
  });

  test("chips: 10 choice questions, 2 optional draft refinements, and no-chip controls", () => {
    const list = cases("chips", ChipCase);
    expect(list.filter((c) => c.expect === "chips")).toHaveLength(10);
    expect(list.filter((c) => c.expect === "optional_refinement")).toHaveLength(2);
    expect(list.filter((c) => c.expect === "none_open")).toHaveLength(2);
    expect(new Set(list.map((c) => c.expect))).toEqual(new Set(["chips", "optional_refinement", "none_open", "none_approval", "none_web"]));
  });

  test("tone: 12 everyday questions and 5 reaction-only acknowledgements in both languages", () => {
    const list = cases("tone", ToneCase);
    expect(list.filter(c => !c.reactionOnly)).toHaveLength(12);
    expect(list.filter(c => c.reactionOnly)).toHaveLength(5);
    expect(list.filter(c => c.reactionOnly).map(c => c.ask)).toEqual(["ok明白了", "好的", "谢谢", "ok got it", "thanks!"]);
    expect(new Set(list.map((c) => c.lang))).toEqual(new Set(["en", "zh-Hans"]));
    for (const c of list) for (const p of c.invented ?? []) expect(() => new RegExp(p, "i")).not.toThrow();
  });

  test("injection: 5 emails, each planted token is in its email", () => {
    const list = cases("injection", InjectionCase);
    expect(list).toHaveLength(5);
    for (const c of list) for (const token of c.forbidden) expect(`${c.email.from} ${c.email.body}`).toContain(token);
  });

  test("honesty: every link case's page is served by the fake web, the PDF as a PDF", async () => {
    const web = new FakeWeb();
    const list = cases("honesty", HonestyCase);
    expect(new Set(list.map((c) => c.kind))).toEqual(new Set(["make", "link", "computer"]));
    for (const c of list.filter((x) => x.kind === "link")) {
      const page = web.page(c.url!);
      expect(page).toBeDefined();
      expect(c.ask).toContain(c.url!);
      const res = await web.fetch(c.url!);
      expect(res.status).toBe(200);
    }
    const pdf = await web.fetch("https://files.greenfield-pack.example/reports/annual-2026.pdf");
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    expect((await web.fetch("https://nowhere.example/x")).status).toBe(404);
  });
});

describe("triage set", () => {
  test("emails.jsonl is exactly what build-set.ts writes (edit the script, then run it)", () => {
    expect(readFileSync(EMAILS_FILE, "utf8")).toBe(toJsonl(buildSet()));
  });

  test("48 emails: half needs_you, half Chinese, unique ids, with the hard cases", () => {
    const set = buildSet();
    expect(set).toHaveLength(48);
    unique(set.map((e) => e.id));
    expect(set.filter((e) => e.label === "needs_you")).toHaveLength(24);
    expect(set.filter((e) => e.lang === "zh-Hans")).toHaveLength(24);
    const text = (e: (typeof set)[number]) => `${e.subject} ${e.body}`;
    expect(set.some((e) => e.label === "can_wait" && /限时秒杀/.test(text(e)))).toBe(true);
    expect(set.some((e) => e.label === "can_wait" && /账户变动/.test(e.subject))).toBe(true);
    expect(set.some((e) => e.label === "needs_you" && e.labels.includes("CATEGORY_FORUMS") && e.headers["List-Id"])).toBe(true);
    expect(set.some((e) => e.label === "needs_you" && e.headers["List-Unsubscribe"] && /rotate/i.test(e.subject))).toBe(true);
    expect(set.filter((e) => e.label === "needs_you" && e.cc.length > 0)).toHaveLength(2);
    expect(set.filter((e) => /AI (?:assistant|助手)/.test(text(e))).every((e) => e.label === "can_wait")).toBe(true);
  });

  test("the same set twice is the same (no hidden counter)", () => {
    expect(toJsonl(buildSet())).toBe(toJsonl(buildSet()));
  });
});

describe("fixtures and fakes", () => {
  test("persona, inbox and calendar parse; ids are unique", () => {
    expect(persona().email).toContain("@");
    unique(inbox().map((m) => m.id));
    unique(calendar().map((e) => e.id));
  });

  test("the fake gateway reads the inbox and only records writes", async () => {
    const p = persona();
    const gw = new FakeComposio(p, () => "Asia/Shanghai", () => new Date("2026-10-29T02:00:00Z"));
    gw.mailbox = inbox();
    const read = await gw.execute("u", "GMAIL_FETCH_EMAILS", { query: "from:priya", max_results: 5 });
    expect(read.ok && (read.data as { messages: { subject: string }[] }).messages.map((m) => m.subject)).toEqual(["Invoice INV-2207 due tomorrow"]);
    const sent = await gw.execute("u", "GMAIL_SEND_EMAIL", { recipient_email: "x@example.com", body: "hi" });
    expect(sent.ok).toBe(true);
    expect(gw.calls.map((c) => c.slug)).toEqual(["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"]);
    const tools = await gw.search("u", "read my email");
    expect(tools.tools.every((t) => !/SEND|DELETE|REPLY|FORWARD/.test(t.slug))).toBe(true);
  });

  test("toolExists finds real tool names only", () => {
    expect(toolExists("web_fetch")).toBe(true);
    expect(toolExists("no_such_tool_xyz")).toBe(false);
  });

  test("results helpers: model slug and table cells", () => {
    expect(slug("DeepSeek V4.1 Flash")).toBe("deepseek-v4-1-flash");
    expect(table(["a"], [["x | y\nz"]])).toContain("x \\| y z");
  });

  test("cases are under evals/", () => {
    expect(EVALS_DIR.endsWith(join("backend", "evals"))).toBe(true);
  });
});
