// The sign-in card (L141, M20) end to end on the fake computer: request_sign_in posts the card for
// the page that's really open (domain only), the card's POST hands the login to the computer's own
// /sign-in/fill for that page's origin, a site that asks for a code moves the card to step "code"
// (/code -> /sign-in/code), "Take control instead" and "Not now" close it, and Claude carries on.
// The email, password and code must never show up in the database, the model's requests or the logs.
import { afterEach, describe, expect, test } from "bun:test";
import { DISMISSED_PROMPT, SIGNED_IN_PROMPT, TAKEN_OVER_PROMPT } from "../../src/computer/signin.ts";
import { signUp } from "../helpers/session.ts";
import { call, computerRig, messagesOf, sleep, text, type ComputerRig } from "./harness.ts";

let rig: ComputerRig;
afterEach(async () => { await rig?.cleanup(); });

const EMAIL = "alex.private@example.net";
const PASSWORD = "correct-horse-battery-staple-9!";
const CODE = "482913";

type SignInCard = { requestId: string; domain: string; state: string; step: string; reason: unknown; outcome: unknown };

/** Navigate to a login page and ask for sign-in (domain only); returns the card and the frames. */
async function askForSignIn(r: ComputerRig, domain = "example.com", args: Record<string, unknown> = {}) {
  r.llm.script("chat",
    [call("computer_navigate", { url: "https://example.com/login" })],
    [call("request_sign_in", { domain, ...args })],
    [text("Carrying on after the card.")],
  );
  const frames = await r.send(r.alex, "Log in to example.com for me");
  const card = messagesOf(frames).filter((m) => m.kind === "sign_in").at(-1);
  return { frames, card, payload: card?.payload as SignInCard | undefined };
}

const post = (r: ComputerRig, path: string, body?: unknown, who = r.alex) =>
  r.api(who, `/api/computer/sign-in/${path}`, { method: "POST", ...(body === undefined ? {} : { body }) });
const submit = (r: ComputerRig, requestId: string, body: unknown, who = r.alex) => post(r, requestId, body, who);
const stored = async (r: ComputerRig, messageId: string) => JSON.parse((await r.fixture.db.message.findUniqueOrThrow({ where: { id: messageId } })).payload) as SignInCard;
const doneEvent = (r: ComputerRig) => r.waitFor(r.alex.userId, (e) => e.type === "done");

