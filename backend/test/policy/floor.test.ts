// M20 safety floor (policy/floor.ts) with real Composio slugs: payments, credentials and security
// settings never get Always ("floor"); tools that send to other people get Always only per
// recipient on the card ("per_recipient"); reads, drafts and tidying are never blocked. And
// PolicyService: a stored Always on such a tool (tool row or "All tools") reads as Ask.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AlwaysBlocked } from "../../src/contract/m20.ts";
import { alwaysBlockedFor, alwaysFields } from "../../src/policy/floor.ts";
import { PolicyService, toolkitKey } from "../../src/policy/service.ts";
import { createTestDatabase } from "../helpers/db.ts";

const toolkitOf = (slug: string) => slug.split("_")[0]!.toLowerCase();
const blocked = (slug: string, toolkit: string | null = toolkitOf(slug), tags?: string[]) => alwaysBlockedFor({ slug, toolkit, ...(tags ? { tags } : {}) });
const each = (slugs: string[]) => Object.fromEntries(slugs.map((slug) => [slug, blocked(slug)]));
const all = (slugs: string[], value: AlwaysBlocked | null) => Object.fromEntries(slugs.map((slug) => [slug, value]));

describe("alwaysBlockedFor", () => {
  test("payments and money movement are on the floor", () => {
    const slugs = ["STRIPE_CREATE_REFUND", "STRIPE_CREATE_PAYMENT_INTENT", "STRIPE_CREATE_CUSTOMER", "PAYPAL_CREATE_PAYOUT", "SQUARE_CREATE_PAYMENT",
      "WISE_CREATE_TRANSFER", "QUICKBOOKS_SEND_INVOICE", "SHOPIFY_PLACE_ORDER", "ACME_CHARGE_CARD", "ACME_BUY_CREDITS", "CHARGEBEE_CREATE_SUBSCRIPTION"];
    expect(each(slugs)).toEqual(all(slugs, "floor"));
  });

  test("passwords, credentials, keys and tokens are on the floor", () => {
    const slugs = ["GITHUB_CREATE_OR_UPDATE_A_REPOSITORY_SECRET", "GITHUB_CREATE_A_DEPLOY_KEY", "GITHUB_REVOKE_AN_INSTALLATION_ACCESS_TOKEN",
      "OKTA_RESET_FACTORS", "ACME_RESET_PASSWORD", "ACME_UPDATE_API_KEY", "ACME_ADD_SSH_KEY", "ACME_ENABLE_2FA", "ACME_REGENERATE_RECOVERY_CODES"];
    expect(each(slugs)).toEqual(all(slugs, "floor"));
  });

  test("security settings, roles, sharing, admin, auth and member access are on the floor", () => {
    const slugs = ["GITHUB_ADD_A_REPOSITORY_COLLABORATOR", "GITHUB_UPDATE_BRANCH_PROTECTION", "GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE",
      "GOOGLEDRIVE_CREATE_PERMISSION", "SLACK_INVITE_USERS_TO_A_SLACK_CHANNEL", "DISCORDBOT_ADD_GUILD_MEMBER_ROLE", "GMAIL_ADD_DELEGATE",
      "GMAIL_UPDATE_AUTO_FORWARDING", "ACME_UPDATE_SSO_SETTINGS", "ACME_REVOKE_ACCESS", "ACME_REMOVE_MEMBER", "ACME_UPDATE_SECURITY_SETTINGS"];
    expect(each(slugs)).toEqual(all(slugs, "floor"));
  });

  test("tools that send to other people are per recipient (drafts aren't; sending a draft is)", () => {
    const slugs = ["GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD", "GMAIL_FORWARD_MESSAGE", "GMAIL_SEND_DRAFT", "OUTLOOK_SEND_EMAIL",
      "SLACK_SEND_MESSAGE", "SLACK_CHAT_POST_MESSAGE", "SLACK_SCHEDULE_MESSAGE", "SLACK_UPDATES_A_SLACK_MESSAGE", "SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK",
      "DISCORD_CREATE_MESSAGE", "TELEGRAM_SEND_MESSAGE", "TWITTER_CREATION_OF_A_POST", "LINKEDIN_CREATE_LINKED_IN_POST",
      "INSTAGRAM_PUBLISH_MEDIA", "GITHUB_CREATE_AN_ISSUE_COMMENT", "GOOGLEDRIVE_SHARE_FILE", "TWILIO_SEND_SMS"];
    expect(each(slugs)).toEqual(all(slugs, "per_recipient"));
  });

  test("reads, drafts, tidying and ordinary writes keep their Always", () => {
    const slugs = ["GMAIL_FETCH_EMAILS", "GMAIL_GET_PROFILE", "STRIPE_LIST_CHARGES", "GITHUB_GET_A_REPOSITORY_PUBLIC_KEY", "GITHUB_LIST_REPOSITORY_SECRETS",
      "GMAIL_CREATE_EMAIL_DRAFT", "OUTLOOK_CREATE_DRAFT_REPLY", "GMAIL_DELETE_MESSAGE", "GMAIL_MOVE_TO_TRASH", "GMAIL_ADD_LABEL_TO_EMAIL",
      "GMAIL_BATCH_MODIFY_MESSAGES", "SLACK_DELETES_A_MESSAGE_FROM_A_CHAT", "SLACK_ADD_REACTION_TO_AN_ITEM", "GOOGLECALENDAR_CREATE_EVENT",
      "NOTION_CREATE_NOTION_PAGE", "GITHUB_CREATE_AN_ISSUE", "GOOGLEDOCS_UPDATE_EXISTING_DOCUMENT", "SLACK_CREATE_CHANNEL"];
    expect(each(slugs)).toEqual(all(slugs, null));
    // A readOnly tag makes a write-sounding slug a read only when no write word is in it.
    expect(blocked("ACME_PROFILE", "acme", ["readOnlyHint"])).toBeNull();
    expect(blocked("ACME_SEND_DIGEST", "acme", ["readOnlyHint"])).toBe("per_recipient");
  });

  test("Claude's computer and the duet: cards are never blocked; custom connector names are read like slugs", () => {
    for (const slug of ["computer_exec", "computer_key", "computer_files_write", "computer_click"]) {
      expect([slug, blocked(slug, "duet_computer")]).toEqual([slug, null]);
    }
    expect(blocked("computer_exec", null)).toBeNull();
    for (const slug of ["duet:request_payment", "duet:run_skill_script", "duet:browser_action"]) expect([slug, blocked(slug, null)]).toEqual([slug, null]);
    expect(blocked("cm3abc123:send_message", "custom-cm3abc123")).toBe("per_recipient");
    expect(blocked("cm3abc123:createRefund", "custom-cm3abc123")).toBe("floor");
    expect(blocked("cm3abc123:list_tickets", "custom-cm3abc123")).toBeNull();
  });

  test("alwaysFields: the ConnectorTool fields", () => {
    expect(alwaysFields({ slug: "STRIPE_CREATE_REFUND", toolkit: "stripe" })).toEqual({ alwaysAllowed: false, alwaysBlocked: "floor" });
    expect(alwaysFields({ slug: "GMAIL_SEND_EMAIL", toolkit: "gmail" })).toEqual({ alwaysAllowed: false, alwaysBlocked: "per_recipient" });
    expect(alwaysFields({ slug: "GMAIL_FETCH_EMAILS", toolkit: "gmail" })).toEqual({ alwaysAllowed: true, alwaysBlocked: null });
  });
});

