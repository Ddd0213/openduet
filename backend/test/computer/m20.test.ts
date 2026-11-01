// M20 on Claude's computer, through the real agent runtime, run host and approval service on the
// fake computer: masked snapshots (#1), consequential clicks ask first and Approve finds the button
// again (#4), files while the user drives and the build's user_in_control reason (#36), Sleep,
// the auto hand back, recoveryRequired, and a server without a computer (#35).
import { afterEach, describe, expect, test } from "bun:test";
import { takeBuildStop } from "../../src/computer/build-stops.ts";
import { MASKED_VALUE } from "../../src/computer/masking.ts";
import { AUTO_HAND_BACK_MS, RESUME_PROMPT } from "../../src/computer/service.ts";
import { signUp } from "../helpers/session.ts";
import { call, computerRig, messagesOf, sleep, text, type ComputerRig } from "./harness.ts";

let rig: ComputerRig;
afterEach(async () => { await rig?.cleanup(); });

type Card = { id: string; version: number; status: string; toolSlug?: string; preview: Record<string, unknown>; result?: { ok: boolean; error: unknown } | null };
const approvalOf = (frames: Awaited<ReturnType<ComputerRig["send"]>>) => {
  const card = messagesOf(frames).filter((m) => m.kind === "approval").at(-1);
  return card ? (card.payload as { approval: Card }).approval : undefined;
};
const approve = async (r: ComputerRig, approval: { id: string; version: number }) => {
  const response = await r.api(r.alex, `/api/approvals/${approval.id}/approve`, { method: "POST", body: { version: approval.version } });
  expect(response.status).toBe(200);
  return ((await response.json()) as { approval: Card }).approval;
};
const clicks = (r: ComputerRig) => r.fake.calls.filter((c) => c.path === "/click").map((c) => (c.body as { ref: string }).ref);

