// Run-record redaction (M8): secret-looking keys and values are replaced, the server's own keys by
// exact match, long base64 isn't stored, bodies are capped; plus the title and quote helpers.
import { describe, expect, test } from "bun:test";
import { describeCall, describeResult } from "../../src/runs/describe.ts";
import { quoteExcerpt, replyLine, stripMarkdown } from "../../src/runs/quote.ts";
import { chatTitle } from "../../src/runs/records.ts";
import { BINARY, capBytes, FILE_READ_MAX_BYTES, REDACTED, Redactor, secretValues, STEP_MAX_BYTES } from "../../src/runs/redact.ts";
import { replyToOf } from "../../src/runs/serialize.ts";

const SECRET = "test-only-llm-key-abcdefghijklmnop";
const r = new Redactor([SECRET, "short"]);

describe("Redactor", () => {
  test("headers, key=value pairs and well-known key formats", () => {
    const cases: [string, string][] = [
      ["Authorization: Bearer abcdef1234567890", `Authorization: ${REDACTED}`],
      ["authorization=Basic dXNlcjpwYXNz", `authorization=${REDACTED}`],
      ["x-api-key: k-123456789", `x-api-key: ${REDACTED}`],
      ["https://x.example/?api_key=abc123&page=2", `https://x.example/?api_key=${REDACTED}&page=2`],
      ["password=hunter22 next", `password=${REDACTED} next`],
      ["use sk-proj-abcdefghij1234 now", `use ${REDACTED} now`],
      ["token ghp_abcdefghijklmnop1234", `token ${REDACTED}`],
      // Fake keys assembled at runtime, so the source never holds a real-looking key.
      [`slack ${"xox" + "b-1234567890-abcdef"}`, `slack ${REDACTED}`],
      [`aws ${"AK" + "IAABCDEFGHIJKLMNOP"}`, `aws ${REDACTED}`],
      ["jwt eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl", `jwt ${REDACTED}`],
      [`the key is ${SECRET}.`, `the key is ${REDACTED}.`],
    ];
    for (const [input, expected] of cases) expect(r.text(input)).toBe(expected);
    // Short configured values are never matched (too likely to hit ordinary text).
    expect(r.text("a short note")).toBe("a short note");
    expect(r.text("Bearer is a word")).toBe("Bearer is a word");
  });

  test("secret keys in objects, whatever their case or separators; nested values; long base64", () => {
    const out = r.value({
      Authorization: "Bearer x", "X-Api-Key": "k", api_key: "k", password: "p", nested: { access_token: "t", fine: `has ${SECRET}` },
      list: [{ client_secret: "s" }], image: "A".repeat(600), empty: "", passwordHint: "kept",
    }) as Record<string, unknown>;
    expect(out).toEqual({
      Authorization: REDACTED, "X-Api-Key": REDACTED, api_key: REDACTED, password: REDACTED, nested: { access_token: REDACTED, fine: `has ${REDACTED}` },
      list: [{ client_secret: REDACTED }], image: "[binary data]", empty: "", passwordHint: "kept",
    });
  });

  test("env-style and compound names, bare token=, URL user:password@ (values that aren't the server's keys)", () => {
    const cases: [string, string][] = [
      ["DB_PASSWORD=hunter2 ./run", `DB_PASSWORD=${REDACTED} ./run`],
      ["export PGPASSWORD=xyz", `export PGPASSWORD=${REDACTED}`],
      ["STRIPE_SECRET_KEY=sk_test_not_real", `STRIPE_SECRET_KEY=${REDACTED}`],
      ["AWS_SECRET_ACCESS_KEY=not/a/real/value", `AWS_SECRET_ACCESS_KEY=${REDACTED}`],
      ["X_API_KEY: abc123", `X_API_KEY: ${REDACTED}`],
      ["https://x.example/cb?token=abc123&page=2", `https://x.example/cb?token=${REDACTED}&page=2`],
      ["{\"github_token\": \"plain-value\"}", `{"github_token": "${REDACTED}"}`],
      ["postgres://app:hunter2@db:5432/main", `postgres://app:${REDACTED}@db:5432/main`],
    ];
    for (const [input, expected] of cases) expect(r.text(input)).toBe(expected);
    // Counts and ordinary words stay.
    expect(r.text("max_tokens=8192 input_tokens: 120 tokens_used=5")).toBe("max_tokens=8192 input_tokens: 120 tokens_used=5");
    expect(r.text("PWD=/workspace and a token of thanks")).toBe("PWD=/workspace and a token of thanks");
    expect(r.text("mail me at sam@example.com, https://example.com/a@b")).toBe("mail me at sam@example.com, https://example.com/a@b");
  });

  test("compound secret keys in objects; counts and hints stay", () => {
    expect(r.value({ db_password: "hunter2", aws_secret_access_key: "k", api_token: "t", "x-goog-api-key": "g", setCookie: "c", max_tokens: 10, tokenCount: 3, passwordHint: "kept" })).toEqual({
      db_password: REDACTED, aws_secret_access_key: REDACTED, api_token: REDACTED, "x-goog-api-key": REDACTED, setCookie: REDACTED, max_tokens: 10, tokenCount: 3, passwordHint: "kept",
    });
  });

  test("base64 inside text, data: URIs and line-wrapped MIME are never stored", () => {
    const blob = "iVBORw0KGgo".padEnd(900, "QUJD");
    expect(r.text(`before ${blob} after`)).toBe(`before ${BINARY} after`);
    expect(r.text(`<img src="data:image/png;base64,${blob}">`)).toBe(`<img src="${BINARY}">`);
    const mime = Array.from({ length: 12 }, () => "QUJD".repeat(19)).join("\n");
    expect(r.plain(`header\n${mime}\nfooter`)).toBe(`header\n${BINARY}footer`);
    expect(r.value(`data:image/jpeg;base64,${blob}`)).toBe(BINARY);
    expect(r.value(mime)).toBe(BINARY);
    // Ordinary long text is kept.
    const prose = "word ".repeat(200);
    expect(r.text(prose)).toBe(prose);
  });

  test("bodies: JSON pretty-printed, text as is, empty -> null, capped on a character boundary", () => {
    expect(r.body({ a: 1 })).toBe("{\n  \"a\": 1\n}");
    expect(r.body("{\"token\":\"t\"}")).toBe(`{\n  "token": "${REDACTED}"\n}`);
    expect(r.body("plain text")).toBe("plain text");
    expect(r.body("   ")).toBeNull();
    expect(r.body(null)).toBeNull();
    const capped = r.plain("é".repeat(STEP_MAX_BYTES));
    expect(new TextEncoder().encode(capped!).byteLength).toBeLessThanOrEqual(STEP_MAX_BYTES);
    expect(capped!.endsWith("…")).toBe(true);
    expect(capped).not.toContain("\uFFFD");
    expect(capBytes("abc", 10)).toBe("abc");
    expect(r.line("\n\n  first   line  \nsecond")).toBe("first line");
    expect([...r.line("x".repeat(500))]).toHaveLength(200);
  });

  test("secretValues: the server's keys and each model provider's key variable", () => {
    const values = secretValues(
      { LLM_API_KEY: "llm-key-0123456789", COMPOSIO_API_KEY: "short", COMPUTER_TOKEN: "computer-token-0123", SEARCH_API_KEY: undefined, BETTER_AUTH_SECRET: "auth-secret-0123456789" },
      { providers: [{ id: "p", protocol: "anthropic", baseUrl: "https://x.invalid", apiKeyEnv: "TEST_ONLY_PROVIDER_KEY" }], models: [], roles: { chat: [], task: [], proactive: [], utility: [] }, timeoutMs: 1000 } as never,
      { TEST_ONLY_PROVIDER_KEY: "provider-key-0123456789" },
    );
    expect(values.sort()).toEqual(["auth-secret-0123456789", "computer-token-0123", "llm-key-0123456789", "provider-key-0123456789"]);
  });
});