describe("PolicyService and the floor", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => { database = await createTestDatabase(); });
  afterAll(async () => { await database.cleanup(); });

  async function user() {
    const id = crypto.randomUUID();
    await database.db.user.create({ data: { id, name: "Alex", username: id, authEmail: `${id}@test.invalid` } });
    return id;
  }

  test("a stored Always on a blocked tool reads as Ask, from a tool row or the toolkit's All tools", async () => {
    const userId = await user();
    const policy = new PolicyService(database.db);
    const send = { slug: "GMAIL_SEND_EMAIL", toolkit: "gmail" }, remove = { slug: "GMAIL_DELETE_MESSAGE", toolkit: "gmail" }, fetch = { slug: "GMAIL_FETCH_EMAILS", toolkit: "gmail" };
    const refund = { slug: "STRIPE_CREATE_REFUND", toolkit: "stripe" };
    // Rows as they were stored before M20 (no data migration).
    await database.db.toolPolicy.createMany({ data: [{ userId, toolSlug: "GMAIL_SEND_EMAIL", mode: "always" }, { userId, toolSlug: "STRIPE_CREATE_REFUND", mode: "always" }, { userId, toolSlug: "GMAIL_DELETE_MESSAGE", mode: "always" }] });
    expect(Object.fromEntries(await policy.modes(userId, [send, remove, fetch, refund]))).toEqual({ GMAIL_SEND_EMAIL: "ask", GMAIL_DELETE_MESSAGE: "always", GMAIL_FETCH_EMAILS: "always", STRIPE_CREATE_REFUND: "ask" });
    expect(await policy.mode(userId, refund)).toBe("ask");

    await policy.setToolkit(userId, "gmail", "always", ["GMAIL_SEND_EMAIL", "GMAIL_DELETE_MESSAGE", "GMAIL_FETCH_EMAILS"]);
    expect(Object.fromEntries(await policy.modes(userId, [send, remove, fetch]))).toEqual({ GMAIL_SEND_EMAIL: "ask", GMAIL_DELETE_MESSAGE: "always", GMAIL_FETCH_EMAILS: "always" });
    expect((await database.db.toolPolicy.findMany({ where: { userId, toolSlug: { startsWith: "toolkit:" } } })).map((r) => [r.toolSlug, r.mode])).toEqual([[toolkitKey("gmail"), "always"]]);
    // The computer's own defaults are untouched.
    expect(await policy.mode(userId, { slug: "computer_click", toolkit: "duet_computer", defaultMode: "always" })).toBe("always");
  });
});