describe("masked snapshots (#1)", () => {
  test("a password or code value never reaches the model; dropdown options and other values do", async () => {
    rig = await computerRig();
    const secret = "hunter2-correct-horse", code = "771204";
    rig.fake.elements = [
      { role: "textbox", name: "Email", value: "alex@example.com" },
      { role: "textbox", name: "Password", value: secret },
      { role: "textbox", name: "Verification code", value: code },
      { role: "combobox", name: "Country", value: "Norway", options: ["Norway", "Sweden"] },
    ];
    rig.llm.script("chat", [call("computer_navigate", { url: "https://example.com/login" })], [call("computer_snapshot", {})], [text("Looked.")]);
    await rig.send(rig.alex, "Look at the login page");
    const snap = rig.results.find((r) => r.name === "computer_snapshot")!;
    const elements = (snap.data as { elements: Record<string, unknown>[] }).elements;
    expect(elements.map((e) => e.value)).toEqual(["alex@example.com", MASKED_VALUE, MASKED_VALUE, "Norway"]);
    expect(elements[3]!.options).toEqual(["Norway", "Sweden"]);
    const toModel = JSON.stringify(rig.llm.sent("chat").map((x) => x.messages));
    expect(toModel).not.toContain(secret);
    expect(toModel).not.toContain(code);
    expect(toModel).toContain("alex@example.com");
  });
});
describe("consequential clicks (#4)", () => {
  const CART = [{ role: "button", name: "Continue shopping" }, { role: "button", name: "Place your order" }];

  test("Place your order asks first (ToolPolicy says Always); Approve finds the button on a fresh snapshot and clicks it", async () => {
    rig = await computerRig();
    rig.fake.elements = CART;
    rig.llm.script("chat",
      [call("computer_navigate", { url: "https://shop.example.com/cart" })],
      [call("computer_snapshot", {})],
      [call("computer_click", { ref: "s2e2" })],
      [text("Waiting for your OK.")],
    );
    const frames = await rig.send(rig.alex, "Order it");
    const card = approvalOf(frames)!;
    expect(rig.results.find((r) => r.name === "computer_click")!.data).toMatchObject({ status: "awaiting_approval", approvalId: card.id });
    expect(clicks(rig)).toEqual([]);
    expect(card.preview).toMatchObject({ kind: "action", browser: { site: "example.com", button: "Place your order", category: "purchase", via: "click" } });
    // The page re-renders before the user taps Approve: refs are new, the button is found by role + name.
    rig.fake.elements = [{ role: "link", name: "Help" }, ...CART];
    const approved = await approve(rig, card);
    expect(approved.status).toBe("approved");
    expect(clicks(rig)).toEqual([`s${rig.fake.snapshotId - 1}e3`]);
    rig.llm.script("chat", [text("Ordered.")]);
    await rig.send(rig.alex, "Did it work?");
    // The model hears the result next turn, with a fresh snapshot to carry on from.
    const system = rig.llm.sent("chat").at(-1)!.system ?? "";
    expect(system).toContain("Approved by the user and done");
    expect(system).toContain("Place your order");
    const rows = await rig.fixture.db.auditLog.findMany({ where: { action: "computer_click" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.target, r.outcome])).toEqual([["example.com", "needs_approval"], ["example.com", "ok"]]);
  });

  test("the page changed or is another site at Approve: nothing is clicked, the card says why and can be retried", async () => {
    rig = await computerRig();
    rig.fake.elements = CART;
    rig.llm.script("chat",
      [call("computer_navigate", { url: "https://shop.example.com/cart" })],
      [call("computer_snapshot", {})],
      [call("computer_click", { ref: "s2e2" })],
      [text("Waiting.")],
    );
    const card = approvalOf(await rig.send(rig.alex, "Order it"))!;
    rig.fake.elements = [{ role: "button", name: "Continue shopping" }];
    const gone = await approve(rig, card);
    expect(gone.status).toBe("pending");
    expect(JSON.stringify(gone.result)).toContain("that button isn't there any more");
    rig.fake.url = "https://other.example.org/";
    rig.fake.elements = CART;
    const elsewhere = await approve(rig, gone);
    expect(JSON.stringify(elsewhere.result)).toContain("on another site now");
    expect(clicks(rig)).toEqual([]);
    rig.fake.url = "https://shop.example.com/cart";
    expect((await approve(rig, elsewhere)).status).toBe("approved");
    expect(clicks(rig).length).toBe(1);
  });
  test("a ref the server's snapshot doesn't know is refused (fail closed); an ordinary button just clicks", async () => {
    rig = await computerRig();
    rig.llm.script("chat",
      [call("computer_navigate", { url: "https://example.com/login" })],
      [call("computer_snapshot", {})],
      [call("computer_click", { ref: "s2e9" })],
      [call("computer_click", { ref: "s2e3" })],
      [text("Signed in page open.")],
    );
    await rig.send(rig.alex, "Open the sign-in");
    const [unknown, plain] = rig.results.filter((r) => r.name === "computer_click");
    expect(unknown).toMatchObject({ isError: true, data: { reason: "stale_ref" } });
    expect(plain).toMatchObject({ isError: false, data: { ok: true, clicked: "s2e3" } });
    expect(clicks(rig)).toEqual(["s2e3"]);
    expect(await rig.fixture.db.approval.count()).toBe(0);
  });

  test("a Make build is refused a consequential click, with no card, even one the user started", async () => {
    rig = await computerRig({ trustedBuild: () => true });
    rig.fake.elements = [{ role: "button", name: "Delete repository" }];
    rig.llm.script("task",
      [call("computer_navigate", { url: "https://github.com/alex/demo/settings" })],
      [call("computer_snapshot", {})],
      [call("computer_click", { ref: "s2e1" })],
      [text("Skipped it.")],
    );
    const runId = await rig.fixture.runs.submit({ userId: rig.alex.userId, channelId: rig.alex.mainChannelId, taskId: null, kind: "build", prompt: "Build it" });
    await rig.waitFor(rig.alex.userId, (e) => e.type === "done" && e.payload.runId === runId);
    expect(rig.results.find((r) => r.name === "computer_click")).toMatchObject({ isError: true, data: { reason: "needs_user" } });
    expect(clicks(rig)).toEqual([]);
    expect(await rig.fixture.db.approval.count()).toBe(0);
  });

  test("Enter: on the field typed into last (a message box sends: asks); after Tab it needs a ref", async () => {
    rig = await computerRig();
    rig.fake.elements = [{ role: "searchbox", name: "Search" }, { role: "textbox", name: "Write a message" }];
    rig.llm.script("chat",
      [call("computer_navigate", { url: "https://chat.example.com/room" })],
      [call("computer_snapshot", {})],
      [call("computer_type", { ref: "s2e1", text: "weather", submit: true })],
      [call("computer_snapshot", {})],
      [call("computer_type", { ref: "s3e2", text: "hello all" })],
      [call("computer_key", { key: "Enter" })],
      [call("computer_key", { key: "Tab" })],
      [call("computer_key", { key: "Enter" })],
      [text("Waiting.")],
    );
    const frames = await rig.send(rig.alex, "Say hello");
    const types = rig.results.filter((r) => r.name === "computer_type");
    expect(types.map((t) => t.isError)).toEqual([false, false]);
    const keys = rig.results.filter((r) => r.name === "computer_key");
    expect(keys[0]!.data).toMatchObject({ status: "awaiting_approval" });
    expect(keys[1]).toMatchObject({ isError: false, data: { pressed: "Tab" } });
    expect(keys[2]).toMatchObject({ isError: true, data: { reason: "ref_required" } });
    expect(rig.fake.calls.filter((c) => c.path === "/key").map((c) => (c.body as { key: string }).key)).toEqual(["Tab"]);
    expect(approvalOf(frames)!.preview).toMatchObject({ browser: { site: "example.com", button: "Write a message", category: "send", via: "enter" } });
  });

  test("clicks set to Ask: declining one button doesn't refuse another button (the ref alone isn't the call)", async () => {
    rig = await computerRig();
    const r = rig;
    expect((await r.api(r.alex, "/api/computer/policy", { method: "PUT", body: { tool: "computer_click", mode: "ask" } })).status).toBe(200);
    r.fake.elements = [{ role: "button", name: "Next page" }, { role: "button", name: "Show more" }];
    r.llm.script("chat",
      [call("computer_navigate", { url: "https://news.example.com/" })],
      [call("computer_snapshot", {})],
      [call("computer_click", { ref: "s2e1" })],
      async () => {
        // The user taps Not now on that card while Claude carries on in the same turn.
        const card = await r.fixture.db.approval.findFirstOrThrow({ where: { userId: r.alex.userId, status: "pending" } });
        expect((await r.api(r.alex, `/api/approvals/${card.id}/decline`, { method: "POST", body: { version: card.version } })).status).toBe(200);
        return [call("computer_click", { ref: "s2e1" })];
      },
      [call("computer_click", { ref: "s2e2" })],
      [text("Done.")],
    );
    await r.send(r.alex, "Next page");
    const results = r.results.filter((x) => x.name === "computer_click").map((x) => (x.data as { status?: string }).status);
    // Same button: still the user's decision (no new card); another button gets its own card.
    expect(results).toEqual(["awaiting_approval", "declined_by_user", "awaiting_approval"]);
    expect(await r.fixture.db.approval.count()).toBe(2);
    expect(clicks(r)).toEqual([]);
  });

  test("type, then a snapshot, then a bare Enter or Space: focus has no name any more, so the key needs a ref; nothing is pressed", async () => {
    rig = await computerRig();
    rig.fake.elements = [{ role: "textbox", name: "Add a comment" }, { role: "button", name: "Post" }];
    rig.llm.script("chat",
      [call("computer_navigate", { url: "https://news.example.com/item" })],
      [call("computer_snapshot", {})],
      [call("computer_type", { ref: "s2e1", text: "nice post" })],
      [call("computer_snapshot", {})],
      [call("computer_key", { key: "Enter" })],
      [call("computer_key", { key: "Space" })],
      [text("Stopped.")],
    );
    await rig.send(rig.alex, "Comment on it");
    const keys = rig.results.filter((r) => r.name === "computer_key");
    expect(keys.map((k) => (k.data as { reason?: string }).reason)).toEqual(["ref_required", "ref_required"]);
    expect(rig.fake.calls.filter((c) => c.path === "/key")).toEqual([]);
    expect(await rig.fixture.db.approval.count()).toBe(0);
  });
});
describe("files while the user drives (#36)", () => {
  test("reads and lists run now; a write (refused by the computer) waits, then the turn carries on after the hand back", async () => {
    rig = await computerRig({ waitMs: { chat: 300, background: 300 } });
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(rig.fake.root, "notes"), { recursive: true });
    writeFileSync(join(rig.fake.root, "notes/plan.md"), "# Plan\n");
    expect((await rig.api(rig.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);
    rig.llm.script("chat",
      [call("computer_files_read", { path: "notes/plan.md" })],
      [call("computer_files_list", {})],
      [call("computer_files_write", { path: "notes/next.md", contents: "next" })],
      [text("Back on it.")],
    );
    await rig.send(rig.alex, "Read my plan and write the next step");
    expect(rig.results.find((r) => r.name === "computer_files_read")).toMatchObject({ isError: false, data: { text: "# Plan\n" } });
    expect(rig.results.find((r) => r.name === "computer_files_list")!.isError).toBe(false);
    expect(rig.results.find((r) => r.name === "computer_files_write")).toMatchObject({ endTurn: true, data: { status: "user_in_control" } });
    expect(existsSync(join(rig.fake.root, "notes/next.md"))).toBe(false);
    const done = rig.waitFor(rig.alex.userId, (e) => e.type === "done");
    expect((await rig.api(rig.alex, "/api/computer/release", { method: "POST" })).status).toBe(200);
    expect(rig.continued.map((c) => c.prompt)).toEqual([RESUME_PROMPT]);
    await done;
  });

  test("a build that meets the user's Take over ends saying why, and notes user_in_control for its artifact", async () => {
    rig = await computerRig({ waitMs: { chat: 300, background: 300 } });
    expect((await rig.api(rig.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);
    rig.llm.script("task", [call("computer_files_write", { path: "artifacts/a/index.html", contents: "<p>x</p>" })], [text("not reached")]);
    const runId = await rig.fixture.runs.submit({ userId: rig.alex.userId, channelId: rig.alex.mainChannelId, taskId: null, kind: "build", prompt: "Build it" });
    await rig.waitFor(rig.alex.userId, (e) => e.type === "done" && e.payload.runId === runId);
    const write = rig.results.find((r) => r.name === "computer_files_write")!;
    expect(write).toMatchObject({ endTurn: true, data: { status: "user_in_control" } });
    expect(String(write.data.note)).toContain("marked as failed for that reason only");
    expect(takeBuildStop(runId ?? "")).toBe("user_in_control");
    expect(rig.llm.remaining("task")).toBe(1);
  });
});

describe("Sleep (#35)", () => {
  test("409 computer_busy while Claude just used the browser or the user drives; then it closes the browser", async () => {
    let now = Date.now();
    rig = await computerRig({ now: () => now });
    rig.llm.script("chat", [call("computer_navigate", { url: "https://example.com/" })], [text("ok")]);
    await rig.send(rig.alex, "open it");
    const busy = await rig.api(rig.alex, "/api/computer/sleep", { method: "POST" });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe("computer_busy");
    now += 20_000;
    expect((await rig.api(rig.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);
    expect((await rig.api(rig.alex, "/api/computer/sleep", { method: "POST" })).status).toBe(409);
    expect((await rig.api(rig.alex, "/api/computer/release", { method: "POST" })).status).toBe(200);
    expect(rig.fake.stops).toBe(0);
    const slept = await rig.api(rig.alex, "/api/computer/sleep", { method: "POST" });
    expect(slept.status).toBe(200);
    expect(((await slept.json()) as { computer: { browser: string } }).computer.browser).toBe("off");
    expect(rig.fake.stops).toBe(1);
    const live = await rig.fixture.db.message.findFirstOrThrow({ where: { kind: "live_browser" } });
    expect(JSON.parse(live.payload)).toMatchObject({ state: "ended" });
    expect((await rig.fixture.db.auditLog.findMany()).map((a) => [a.action, a.actor, a.outcome])).toContainEqual(["sleep", "user", "ok"]);
  });
});
describe("auto hand back (#35)", () => {
  test("10 minutes without input from the live screen: back to Claude, a grey line in the paused turn's thread, the turn carries on", async () => {
    let now = Date.now();
    rig = await computerRig({ now: () => now, waitMs: { chat: 200, background: 200 } });
    rig.llm.script("chat", [call("computer_navigate", { url: "https://example.com/" })], [text("ok")]);
    await rig.send(rig.alex, "open it");
    expect((await rig.api(rig.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);
    rig.llm.script("chat", [call("computer_scroll", {})], [text("Back on it.")]);
    await rig.send(rig.alex, "keep going");
    const service = rig.computer.service;
    now += AUTO_HAND_BACK_MS - 60_000;
    expect(await service.autoHandBack()).toBe(false);
    service.noteUserInput(); // a tap on the live screen restarts the clock
    now += AUTO_HAND_BACK_MS - 60_000;
    expect(await service.autoHandBack()).toBe(false);
    expect(rig.fake.holder).toBe("human");
    now += 120_000;
    const done = rig.waitFor(rig.alex.userId, (e) => e.type === "done");
    expect(await service.autoHandBack()).toBe(true);
    expect(rig.fake.holder).toBe("bot");
    expect(service.state().controller).toBe("assistant");
    const line = (await rig.fixture.db.message.findMany({ where: { kind: "system" } })).find((m) => m.payload.includes("computer.auto_handback"))!;
    expect(line.channelId).toBe(rig.alex.mainChannelId);
    expect(JSON.parse(line.payload)).toEqual({ phrase: { key: "computer.auto_handback", params: { minutes: { type: "number", value: 10 } } } });
    expect(rig.continued.map((c) => c.prompt)).toEqual([RESUME_PROMPT]);
    await done;
    expect((await rig.fixture.db.auditLog.findMany()).map((a) => [a.action, a.actor])).toContainEqual(["auto_hand_back", "system"]);
    // Nobody holds it now: nothing more to hand back.
    now += AUTO_HAND_BACK_MS * 2;
    expect(await service.autoHandBack()).toBe(false);
  });
});

describe("recoveryRequired (agent-computer da9a3ca)", () => {
  test("a restart interrupted the user's page: Claude stops and asks; take over + hand back clears it and the turn carries on", async () => {
    rig = await computerRig();
    rig.llm.script("chat", [call("computer_navigate", { url: "https://example.com/" })], [text("ok")]);
    await rig.send(rig.alex, "open it");
    rig.fake.recoveryRequired = true;
    rig.llm.script("chat", [call("computer_scroll", {})], [text("Carrying on.")]);
    await rig.send(rig.alex, "scroll down");
    expect(rig.results.at(-1)).toMatchObject({ name: "computer_scroll", endTurn: true, data: { status: "browser_check_needed" } });
    expect(rig.computer.service.needsRecovery).toBe(true);
    expect((await rig.api(rig.alex, "/api/computer/take", { method: "POST" })).status).toBe(200);
    const done = rig.waitFor(rig.alex.userId, (e) => e.type === "done");
    expect((await rig.api(rig.alex, "/api/computer/release", { method: "POST" })).status).toBe(200);
    expect(rig.computer.service.needsRecovery).toBe(false);
    expect(rig.continued.map((c) => c.prompt)).toEqual([RESUME_PROMPT]);
    await done;
  });
});
describe("no computer on this server (#35)", () => {
  test("no tools; the instruction says how the owner turns it on; the new routes are 503; nothing reaches a computer", async () => {
    rig = await computerRig({ configured: false });
    rig.llm.script("chat", [text("I can't browse on this server.")]);
    await rig.send(rig.alex, "Open example.com");
    const request = rig.llm.sent("chat")[0]!;
    expect((request.tools ?? []).some((t) => t.name.startsWith("computer_") || t.name === "request_sign_in" || t.name === "send_file")).toBe(false);
    expect(request.system).toContain("isn't set up on this server");
    expect(request.system).toContain("./scripts/setup.sh --computer on");
    for (const path of ["/api/computer/sleep", "/api/computer/sign-in/00000000-0000-4000-8000-000000000000/code", "/api/computer/sign-in/00000000-0000-4000-8000-000000000000/take-over", "/api/computer/sign-in/00000000-0000-4000-8000-000000000000/dismiss"]) {
      expect([path, (await rig.api(rig.alex, path, { method: "POST", body: {} })).status]).toEqual([path, 503]);
    }
    expect(rig.fake.calls.length).toBe(0);
  });

  test("another account on a server whose computer is someone else's is told so, without the setup hint", async () => {
    rig = await computerRig();
    await sleep(5);
    const sam = await signUp(rig.fixture, "sam");
    rig.llm.script("chat", [text("Not mine.")]);
    await rig.send(sam, "Open example.com");
    const system = rig.llm.sent("chat").at(-1)!.system ?? "";
    expect(system).toContain("isn't set up on this server");
    expect(system).toContain("belongs to another account");
    expect(system).not.toContain("setup.sh");
  });
});

describe("Ask / Always rows (#9)", () => {
  test("every Claude's computer row says whether Always is allowed", async () => {
    rig = await computerRig();
    const detail = (await (await rig.api(rig.alex, "/api/computer/tools")).json()) as { tools: { slug: string; alwaysAllowed: boolean; alwaysBlocked: string | null }[] };
    expect(detail.tools.length).toBe(14);
    expect(detail.tools.map(t => t.slug)).toEqual(expect.arrayContaining(["computer_files_edit", "computer_files_search"]));
    expect(detail.tools.every((t) => t.alwaysAllowed === true && t.alwaysBlocked === null)).toBe(true);
    expect((await rig.api(rig.alex, "/api/computer/policy", { method: "PUT", body: { tool: "computer_exec", mode: "always" } })).status).toBe(200);
  });
});
