import { describe, expect, test } from "bun:test";
import { BuildEvidence, metricWarnings } from "../../src/artifacts/checks.ts";
import { pageText } from "../../src/artifacts/text.ts";
import { withBase } from "../../src/make/base.ts";
import type { ToolResultBlock, ToolUseBlock } from "../../src/llm/index.ts";

function observe(evidence: BuildEvidence, name: string, input: ToolUseBlock["input"], output: unknown, isError = false) {
  const steps = evidence.steps();
  const call: ToolUseBlock = { type: "tool_use", id: crypto.randomUUID(), name, input };
  const handle = steps.toolStart(call);
  const result: ToolResultBlock = { type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: JSON.stringify(output) }], isError };
  steps.toolEnd(handle, result);
}
const app = (name: string) => ({ name, app: name, detail: "" });

describe("M24 page text", () => {
  test("headings/lists/table rows survive; scripts/styles/base/hidden content do not", () => {
    const html = withBase('<h1>Revenue &amp; costs</h1><p>Today &copy; 2026</p><ul><li>One</li><li><b>Two</b></li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><script>secretScript()</script><style>.secretStyle{}</style><div hidden>Hidden <span>child</span></div><p style="display:none">Inline hidden</p><p aria-hidden="true">ARIA hidden</p><template>template</template>', { lang: "en", title: "Head-only title" });
    const text = pageText(html).text;
    expect(text).toBe("# Revenue & costs\nToday © 2026\n- One\n- Two\n| A | B\n| 1 | 2");
  });
  test("cap is 20,000 characters, doesn't split surrogate pairs, and exact boundary isn't truncated", () => {
    expect(pageText(`<p>${"😀".repeat(20_001)}</p>`)).toEqual({ text: "😀".repeat(20_000), truncated: true });
    expect(pageText(`<p>${"a".repeat(20_000)}</p>`).truncated).toBe(false);
    expect(pageText("")).toEqual({ text: "", truncated: false });
  });
});

describe("M24 metric warnings", () => {
  for (const form of ["1204", "1,204", "1.204", "1 204", "1.2K", "1,2 k"]) test(`matches visible locale/compact value ${form}`, () => {
    expect(metricWarnings(`<p>${form}</p>`, [{ label: "Count", value: 1204, unit: null }])).toEqual([]);
  });
  test("no script/attribute/hidden or substring matches, signed and fractional numbers kept", () => {
    const html = '<p>12040; -1204; 1204.9</p><p hidden>1204</p><i title="1204"></i><script>1204</script>';
    expect(metricWarnings(html, [{ label: "Count", value: 1204, unit: null }]).map(w => w.code)).toEqual(["metric.not_visible"]);
    expect(metricWarnings("<p>-12.5; 0; 23%</p>", [{ label: "Change", value: -12.5, unit: "%" }, { label: "Zero", value: 0, unit: null }, { label: "Rate", value: 23, unit: "%" }])).toEqual([]);
  });
});

describe("M24 build evidence", () => {
  test("only successful matching app reads, including nested calls; denied/errors/writes don't verify", () => {
    const evidence = new BuildEvidence();
    observe(evidence, "execute_app_tools", { calls: ["GMAIL_GET_MESSAGES", "HUBSPOT_LIST_DEALS", "STRIPE_GET_PAYMENTS", "SLACK_SEND_MESSAGE"].map(tool => ({ tool, arguments: {} })) }, {
      results: [{ index: 0, status: "ok", app: "Gmail" }, { index: 1, status: "awaiting_approval", app: "HubSpot" }, { index: 2, status: "error", app: "Stripe" }, { index: 3, status: "ok", app: "Slack" }],
    });
    expect(evidence.check([app("Gmail"), app("HubSpot"), app("Stripe"), app("Slack")])).toMatchObject({ verified: 1 });
    expect(evidence.check([app("Gmail"), app("HubSpot")]).warnings[0]?.path).toBe("finish_build.sources[1]");
    expect(new BuildEvidence().checked(app("Gmail"))).toBe(false);
  });
  test("URLs/files must actually be read; reading the generated artifact cannot fake freshness", () => {
    const evidence = new BuildEvidence();
    observe(evidence, "web_fetch", { url: "https://example.com/report" }, { url: "https://example.com/report", text: "Read it, see https://example.com/unread" });
    observe(evidence, "web_fetch", { url: "https://example.com/failed" }, { error: "Unavailable" }, true);
    observe(evidence, "computer_files_read", { path: "/workspace/data.csv" }, { text: "count,12" });
    observe(evidence, "computer_files_read", { path: "/workspace/./artifacts/a/index.html" }, { text: "old data" });
    observe(evidence, "web_search", { query: "https://example.com/query-only" }, { results: [{ url: "https://example.com/found" }] });
    expect(evidence.checked({ name: "Report", app: null, detail: "https://example.com/report" })).toBe(true);
    expect(evidence.checked({ name: "Wrong", app: null, detail: "https://example.com/failed" })).toBe(false);
    expect(evidence.checked({ name: "Wrong", app: null, detail: "https://example.com/unread" })).toBe(false);
    expect(evidence.checked({ name: "data.csv", app: null, detail: "" })).toBe(true);
    expect(evidence.checked({ name: "index.html", app: null, detail: "" })).toBe(false);
    expect(evidence.checked({ name: "Wrong", app: "Gmail", detail: "https://example.com/report" })).toBe(false);
    expect(evidence.checked({ name: "Wrong", app: null, detail: "https://example.com/query-only" })).toBe(false);
    expect(evidence.checked({ name: "Found", app: null, detail: "https://example.com/found" })).toBe(true);
  });
});