describe("per-tool rules (describe.ts)", () => {
  const use = (name: string, input: Record<string, unknown>) => ({ type: "tool_use" as const, id: "c1", name, input });
  const result = (data: unknown, isError = false) => ({ type: "tool_result" as const, toolUseId: "c1", content: [{ type: "text" as const, text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) });

  test("execute_app_tools: the app tool's slug and display name, an awaiting card keeps its approval id", () => {
    const call = use("execute_app_tools", { calls: [{ tool: "gmail_send_email", arguments: { recipient_email: "sam@example.com", subject: "Launch", body: "Hi" } }] });
    expect(describeCall(call, r)).toMatchObject({ tool: "GMAIL_SEND_EMAIL", detail: "Launch" });
    const view = describeResult(call, result({ results: [{ index: 0, app: "Gmail", tool: "Send Email", status: "awaiting_approval", approvalId: "ap1" }] }), r);
    expect(view.nested).toEqual([expect.objectContaining({ tool: "GMAIL_SEND_EMAIL", app: "Gmail", title: { text: "Send Email" }, status: "awaiting_approval", approvalId: "ap1", output: null })]);
  });

  test("screenshots keep no image; an error result is an error step", () => {
    const shot = use("computer_screenshot", {});
    const withImage = { type: "tool_result" as const, toolUseId: "c1", content: [{ type: "text" as const, text: "{\"url\":\"https://example.com\"}" }, { type: "image" as const, mediaType: "image/png", data: "AAAA" }] };
    const view = describeResult(shot, withImage as never, r);
    expect(JSON.parse(view.output!)).toEqual({ url: "https://example.com", image: "not stored" });
    expect(view.detail).toBe("https://example.com");
    expect(describeResult(use("web_search", { query: "x" }), result({ error: "boom" }, true), r).status).toBe("error");
  });

  test("M27: exec failure details keep the exit code visible, redacted and capped; tool errors stay errors", () => {
    const call = use("computer_exec", { command: `token=${SECRET} python ${"report ".repeat(100)}` });
    const data = { exitCode: 2, stdout: "", stderr: "bad arguments", timedOut: false };
    const view = describeResult(call, result(data), r);
    expect(view.status).toBe("ok");
    expect(view.detail).toStartWith(`exit 2 · token=${REDACTED} python`);
    expect([...view.detail!].length).toBeLessThanOrEqual(200);
    expect(view.detail).not.toContain(SECRET);
    expect(describeResult(call, result({ ...data, exitCode: 0 }), r)).toMatchObject({ status: "ok", detail: null });
    expect(describeResult(call, result(data, true), r)).toMatchObject({ status: "error", detail: null });
  });

  test("files_read output keeps 2 KB of the text", () => {
    const read = describeResult(use("computer_files_read", { path: "a.txt" }), result({ path: "a.txt", text: "x".repeat(5000) }), r);
    expect(new TextEncoder().encode(read.output!).byteLength).toBeLessThanOrEqual(FILE_READ_MAX_BYTES);
  });
});

describe("titles and quotes", () => {
  test("a chat run's title: the message's first 120 characters, whitespace collapsed, or the file's name", () => {
    expect(chatTitle("  Plan   the\noffsite  ")).toEqual({ text: "Plan the offsite" });
    expect([...chatTitle("字".repeat(300)).text!]).toHaveLength(120);
    expect(chatTitle("", "report.pdf")).toEqual({ text: "report.pdf" });
  });

  test("the excerpt drops markdown and keeps 160 characters; cards without text get their kind", () => {
    expect(stripMarkdown("## Plan\n**Bold** and _it_ with [a link](https://x.example) and `code`\n- item")).toBe("Plan Bold and it with a link and code item");
    expect([...quoteExcerpt("a ".repeat(200))]).toHaveLength(160);
    expect(quoteExcerpt("", "approval")).toBe("[approval]");
    expect(replyLine("Hi there")).toBe("The user is replying to this earlier message of yours: «Hi there»");
    // Older stored payloads (no replyTo) read as null; a broken one too.
    expect(replyToOf({ skill: null })).toBeNull();
    expect(replyToOf({ replyTo: { messageId: 1 } })).toBeNull();
    expect(replyToOf({ replyTo: { messageId: "m1", role: "assistant", excerpt: "Hi" } })).toEqual({ messageId: "m1", role: "assistant", excerpt: "Hi" });
  });
});