/** Captures everything written to stdout / stderr while `run` runs. */
async function capture(run: () => Promise<void>): Promise<string> {
  const logged: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => { logged.push(String(chunk)); return (out as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { logged.push(String(chunk)); return (err as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stdout.write = out as typeof process.stdout.write;
    process.stderr.write = err as typeof process.stderr.write;
  }
  return logged.join("");
}

/** None of these values anywhere but the computer: database, model requests, the fake's call log, logs. */
async function expectNowhere(r: ComputerRig, logged: string, secrets: string[]) {
  const db = JSON.stringify([
    await r.fixture.db.message.findMany(), await r.fixture.db.event.findMany(), await r.fixture.db.auditLog.findMany(),
    await r.fixture.db.approval.findMany(), await r.fixture.db.run.findMany(),
  ]);
  const toModel = JSON.stringify(r.llm.requests.map((x) => ({ system: x.system, messages: x.messages, tools: x.tools })));
  for (const secret of secrets) {
    expect(db).not.toContain(secret);
    expect(toModel).not.toContain(secret);
    expect(JSON.stringify(r.fake.calls)).not.toContain(secret);
    expect(logged).not.toContain(secret);
  }
}

describe("sign-in card (L141, M20)", () => {
  test("the card shows the open page's domain; /sign-in/fill types the login on that origin; Claude carries on", async () => {
    rig = await computerRig();
    const logged = await capture(async () => {
      const { card, payload } = await askForSignIn(rig);
      expect(card).toBeDefined();
      expect(payload).toMatchObject({ domain: "example.com", state: "pending", step: "credentials", reason: null, outcome: null });
      const result = rig.results.find((x) => x.name === "request_sign_in")!;
      expect(result).toMatchObject({ endTurn: true, data: { status: "awaiting_user", requestId: payload!.requestId, domain: "example.com" } });
      expect(rig.llm.remaining("chat")).toBe(1);
      // No snapshot or field refs were needed, and nothing reached the computer for the card itself.
      expect(rig.fake.calls.some((c) => c.path === "/snapshot" || c.path.startsWith("/sign-in"))).toBe(false);

      const done = doneEvent(rig);
      const response = await submit(rig, payload!.requestId, { email: EMAIL, password: PASSWORD });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ requestId: payload!.requestId, state: "sent", step: "credentials", reason: null, outcome: null });
      expect(rig.fake.logins).toEqual([{ username: EMAIL, password: PASSWORD }]);
      const fill = rig.fake.calls.find((c) => c.path === "/sign-in/fill")!;
      expect(fill.body).toEqual({ origin: "https://example.com", username: "[kept out]", password: "[kept out]" });
      expect(await stored(rig, card!.id)).toEqual({ requestId: payload!.requestId, domain: "example.com", state: "sent", step: "credentials", reason: null, outcome: null });
      expect(rig.continued).toEqual([{ userId: rig.alex.userId, channelId: rig.alex.mainChannelId, kind: "chat", prompt: SIGNED_IN_PROMPT }]);
      await done;
      expect(rig.llm.remaining("chat")).toBe(0);
      const audit = await rig.fixture.db.auditLog.findMany({ orderBy: { createdAt: "asc" } });
      expect(audit.map((a) => [a.action, a.actor, a.target, a.outcome])).toEqual(expect.arrayContaining([
        ["sign_in_request", "assistant", "example.com", "ok"],
        ["sign_in", "user", "example.com", "ok"],
      ]));
    });
    await expectNowhere(rig, logged, [PASSWORD, EMAIL]);
  });

  test("one use only; someone else's or an unknown card is 404; a bad body is a plain 400", async () => {
    rig = await computerRig();
    const { payload } = await askForSignIn(rig);
    const id = payload!.requestId;
    const sam = await signUp(rig.fixture, "sam");
    // Another account has no computer (one owner per deployment).
    expect((await submit(rig, id, { email: EMAIL, password: PASSWORD }, sam)).status).toBe(503);
    expect((await submit(rig, "00000000-0000-4000-8000-000000000000", { email: EMAIL, password: PASSWORD })).status).toBe(404);
    for (const body of [{ email: "", password: PASSWORD }, { email: EMAIL }, { email: EMAIL, password: PASSWORD, extra: 1 }, "not json"]) {
      const bad = await submit(rig, id, body);
      expect(bad.status).toBe(400);
      expect(await bad.text()).not.toContain(PASSWORD);
    }
    // None of those touched the page or used the card up.
    expect(rig.fake.logins).toEqual([]);
    const done = doneEvent(rig);
    expect(await (await submit(rig, id, { email: EMAIL, password: PASSWORD })).json()).toMatchObject({ state: "sent" });
    const again = await submit(rig, id, { email: EMAIL, password: "another-try" });
    expect(again.status).toBe(409);
    expect(rig.fake.logins.length).toBe(1);
    expect(rig.continued.length).toBe(1);
    await done;
  });
  test("an expired card says so and sends nothing", async () => {
    rig = await computerRig({ signInTtlMs: 200 });
    const { card, payload } = await askForSignIn(rig);
    await sleep(300);
    const response = await submit(rig, payload!.requestId, { email: EMAIL, password: PASSWORD });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ requestId: payload!.requestId, state: "expired" });
    expect(rig.fake.logins).toEqual([]);
    expect(rig.continued).toEqual([]);
    expect(await stored(rig, card!.id)).toMatchObject({ state: "expired" });
    expect(await (await submit(rig, payload!.requestId, { email: EMAIL, password: PASSWORD })).json()).toMatchObject({ state: "expired" });
  });

  test("after a restart, a card left pending turns expired; a live one is left alone", async () => {
    rig = await computerRig();
    const { card } = await askForSignIn(rig);
    // A card from before a restart: in the database, unknown to this process.
    const orphan = await rig.fixture.db.message.create({ data: {
      userId: rig.alex.userId, channelId: rig.alex.mainChannelId, role: "assistant", kind: "sign_in", text: "", status: "sent",
      payload: JSON.stringify({ requestId: "11111111-1111-4111-8111-111111111111", domain: "old.example", state: "pending" }),
    } });
    expect(await rig.computer.signIn.recover()).toBe(1);
    expect(await stored(rig, orphan.id)).toMatchObject({ state: "expired" });
    expect(await stored(rig, card!.id)).toMatchObject({ state: "pending" });
  });

  test("a sign-in for another site than the open page is refused, with no card; old field refs are accepted and ignored", async () => {
    rig = await computerRig();
    const { card } = await askForSignIn(rig, "bank.example.org", { emailRef: "s1e1", passwordRef: "s1e2", snapshotId: 1 });
    expect(card).toBeUndefined();
    const result = rig.results.find((x) => x.name === "request_sign_in")!;
    expect(result.isError).toBe(true);
    expect(String(result.data.error)).toContain("example.com");
    expect(rig.fake.calls.some((c) => c.path.startsWith("/sign-in"))).toBe(false);
  });

  test("a computer that can't take the details: failed (signin.failed), retry works, once delivered it's 409", async () => {
    rig = await computerRig();
    const { payload } = await askForSignIn(rig);
    rig.fake.down = true;
    expect(await (await submit(rig, payload!.requestId, { email: EMAIL, password: PASSWORD })).json())
      .toMatchObject({ requestId: payload!.requestId, state: "failed", step: "credentials", reason: { key: "signin.failed" } });
    expect(rig.continued).toEqual([]);
    expect((await rig.fixture.db.auditLog.findMany()).map((a) => [a.action, a.outcome])).toContainEqual(["sign_in", "error"]);
    rig.fake.down = false;
    const done = doneEvent(rig);
    const retried = await submit(rig, payload!.requestId, { email: EMAIL, password: PASSWORD });
    expect(await retried.json()).toMatchObject({ requestId: payload!.requestId, state: "sent", reason: null });
    expect(rig.fake.logins.length).toBe(1);
    expect(rig.continued.length).toBe(1);
    expect((await submit(rig, payload!.requestId, { email: EMAIL, password: PASSWORD })).status).toBe(409);
    await done;
  });

  test("the browser is on another site now: the computer refuses, nothing is typed, the card says wrong page", async () => {
    rig = await computerRig();
    const { card, payload } = await askForSignIn(rig);
    // Another turn (or the user's own Take over) navigated the shared browser meanwhile.
    rig.fake.url = "https://attacker.example.net/login";
    const answer = await (await submit(rig, payload!.requestId, { email: EMAIL, password: PASSWORD })).json();
    expect(answer).toMatchObject({ state: "failed", step: "credentials", reason: { key: "signin.wrong_page", params: { domain: { type: "text", value: "example.com" } } } });
    expect(rig.fake.logins).toEqual([]);
    expect(rig.continued).toEqual([]);
    expect(await stored(rig, card!.id)).toMatchObject({ state: "failed", reason: { key: "signin.wrong_page" } });
    // The computer's own sentence never reaches the card.
    expect(JSON.stringify(answer)).not.toContain("Bot's browser");
  });

  test("no form, a refused password, a login that moves away: each its own reason", async () => {
    rig = await computerRig();
    const { payload } = await askForSignIn(rig);
    const id = payload!.requestId;
    rig.fake.signIn = "no_form";
    expect(await (await submit(rig, id, { email: EMAIL, password: PASSWORD })).json()).toMatchObject({ state: "failed", reason: { key: "signin.no_form" } });
    rig.fake.signIn = "rejected";
    expect(await (await submit(rig, id, { email: EMAIL, password: PASSWORD })).json()).toMatchObject({ state: "failed", step: "credentials", reason: { key: "signin.rejected" } });
    rig.fake.signIn = "moves";
    expect(await (await submit(rig, id, { email: EMAIL, password: PASSWORD })).json()).toMatchObject({ state: "failed", reason: { key: "signin.moved" } });
    expect(rig.continued).toEqual([]);
  });

  test("the site asks for a code: the card goes to step code; a wrong code keeps it there; the right one signs in", async () => {
    rig = await computerRig();
    rig.fake.signIn = "code";
    rig.fake.acceptCode = CODE;
    const logged = await capture(async () => {
      const { card, payload } = await askForSignIn(rig);
      const id = payload!.requestId;
      // The code route refuses a card that isn't at the code step.
      expect((await post(rig, `${id}/code`, { code: CODE })).status).toBe(400);
      expect(await (await submit(rig, id, { email: EMAIL, password: PASSWORD })).json()).toMatchObject({ state: "sent", step: "code", reason: null });
      expect(await stored(rig, card!.id)).toMatchObject({ state: "pending", step: "code" });
      expect(rig.continued).toEqual([]);
      // The password step can't be sent again while the card waits for the code.
      expect((await submit(rig, id, { email: EMAIL, password: PASSWORD })).status).toBe(400);
      for (const body of [{ code: "" }, { code: CODE, extra: 1 }, "not json"]) {
        const bad = await post(rig, `${id}/code`, body);
        expect(bad.status).toBe(400);
        expect(await bad.text()).not.toContain(CODE);
      }
      expect(await (await post(rig, `${id}/code`, { code: "000000" })).json()).toMatchObject({ state: "failed", step: "code", reason: { key: "signin.code_rejected" } });
      const done = doneEvent(rig);
      // Signed in answers step "credentials", so "sent" + "code" only ever means "the site wants a code".
      expect(await (await post(rig, `${id}/code`, { code: CODE })).json()).toMatchObject({ state: "sent", step: "credentials", reason: null });
      expect(await stored(rig, card!.id)).toMatchObject({ state: "sent" });
      expect(rig.fake.codes).toEqual(["000000", CODE]);
      expect(rig.fake.calls.find((c) => c.path === "/sign-in/code")!.body).toEqual({ origin: "https://example.com", username: undefined, password: undefined, code: "[kept out]" });
      expect(rig.continued.map((c) => c.prompt)).toEqual([SIGNED_IN_PROMPT]);
      await done;
      expect((await rig.fixture.db.auditLog.findMany()).map((a) => [a.action, a.outcome])).toEqual(expect.arrayContaining([["sign_in", "ok"], ["sign_in_code", "error"], ["sign_in_code", "ok"]]));
    });
    await expectNowhere(rig, logged, [PASSWORD, EMAIL, CODE]);
  });

  test("Take control instead: the card closes as taken over, the user gets the browser; Claude carries on after the hand back", async () => {
    rig = await computerRig();
    const { card, payload } = await askForSignIn(rig);
    const answer = await (await post(rig, `${payload!.requestId}/take-over`)).json() as { state: string; outcome: string; computer: { controller: string } };
    expect(answer).toMatchObject({ state: "expired", outcome: "taken_over", computer: { controller: "user" } });
    expect(rig.fake.holder).toBe("human");
    expect(await stored(rig, card!.id)).toMatchObject({ state: "expired", outcome: "taken_over" });
    // Used up: the card can't be sent or taken over again.
    expect((await submit(rig, payload!.requestId, { email: EMAIL, password: PASSWORD })).status).toBe(409);
    expect(rig.continued).toEqual([]);
    const done = doneEvent(rig);
    expect((await rig.api(rig.alex, "/api/computer/release", { method: "POST" })).status).toBe(200);
    expect(rig.continued.map((c) => c.prompt)).toEqual([TAKEN_OVER_PROMPT]);
    await done;
    expect((await rig.fixture.db.auditLog.findMany()).map((a) => [a.action, a.actor])).toEqual(expect.arrayContaining([["sign_in_take_over", "user"], ["take_over", "user"]]));
  });

  test("Not now: the card closes as dismissed and Claude carries on, told the user didn't sign in", async () => {
    rig = await computerRig();
    const { card, payload } = await askForSignIn(rig);
    const done = doneEvent(rig);
    expect(await (await post(rig, `${payload!.requestId}/dismiss`)).json()).toMatchObject({ state: "expired", outcome: "dismissed", computer: null });
    expect(await stored(rig, card!.id)).toMatchObject({ state: "expired", outcome: "dismissed" });
    expect(rig.continued.map((c) => c.prompt)).toEqual([DISMISSED_PROMPT]);
    await done;
    expect(rig.fake.logins).toEqual([]);
    expect((await post(rig, `${payload!.requestId}/dismiss`)).status).toBe(409);
    expect((await post(rig, "00000000-0000-4000-8000-000000000000/take-over")).status).toBe(404);
  });

  test("a newer sign-in request replaces the older card: it expires", async () => {
    rig = await computerRig();
    const first = await askForSignIn(rig);
    // A second request (another turn) on the same page, straight through the service.
    const sink = { upsertMessage: (draft: { role: "assistant"; kind: string; payload: unknown }) => rig.fixture.db.message.create({ data: {
      userId: rig.alex.userId, channelId: rig.alex.mainChannelId, role: draft.role, kind: draft.kind, text: "", status: "sent", payload: JSON.stringify(draft.payload),
    } }) as never };
    const turn = { userId: rig.alex.userId, channelId: rig.alex.mainChannelId, taskId: null, kind: "chat" as const, runId: "run-2" };
    const second = await rig.computer.signIn.request(turn, sink as never, { domain: "example.com", pageUrl: "https://example.com/login" });
    expect("requestId" in second && second.requestId).not.toBe(first.payload!.requestId);
    expect(await stored(rig, first.card!.id)).toMatchObject({ state: "expired" });
    expect(await (await submit(rig, first.payload!.requestId, { email: EMAIL, password: PASSWORD })).json()).toMatchObject({ state: "expired" });
    expect(rig.fake.logins).toEqual([]);
  });
});
