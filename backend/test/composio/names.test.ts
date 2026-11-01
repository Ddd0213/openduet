// Display names (L168), categories (L126), account labels and the "not configured" gateway.
import { describe, expect, test } from "bun:test";
import { accountLabelFrom, categoryOf, displayName, emailFrom, isMetaTool, scrubSlugs, toolDisplayName, toolkitOfSlug } from "../../src/composio/names.ts";
import { createComposioGateway, SdkComposioGateway } from "../../src/composio/sdk.ts";

describe("names", () => {
  test("display names, never slugs", () => {
    expect(displayName("googlecalendar")).toBe("Google Calendar");
    expect(displayName("googledocs", "googledocs")).toBe("Google Docs");
    expect(displayName("github", "Github")).toBe("GitHub");
    expect(displayName("someapp", "Some App")).toBe("Some App");
    expect(displayName("some_app")).toBe("Some App");
  });

  test("tool names in sentence case", () => {
    expect(toolDisplayName("GMAIL_SEND_EMAIL", "Send Email", "gmail")).toBe("Send email");
    expect(toolDisplayName("GOOGLECALENDAR_CREATE_EVENT", null, "googlecalendar")).toBe("Create event");
    expect(toolDisplayName("ACME_EXPORT_PDF", "Export PDF", "acme")).toBe("Export PDF");
  });

  test("toolkit of a slug by the longest prefix; meta tools", () => {
    expect(toolkitOfSlug("GOOGLECALENDAR_FIND_EVENT", ["google", "googlecalendar", "gmail"])).toBe("googlecalendar");
    expect(toolkitOfSlug("UNKNOWN_THING", ["gmail"])).toBeNull();
    expect(isMetaTool("COMPOSIO_REMOTE_WORKBENCH")).toBe(true);
    expect(isMetaTool("composio_remote_bash_tool")).toBe(true);
    expect(isMetaTool("GMAIL_SEND_EMAIL")).toBe(false);
  });

  test("categories for the Claude sheet", () => {
    expect(categoryOf("gmail")).toBe("mail");
    expect(categoryOf("googlecalendar")).toBe("calendar");
    expect(categoryOf("googledocs")).toBe("files");
    expect(categoryOf("slack")).toBe("team_chat");
    expect(categoryOf("stripe")).toBe("payments");
    expect(categoryOf("zohomail", ["Email"])).toBe("mail");
    expect(categoryOf("acme", ["Developer tools"])).toBeNull();
  });

  test("slugs in guidance text become display names", () => {
    const names = new Map([["gmail", "Gmail"], ["googlecalendar", "Google Calendar"]]);
    expect(scrubSlugs("Use gmail search; googlecalendar times. GMAIL_SEND_EMAIL stays.", names)).toBe("Use Gmail search; Google Calendar times. GMAIL_SEND_EMAIL stays.");
  });

  test("account labels come from whitelisted keys only, never tokens", () => {
    expect(accountLabelFrom({ access_token: "ya29.secret", email: "alex@example.com" })).toBe("alex@example.com");
    expect(accountLabelFrom({ user: { login: "alexk" } })).toBe("alexk");
    expect(accountLabelFrom({ access_token: "ya29.secret", email: "not-an-email" })).toBeNull();
    expect(emailFrom({ data: { emailAddress: "sam@example.com" } })).toBe("sam@example.com");
    expect(emailFrom({ token: "x" })).toBeNull();
  });
});

describe("the SDK gateway", () => {
  test("no COMPOSIO_API_KEY: not configured", () => {
    expect(createComposioGateway({})).toBeNull();
    expect(createComposioGateway({ COMPOSIO_API_KEY: undefined })).toBeNull();
    // M20: always behind guardOutbound (composio/gateway.ts): a credential in the arguments is refused
    // by the guard before the SDK gateway (or the network) sees it.
    const gateway = createComposioGateway({ COMPOSIO_API_KEY: "test-only-not-a-key" });
    expect(gateway).not.toBeNull();
    expect(gateway).not.toBeInstanceOf(SdkComposioGateway);
  });

  test("M20: the configured gateway refuses an execution carrying a credential, without any network call", async () => {
    const gateway = createComposioGateway({ COMPOSIO_API_KEY: "test-only-not-a-key" })!;
    const refused = await gateway.execute("u1", "GMAIL_SEND_EMAIL", { recipient_email: "sam@example.com", password: "hunter2" });
    expect(refused).toMatchObject({ ok: false, kind: "invalid_arguments", error: expect.stringContaining("Not sent:") });
  });

  test("meta tools are refused and non-https logos aren't fetched, without any network call", async () => {
    const gateway = new SdkComposioGateway("test-only-not-a-key");
    expect(await gateway.execute("u1", "COMPOSIO_REMOTE_BASH_TOOL", { cmd: "ls" })).toMatchObject({ ok: false, kind: "not_found" });
    expect(await gateway.executeForAccount("u1", "ca_1", "COMPOSIO_REMOTE_WORKBENCH", {})).toMatchObject({ ok: false });
    expect(await gateway.getTools(["COMPOSIO_SEARCH_TOOLS"])).toEqual([]);
    expect(await gateway.fetchLogo("http://logos.test.invalid/x.png")).toBeNull();
  });
});
