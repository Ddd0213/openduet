// ToolPolicy defaults (L106): clear reads always, writes and anything unclassifiable ask; the card
// kind of an "ask" call; and the user's per-tool / "All tools" choices over the defaults.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { approvalKind, classify, defaultMode } from "../../src/policy/classify.ts";
import { PolicyService, toolkitKey } from "../../src/policy/service.ts";
import { createTestDatabase } from "../helpers/db.ts";

describe("classify", () => {
  test("clear reads are reads", () => {
    for (const slug of ["GMAIL_FETCH_EMAILS", "GMAIL_GET_EMAIL", "GOOGLECALENDAR_FIND_EVENT", "SLACK_LIST_CHANNELS", "NOTION_QUERY_DATABASE", "GITHUB_SEARCH_ISSUES", "GOOGLEDRIVE_DOWNLOAD_FILE"]) {
      expect([slug, classify({ slug, toolkit: null })]).toEqual([slug, "read"]);
    }
    expect(classify({ slug: "ACME_PROFILE", toolkit: "acme", tags: ["readOnlyHint"] })).toBe("read");
  });

  test("sending, posting, creating, updating, moving, archiving, paying, signing, deleting are writes", () => {
    for (const slug of ["GMAIL_SEND_EMAIL", "SLACK_CHAT_POST_MESSAGE", "GOOGLECALENDAR_CREATE_EVENT", "NOTION_UPDATE_PAGE", "GOOGLEDRIVE_MOVE_FILE",
      "GMAIL_ARCHIVE_THREAD", "STRIPE_CHARGE_CUSTOMER", "DOCUSIGN_SIGN_ENVELOPE", "GMAIL_DELETE_MESSAGE", "GMAIL_REPLY_TO_THREAD", "GITHUB_CREATE_AN_ISSUE"]) {
      expect([slug, classify({ slug, toolkit: null })]).toEqual([slug, "write"]);
    }
  });

  test("a write word beats a read word and a readOnly tag; Composio's write hints win", () => {
    expect(classify({ slug: "GMAIL_MARK_AS_READ", toolkit: "gmail" })).toBe("write");
    expect(classify({ slug: "ACME_GET_OR_CREATE_USER", toolkit: "acme" })).toBe("write");
    expect(classify({ slug: "ACME_SEND_DIGEST", toolkit: "acme", tags: ["readOnlyHint"] })).toBe("write");
    expect(classify({ slug: "ACME_GET_THING", toolkit: "acme", tags: ["destructiveHint"] })).toBe("write");
  });

  test("anything we can't classify asks", () => {
    expect(classify({ slug: "ACME_FROBNICATE", toolkit: "acme" })).toBe("unknown");
    expect(classify({ slug: "GITHUB_ISSUE_COMMENT", toolkit: "github" })).toBe("unknown");
    expect(defaultMode("unknown")).toBe("ask");
    expect(defaultMode("write")).toBe("ask");
    expect(defaultMode("read")).toBe("always");
  });

  test("card kind: mail sending is email, deleting is delete, signing is sign, the rest action", () => {
    expect(approvalKind({ slug: "GMAIL_SEND_EMAIL", toolkit: "gmail" })).toBe("email");
    expect(approvalKind({ slug: "GMAIL_REPLY_TO_THREAD", toolkit: "gmail" })).toBe("email");
    expect(approvalKind({ slug: "GMAIL_SEND_DRAFT", toolkit: "gmail" })).toBe("action");
    expect(approvalKind({ slug: "GMAIL_DELETE_MESSAGE", toolkit: "gmail" })).toBe("delete");
    expect(approvalKind({ slug: "GOOGLEDRIVE_TRASH_FILE", toolkit: "googledrive" })).toBe("delete");
    expect(approvalKind({ slug: "DOCUSIGN_SEND_ENVELOPE", toolkit: "docusign" })).toBe("sign");
    expect(approvalKind({ slug: "ACME_SIGN_CONTRACT", toolkit: "acme" })).toBe("sign");
    expect(approvalKind({ slug: "SLACK_SEND_MESSAGE", toolkit: "slack" })).toBe("action");
  });
});

describe("PolicyService", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => { database = await createTestDatabase(); });
  afterAll(async () => { await database.cleanup(); });

  async function user() {
    const id = crypto.randomUUID();
    await database.db.user.create({ data: { id, name: "Alex", username: id, authEmail: `${id}@test.invalid` } });
    return id;
  }

  // M20: the write here is a delete (sending mail is per recipient now: test/policy/floor.test.ts).
  test("defaults, a tool choice, then an All tools choice that clears the per-tool ones", async () => {
    const userId = await user();
    const policy = new PolicyService(database.db);
    const remove = { slug: "GMAIL_DELETE_MESSAGE", toolkit: "gmail" }, fetch = { slug: "GMAIL_FETCH_EMAILS", toolkit: "gmail" };
    expect(Object.fromEntries(await policy.modes(userId, [remove, fetch]))).toEqual({ GMAIL_DELETE_MESSAGE: "ask", GMAIL_FETCH_EMAILS: "always" });

    await policy.setTool(userId, "GMAIL_DELETE_MESSAGE", "always");
    expect(await policy.mode(userId, remove)).toBe("always");

    await policy.setToolkit(userId, "gmail", "ask", ["GMAIL_DELETE_MESSAGE", "GMAIL_FETCH_EMAILS"]);
    expect(Object.fromEntries(await policy.modes(userId, [remove, fetch]))).toEqual({ GMAIL_DELETE_MESSAGE: "ask", GMAIL_FETCH_EMAILS: "ask" });
    const rows = await database.db.toolPolicy.findMany({ where: { userId } });
    expect(rows.map((r) => r.toolSlug)).toEqual([toolkitKey("gmail")]);

    // A tool choice after All tools wins for that tool only.
    await policy.setTool(userId, "GMAIL_FETCH_EMAILS", "always");
    expect(Object.fromEntries(await policy.modes(userId, [remove, fetch]))).toEqual({ GMAIL_DELETE_MESSAGE: "ask", GMAIL_FETCH_EMAILS: "always" });
  });

  test("policies are per user, and meta tools have none", async () => {
    const [a, b] = [await user(), await user()];
    const policy = new PolicyService(database.db);
    await policy.setTool(a, "GOOGLECALENDAR_CREATE_EVENT", "always");
    expect(await policy.mode(a, { slug: "GOOGLECALENDAR_CREATE_EVENT", toolkit: "googlecalendar" })).toBe("always");
    expect(await policy.mode(b, { slug: "GOOGLECALENDAR_CREATE_EVENT", toolkit: "googlecalendar" })).toBe("ask");
    expect(await policy.mode(a, { slug: "COMPOSIO_REMOTE_WORKBENCH", toolkit: null, tags: ["readOnlyHint"] })).toBe("ask");
    expect(policy.setTool(a, "COMPOSIO_MULTI_EXECUTE_TOOL", "always")).rejects.toThrow();
  });
});
