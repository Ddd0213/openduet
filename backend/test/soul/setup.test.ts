// M22 W5: setting up "who Claude is" in the chat (soul/setup.ts, propose_soul_setup, the soul_setup
// card). The new user's trigger after the first-day profile read, the existing user's one-time
// invitation, POST /api/soul/intro, the card (current filled in, Apply writes all, Not now none, a
// newer card supersedes an open older one) and the instruction staying out of every other turn.
// Scripted model only: one script round per model call; quick_replies ends a turn.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TurnInput } from "../../src/agent/types.ts";
import { Soul } from "../../src/contract/m11.ts";
import { SoulIntroResponse } from "../../src/contract/m22.ts";
import { MessageActionResponse, type Message } from "../../src/contract/messages.ts";
import { LlmError } from "../../src/llm/index.ts";
import { INTRO_PROMPT, soulSetupLines, soulSetupTurn } from "../../src/soul/setup.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { readSse, type SseFrames } from "../helpers/sse.ts";
import { toolResults } from "../make/harness.ts";
import { act, call, channelOf, chatIn, json, lastSystem, messagesOf, startMemoryApp, text, type MemoryApp } from "../memory/harness.ts";
import { deferred } from "../tasks/harness.ts";

let m: MemoryApp;
beforeAll(async () => {
  m = await startMemoryApp();
});
afterAll(() => m.fixture.cleanup());

const SETUP = "[Setting up who you are for the user, in this chat]";
const DEFAULT = "Use the default";

const introAt = async (user: SignedIn) => (await m.fixture.db.user.findUniqueOrThrow({ where: { id: user.userId } })).soulIntroAt;
const getSoul = async (user: SignedIn) => Soul.parse(await (await m.fixture.app.request("/api/soul", { headers: user.headers })).json());
const putSoul = (user: SignedIn, body: unknown) => m.fixture.app.request("/api/soul", json(user, "PUT", body));
const lastToolResults = () => toolResults(m.llm.sent("chat").at(-1));

/** An existing user: onboarded a while ago, their first-day scan long past (none recorded here). */
const onboard = (user: SignedIn) => m.fixture.db.user.update({ where: { id: user.userId }, data: { onboardedAt: new Date(Date.now() - 30 * 86_400_000) } });

/** The user's first-day scan as the proactive service records it (kind scan, scheduledFor = onboardedAt). */
async function firstDayScan(user: SignedIn) {
  const at = new Date(Date.now() - 60_000);
  await m.fixture.db.user.update({ where: { id: user.userId }, data: { onboardedAt: at } });
  await m.fixture.db.run.create({ data: { userId: user.userId, kind: "scan", status: "completed", channelId: user.mainChannelId, scheduledFor: at } });
}

/** A Claude quick_replies card in the main thread, as confirm_profile / quick_replies post it. */
function quickReplies(user: SignedIn, options: string[], textValue = "") {
  return m.fixture.db.message.create({ data: {
    userId: user.userId, channelId: user.mainChannelId, role: "assistant", kind: "quick_replies", text: textValue,
    payload: JSON.stringify({ options, chosen: null }),
  } });
}

/** The newest quick_replies card of the user's main thread. */
const lastChips = (user: SignedIn) =>
  m.fixture.db.message.findFirstOrThrow({ where: { userId: user.userId, channelId: user.mainChannelId, kind: "quick_replies" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });

/** A message in the main thread (a chip tap when `chip` is given), read until the turn's `done`. */
async function say(user: SignedIn, body: string, clientId: string, chip?: { id: string }): Promise<SseFrames> {
  const request = { text: body, clientId, ...(chip ? { quickReply: { messageId: chip.id, option: body } } : {}) };
  const response = await m.fixture.app.request(`/api/channels/${user.mainChannelId}/messages`, json(user, "POST", request));
  expect(response.status).toBeLessThan(300);
  return readSse(response, { until: (frames) => frames.events.some((e) => e.type === "done") });
}

/** The question text (a text bubble) comes before the turn's new chips (a tapped card's update may come first). */
function questionBeforeChips(frames: SseFrames, question: string) {
  const posted = messagesOf(frames);
  const asked = posted.findIndex((x) => x.kind === "text" && x.role === "assistant" && x.text.includes(question));
  const chips = posted.findLastIndex((x) => x.kind === "quick_replies" && x.payload.chosen === null);
  expect(asked).toBeGreaterThanOrEqual(0);
  expect(chips).toBeGreaterThan(asked);
  return posted[chips] as Extract<Message, { kind: "quick_replies" }>;
}

const setupCard = async (response: Response) => {
  expect(response.status).toBe(200);
  const message = MessageActionResponse.parse(await response.json()).message;
  if (message.kind !== "soul_setup") throw new Error(`kind ${message.kind}`);
  return message;
};
/** The open soul_setup card the turn posted (a superseded older one's update comes after it). */
function cardIn(frames: SseFrames) {
  const found = messagesOf(frames).filter((x): x is Extract<Message, { kind: "soul_setup" }> => x.kind === "soul_setup" && x.payload.state === "open").at(-1);
  if (!found) throw new Error("no open soul_setup card");
  return found;
}

describe("new user: after the first-day profile read", () => {
  test("Sounds right starts the setup: one question per turn, question first, chips last, then one card", async () => {
    const ivy = await signUp(m.fixture, "ivy", "Ivy Chen");
    await firstDayScan(ivy);
    const profile = await quickReplies(ivy, ["Sounds right", "Something's off"], "If any of these sound off, just let me know and I'll learn.");

    // Round 1 (the reply to the profile read).
    m.llm.script("chat", [text("Great. "), text("What should I call you?"), call("quick_replies", { options: ["Ivy", "Ives", DEFAULT] })]);
    const one = await say(ivy, "Sounds right", "ivy-1", profile);
    expect(lastSystem(m)).toContain(SETUP);
    expect(lastSystem(m)).toContain("reply to your first-day profile read");
    expect(lastSystem(m)).toContain("ask round 1");
    expect(lastSystem(m)).toContain("This turn's one question is: addressAs");
    expect(lastSystem(m)).toContain("MUST end by calling quick_replies");
    expect(lastSystem(m)).toContain("omit text: it would repeat the question on screen");
    const started = await introAt(ivy);
    expect(started).not.toBeNull();
    expect(questionBeforeChips(one, "What should I call you?").payload.options.at(-1)).toBe(DEFAULT);

    // Round 2: the chip answer; the instruction says where it stands.
    m.llm.script("chat", [text("And what should I call myself?"), call("quick_replies", { options: ["Juniper", "Claude", DEFAULT] })]);
    const two = await say(ivy, "Ives", "ivy-2", await lastChips(ivy));
    expect(lastSystem(m)).toContain("1 of 3 questions asked so far");
    expect(lastSystem(m)).toContain("ask round 2");
    expect(lastSystem(m)).toContain("This turn's one question is: name");
    questionBeforeChips(two, "And what should I call myself?");

    // Round 3: "Use the default" skips the name.
    m.llm.script("chat", [text("How should I sound?"), call("quick_replies", { options: ["Warm and brief", "Dry and direct", DEFAULT] })]);
    await say(ivy, DEFAULT, "ivy-3", await lastChips(ivy));
    expect(lastSystem(m)).toContain("2 of 3 questions asked so far");
    expect(lastSystem(m)).toContain("ask round 3");
    expect(lastSystem(m)).toContain("This turn's one question is: tone");

    // A typed answer to the last round: read back, then one card.
    m.llm.script("chat",
      [text("So: I'll call you Ives and keep it warm and brief."), call("propose_soul_setup", { fields: [{ field: "addressAs", proposed: "Ives" }, { field: "tone", proposed: "Warm and brief" }], reason: "What you chose just now." })],
      [text("Tap Apply to keep it.")]);
    const four = await say(ivy, "warm and brief please", "ivy-4");
    expect(lastSystem(m)).toContain("3 of 3 questions asked so far");
    expect(lastSystem(m)).toContain("All rounds are asked");
    expect(lastSystem(m)).toContain("This turn has NO question");
    expect(lastSystem(m)).not.toContain("This turn's one question is:");
    const card = cardIn(four);
    expect(card).toMatchObject({ role: "assistant", channelId: ivy.mainChannelId, payload: { state: "open", reason: "What you chose just now.", fields: [{ field: "addressAs", current: "", proposed: "Ives" }, { field: "tone", current: "", proposed: "Warm and brief" }] } });
    expect(await getSoul(ivy)).toMatchObject({ addressAs: "", tone: "" });

    // Done: the next turn has no setup lines, and soulIntroAt never moves.
    await say(ivy, "thanks", "ivy-5");
    expect(lastSystem(m)).not.toContain(SETUP);
    expect(await introAt(ivy)).toEqual(started);
  });

  test("Something's off: first ask what's off (not started yet), then remember it and start", async () => {
    const leo = await signUp(m.fixture, "leo", "Leo Park");
    await firstDayScan(leo);
    const profile = await quickReplies(leo, ["Sounds right", "Something's off"]);

    m.llm.script("chat", [text("What did I get wrong?")]);
    await say(leo, "Something's off", "leo-1", profile);
    expect(lastSystem(m)).toContain("tapped \"Something's off\"");
    expect(lastSystem(m)).not.toContain("ask round 1");
    expect(await introAt(leo)).toBeNull();

    m.llm.script("chat", [call("remember", { fact: "Leo is a designer, not a manager" })], [text("Got it. Now, what should I call you?"), call("quick_replies", { options: ["Leo", DEFAULT] })]);
    await say(leo, "I'm a designer, not a manager", "leo-2");
    expect(lastSystem(m)).toContain("just told you what was off");
    expect(lastSystem(m)).toContain("ask round 1");
    expect(await introAt(leo)).not.toBeNull();
    expect(await m.fixture.db.memory.count({ where: { userId: leo.userId, text: "Leo is a designer, not a manager" } })).toBe(1);
  });

  test("a setup question without chips gets one model nudge, with no repeated question", async () => {
    const user = await signUp(m.fixture, "setupchips", "Robin Lee");
    await firstDayScan(user);
    m.llm.script("chat", [text("What should I call you?")], [call("quick_replies", { options: ["Robin", DEFAULT] })]);
    const before = m.llm.sent("chat").length;
    const frames = await say(user, "Sounds right", "setupchips-1");
    expect(m.llm.sent("chat").length - before).toBe(2);
    expect(JSON.stringify(m.llm.sent("chat").at(-1)?.messages)).toContain("The question is already on screen");
    expect(messagesOf(frames).filter((x) => x.kind === "text" && x.role === "assistant").map((x) => x.text)).toEqual(["What should I call you?"]);
    expect(questionBeforeChips(frames, "What should I call you?").payload.options).toEqual(["Robin", DEFAULT]);
  });

  test("missing setup chips are nudged at most once; a topic change isn't restarted", async () => {
    const user = await signUp(m.fixture, "setupbound", "Rowan Lee");
    await firstDayScan(user);
    m.llm.script("chat", [text("What should I call you?")], [text("You can type it here.")]);
    const before = m.llm.sent("chat").length;
    await say(user, "Sounds right", "setupbound-1");
    expect(m.llm.sent("chat").length - before).toBe(2);

    const other = await signUp(m.fixture, "setupdrop", "Jules Lee");
    await firstDayScan(other);
    m.llm.script("chat", [text("What should I call you?"), call("quick_replies", { options: ["Jules", DEFAULT] })]);
    await say(other, "Sounds right", "setupdrop-1");
    m.llm.script("chat", [text("Which city do you mean?")], [text("(pass)")]);
    const changed = await say(other, "Forget setup, what's the weather?", "setupdrop-2");
    expect(messagesOf(changed).some((x) => x.kind === "quick_replies")).toBe(false);
    expect(messagesOf(changed).filter((x) => x.kind === "text" && x.role === "assistant").map((x) => x.text)).toEqual(["Which city do you mean?"]);
    await say(other, "Paris", "setupdrop-3");
    expect(lastSystem(m)).not.toContain(SETUP);
  });

  test("their first message, when the app wasn't open for the scan, starts it too", async () => {
    const max = await signUp(m.fixture, "max", "Max Roy");
    await firstDayScan(max);
    m.llm.script("chat", [text("Hi Max! What should I call you?"), call("quick_replies", { options: ["Max", DEFAULT] })]);
    await say(max, "hey, what can you do?", "max-1");
    expect(lastSystem(m)).toContain("their first message, if they weren't there for it");
    expect(await introAt(max)).not.toBeNull();
  });
});

describe("existing user: one invitation (the server posts it, M23 W4)", () => {
  /** The server's invitation card: the one-line offer with exactly Sure / Later. */
  const INVITE = "Want me to set up how I talk with you? What to call you, my name and my tone.";
  const invitations = async (user: SignedIn) => m.fixture.db.message.count({ where: { userId: user.userId, kind: "quick_replies", text: INVITE } });

  test("fewer than 3 fields: the server posts one invitation after the reply and only then writes soulIntroAt; Later, and it's never offered again", async () => {
    const nadia = await signUp(m.fixture, "nadia", "Nadia Park");
    await onboard(nadia);
    await putSoul(nadia, { name: "Juniper" });
    m.llm.script("chat", [text("It's 4 pm in Lisbon.")]);
    const frames = await say(nadia, "what time is it in Lisbon?", "nadia-1");
    expect(lastSystem(m)).toContain(SETUP);
    expect(lastSystem(m)).toContain("the app adds one line offering to set up how you talk with them");
    expect(lastSystem(m)).toContain("don't call quick_replies in this turn");
    const offered = await introAt(nadia);
    expect(offered).not.toBeNull();
    const card = questionBeforeChips(frames, "It's 4 pm in Lisbon.");
    expect(card).toMatchObject({ role: "assistant", text: INVITE, payload: { options: ["Sure", "Later"], chosen: null } });
    expect(messagesOf(frames).at(-1)?.id).toBe(card.id);

    await say(nadia, "Later", "nadia-2", await lastChips(nadia));
    expect(lastSystem(m)).not.toContain(SETUP);
    await say(nadia, "and in Tokyo?", "nadia-3");
    expect(lastSystem(m)).not.toContain(SETUP);
    expect(await introAt(nadia)).toEqual(offered);
    expect(await invitations(nadia)).toBe(1);
  });

  test("the M22 bug: the model posts its own quick replies in the invitation's turn; they're dropped and the server's invitation still comes", async () => {
    const yara = await signUp(m.fixture, "yara", "Yara Haddad");
    await onboard(yara);
    m.llm.script("chat",
      [text("Lisbon is on WET."), call("quick_replies", { options: ["Tell me more", "Thanks"], text: "Anything else?" })],
      [text("Ask me anything else any time.")]);
    const frames = await say(yara, "which time zone is Lisbon in?", "yara-1");
    const chips = messagesOf(frames).filter((x) => x.kind === "quick_replies");
    expect(chips.map((x) => x.text)).toEqual([INVITE]);
    expect(chips.every((x) => x.kind === "quick_replies" && x.payload.options.join("|") === "Sure|Later")).toBe(true);
    expect(lastToolResults()).toContain("No buttons were shown");
    expect(lastToolResults()).toContain("invitation");
    expect(await introAt(yara)).not.toBeNull();
    expect(await m.fixture.db.message.count({ where: { userId: yara.userId, kind: "quick_replies", text: "Anything else?" } })).toBe(0);
  });

  test("no invitation without a reply the user saw, or when the turn fails: soulIntroAt stays empty and a later turn invites", async () => {
    const zed = await signUp(m.fixture, "zed", "Zed Moss");
    await onboard(zed);
    m.llm.script("chat", [text("(pass)")]);
    await say(zed, "ok", "zed-1");
    expect(await introAt(zed)).toBeNull();
    expect(await invitations(zed)).toBe(0);

    m.llm.script("chat", new LlmError({ kind: "http", status: 502, providerId: "scripted-test-only", modelId: "scripted-test-only", attempts: 3 }));
    await say(zed, "hello?", "zed-2");
    expect(await introAt(zed)).toBeNull();
    expect(await invitations(zed)).toBe(0);

    m.llm.script("chat", [text("Hi Zed!")]);
    await say(zed, "hi", "zed-3");
    expect(await introAt(zed)).not.toBeNull();
    expect(await invitations(zed)).toBe(1);
  });

  test("Sure starts round 1; a typed answer lets Claude read it", async () => {
    const omar = await signUp(m.fixture, "omar", "Omar Ali");
    await onboard(omar);
    m.llm.script("chat", [text("Done, I'll remind you.")]);
    await say(omar, "remind me to call mum", "omar-1");
    m.llm.script("chat", [text("What should I call you?"), call("quick_replies", { options: ["Omar", DEFAULT] })]);
    await say(omar, "Sure", "omar-2", await lastChips(omar));
    expect(lastSystem(m)).toContain("said yes to setting this up");

    const pia = await signUp(m.fixture, "pia", "Pia Lund");
    await onboard(pia);
    m.llm.script("chat", [text("Here you go.")]);
    await say(pia, "hello", "pia-1");
    await say(pia, "ok go ahead", "pia-2");
    expect(lastSystem(m)).toContain("Your last message offered to set this up");
  });

  test("not onboarded yet: never invited (the new user's path comes after onboarding)", async () => {
    const ada = await signUp(m.fixture, "ada", "Ada Kim");
    m.llm.script("chat", [text("Hello!")]);
    await say(ada, "hello", "ada-1");
    expect(lastSystem(m)).not.toContain(SETUP);
    expect(await introAt(ada)).toBeNull();
    expect(await invitations(ada)).toBe(0);
  });

  test("3 or more fields set: never invited, soulIntroAt stays empty", async () => {
    const quinn = await signUp(m.fixture, "quinn", "Quinn Ma");
    await onboard(quinn);
    await putSoul(quinn, { name: "Juniper", addressAs: "Q", tone: "Brief" });
    await say(quinn, "hi", "quinn-1");
    expect(lastSystem(m)).not.toContain(SETUP);
    expect(await introAt(quinn)).toBeNull();
  });
});

describe("POST /api/soul/intro", () => {
  test("202 with the main thread and the run, queued behind the running turn; sets soulIntroAt once; the intro turn gets the instruction", async () => {
    const rosa = await signUp(m.fixture, "rosa", "Rosa Diaz");
    // 3 fields: her own chat turn invites nothing, so only the intro sets soulIntroAt.
    await putSoul(rosa, { name: "Juniper", addressAs: "Ro", tone: "Brief" });
    const entered = deferred();
    const gate = deferred();
    m.llm.script("chat", async () => { entered.resolve(); await gate.promise; return [text("Sorry, one sec.")]; });
    const running = say(rosa, "summarise my week", "rosa-1");
    await entered.promise;
    expect(await introAt(rosa)).toBeNull();

    const response = await m.fixture.app.request("/api/soul/intro", json(rosa, "POST"));
    expect(response.status).toBe(202);
    const body = SoulIntroResponse.parse(await response.json());
    expect(body.channelId).toBe(rosa.mainChannelId);
    const first = await introAt(rosa);
    expect(first).not.toBeNull();
    expect(await m.fixture.db.run.findUniqueOrThrow({ where: { id: body.runId } })).toMatchObject({ status: "queued", kind: "chat", channelId: rosa.mainChannelId, taskId: null });

    m.llm.script("chat", [text("I'll ask three quick questions. What should I call you?"), call("quick_replies", { options: ["Rosa", DEFAULT] })]);
    gate.resolve();
    await running;
    await m.fixture.runs.idle();
    expect((await m.fixture.db.run.findUniqueOrThrow({ where: { id: body.runId } })).status).toBe("completed");
    const intro = m.llm.sent("chat").at(-1)!;
    expect(JSON.stringify(intro.messages.at(-1))).toContain("Set up in chat");
    expect(intro.system).toContain("asked to set this up now");
    expect(INTRO_PROMPT).toContain("from the server, not the user");

    // Asked again later (from Settings): queued again; soulIntroAt keeps its first value.
    const again = await m.fixture.app.request("/api/soul/intro", json(rosa, "POST"));
    expect(again.status).toBe(202);
    await m.fixture.runs.idle();
    expect(await introAt(rosa)).toEqual(first);
    expect((await m.fixture.app.request("/api/soul/intro", { method: "POST" })).status).toBe(401);
  });

  test("a question asked, then the user talks about something else: the setup is dropped", async () => {
    const sol = await signUp(m.fixture, "sol", "Sol Kim");
    m.llm.script("chat", [text("What should I call you?"), call("quick_replies", { options: ["Sol", DEFAULT] })]);
    expect((await m.fixture.app.request("/api/soul/intro", json(sol, "POST"))).status).toBe(202);
    await m.fixture.runs.idle();
    m.llm.script("chat", [text("Sunny, 21°C.")]);
    await say(sol, "actually, what's the weather?", "sol-1");
    expect(lastSystem(m)).toContain("1 of 3 questions asked so far");
    await say(sol, "thanks", "sol-2");
    expect(lastSystem(m)).not.toContain(SETUP);
  });
});

describe("propose_soul_setup and the soul_setup card", () => {
  test("posts an open card with current from the soul, in the soul's order, without unchanged fields; Apply writes them all at once", async () => {
    const tara = await signUp(m.fixture, "tara", "Tara Bell");
    await putSoul(tara, { name: "Juniper", tone: "Warm and brief" });
    m.llm.script("chat", [call("propose_soul_setup", { fields: [
      { field: "persona", proposed: " Calm, notices details " }, { field: "name", proposed: "Penny" },
      { field: "addressAs", proposed: "T" }, { field: "tone", proposed: "Warm and brief" },
    ], reason: "What you picked." })], [text("Here it is.")]);
    const card = cardIn(await say(tara, "set it up like that", "tara-1"));
    expect(card.payload).toEqual({ state: "open", reason: "What you picked.", fields: [
      { field: "name", current: "Juniper", proposed: "Penny" },
      { field: "addressAs", current: "", proposed: "T" },
      { field: "persona", current: "", proposed: "Calm, notices details" },
    ] });
    expect(lastToolResults()).toContain("\\\"unchanged\\\":[\\\"tone\\\"]");
    expect(lastToolResults()).toContain("Nothing changes until the user taps Apply");
    expect(await getSoul(tara)).toMatchObject({ name: "Juniper", addressAs: "", persona: "", tone: "Warm and brief" });

    // Only the card's own user; only Apply / Not now.
    const other = await signUp(m.fixture, "uma", "Uma Roy");
    expect((await act(m, card.id, "apply", other)).status).toBe(404);
    const undo = await act(m, card.id, "undo", tara);
    expect(undo.status).toBe(400);
    expect(await errorOf(undo)).toMatchObject({ code: "validation_failed", field: "action" });

    expect((await setupCard(await act(m, card.id, "apply", tara))).payload.state).toBe("applied");
    expect(await getSoul(tara)).toMatchObject({ name: "Penny", addressAs: "T", identity: "", persona: "Calm, notices details", tone: "Warm and brief" });
    // Decided: a second Apply or a late Not now answers as it is.
    await putSoul(tara, { name: "By hand" });
    expect((await setupCard(await act(m, card.id, "apply", tara))).payload.state).toBe("applied");
    expect((await setupCard(await act(m, card.id, "dismiss", tara))).payload.state).toBe("applied");
    expect((await getSoul(tara)).name).toBe("By hand");
  });

  test("Not now writes nothing; Apply afterwards does nothing", async () => {
    const vic = await signUp(m.fixture, "vic", "Vic Hale");
    await putSoul(vic, { tone: "Steady" });
    const before = await getSoul(vic);
    m.llm.script("chat", [call("propose_soul_setup", { fields: [{ field: "name", proposed: "Penny" }, { field: "tone", proposed: "Playful" }], reason: "r" })], [text("ok")]);
    const card = cardIn(await say(vic, "go", "vic-1"));
    expect((await setupCard(await act(m, card.id, "dismiss", vic))).payload.state).toBe("dismissed");
    expect((await setupCard(await act(m, card.id, "apply", vic))).payload.state).toBe("dismissed");
    expect(await getSoul(vic)).toEqual(before);
  });

  test("a second card supersedes the open first one (an update event); the old one can't be applied, the new one can", async () => {
    const wes = await signUp(m.fixture, "wes", "Wes Ford");
    m.llm.script("chat", [call("propose_soul_setup", { fields: [{ field: "name", proposed: "Juniper" }, { field: "tone", proposed: "Brief" }], reason: "first" })], [text("ok")]);
    const first = cardIn(await say(wes, "set it up", "wes-1"));
    m.llm.script("chat", [call("propose_soul_setup", { fields: [{ field: "name", proposed: "Penny" }, { field: "tone", proposed: "Brief" }], reason: "changed my mind" })], [text("ok")]);
    const frames = await say(wes, "actually call yourself Penny", "wes-2");
    const second = cardIn(frames);
    expect(second.id).not.toBe(first.id);
    expect(messagesOf(frames).some((x) => x.id === first.id && x.kind === "soul_setup" && x.payload.state === "superseded")).toBe(true);
    expect(lastToolResults()).toContain(first.id);

    expect((await setupCard(await act(m, first.id, "apply", wes))).payload.state).toBe("superseded");
    expect((await getSoul(wes)).name).toBe("");
    expect((await setupCard(await act(m, second.id, "apply", wes))).payload.state).toBe("applied");
    expect(await getSoul(wes)).toMatchObject({ name: "Penny", tone: "Brief" });

    // A decided card stays as it is when a third one comes.
    m.llm.script("chat", [call("propose_soul_setup", { fields: [{ field: "name", proposed: "Pip" }], reason: "again" })], [text("ok")]);
    await say(wes, "one more", "wes-3");
    expect((await setupCard(await act(m, second.id, "dismiss", wes))).payload.state).toBe("applied");
  });

  test("refused: a field twice, over the limit, all unchanged, an unknown field, none; no card", async () => {
    const xia = await signUp(m.fixture, "xia", "Xia Wu");
    await putSoul(xia, { tone: "Steady" });
    m.llm.script("chat", [
      call("propose_soul_setup", { fields: [{ field: "name", proposed: "A" }, { field: "name", proposed: "B" }], reason: "r" }),
      call("propose_soul_setup", { fields: [{ field: "name", proposed: "n".repeat(41) }], reason: "r" }),
      call("propose_soul_setup", { fields: [{ field: "tone", proposed: " Steady " }], reason: "r" }),
      call("propose_soul_setup", { fields: [{ field: "soulExtra", proposed: "x" }], reason: "r" }),
      call("propose_soul_setup", { fields: [], reason: "r" }),
    ], [text("ok")]);
    const frames = await say(xia, "change yourself", "xia-1");
    expect(messagesOf(frames).some((x) => x.kind === "soul_setup")).toBe(false);
    const results = lastToolResults();
    expect(results).toContain("name is listed twice");
    expect(results).toContain("name is at most 40 characters");
    expect(results).toContain("Every field is already at that value");
    expect(results).toContain("Invalid tool arguments");
  });
});

describe("the instruction stays out of other turns", () => {
  test("an ordinary turn, a channel turn and the turns that aren't the main thread's chat get no setup lines and set nothing", async () => {
    // Ordinary: set up already (3 fields, offered before).
    const yan = await signUp(m.fixture, "yan", "Yan Li");
    await putSoul(yan, { name: "Juniper", addressAs: "Y", tone: "Brief" });
    await m.fixture.db.user.update({ where: { id: yan.userId }, data: { soulIntroAt: new Date(Date.now() - 86_400_000) } });
    await say(yan, "what's on today?", "yan-1");
    expect(lastSystem(m)).not.toContain(SETUP);

    // Would be invited, but writes in a channel: nothing there, nothing set.
    const zoe = await signUp(m.fixture, "zoe", "Zoe Fox");
    await onboard(zoe);
    const shop = await channelOf(m, zoe, { name: "Bike shop", purpose: "Orders" });
    await chatIn(m, "any orders?", "zoe-1", { user: zoe, channelId: shop.id });
    expect(lastSystem(m)).not.toContain(SETUP);
    expect(await introAt(zoe)).toBeNull();

    // The hook itself: a task turn, background kinds, a synthetic non-intro turn, a voice call.
    const row = await m.fixture.db.message.create({ data: { userId: zoe.userId, channelId: zoe.mainChannelId, role: "user", kind: "text", text: "hi" } });
    const message = (over: Partial<Message> = {}) => ({
      id: row.id, channelId: zoe.mainChannelId, taskId: null, role: "user", kind: "text", text: "hi", status: "sent", clientId: null, reactions: [],
      stopped: false, callId: null, createdAt: row.createdAt.toISOString(), updatedAt: row.createdAt.toISOString(),
      payload: { skill: null, attachments: [], replyTo: null, taskResult: null, forwarded: null }, ...over,
    }) as Message;
    const turn = (over: Partial<TurnInput>, msg = message(), onboardedAt: Date | null = new Date(Date.now() - 86_400_000)) => ({
      db: m.fixture.db, channel: { isMain: true }, user: { soulIntroAt: null, onboardedAt, language: "en" }, rows: [row],
      input: { userId: zoe.userId, channelId: zoe.mainChannelId, taskId: null, runId: "run_x", userMessage: msg, attachments: [], skill: null, sink: undefined as never, signal: new AbortController().signal, ...over } as TurnInput,
    });
    expect(await soulSetupLines(turn({ kind: "task", taskId: "task_1" }))).toEqual([]);
    for (const kind of ["brief", "checkin", "scan", "routine", "build"] as const) expect(await soulSetupLines(turn({ kind }))).toEqual([]);
    expect(await soulSetupLines(turn({}, message({ id: "turn_handback", text: "[The user handed the computer back.]" })))).toEqual([]);
    expect(await soulSetupLines(turn({}, message({ callId: "call_1" })))).toEqual([]);
    expect(await soulSetupTurn(turn({}, message(), null))).toEqual({ lines: [], mode: null });
    expect(await introAt(zoe)).toBeNull();
    // The same message as a plain chat turn would be the invitation; working it out writes nothing.
    const invite = await soulSetupTurn(turn({}));
    expect(invite.mode).toEqual({ kind: "invite" });
    expect(invite.lines.join("\n")).toContain("the app adds one line offering to set up");
    expect(await introAt(zoe)).toBeNull();
  });
});

describe("M23 W4: the chips of a setup question (agent/replies.ts)", () => {
  test("a question's chips always end with \"Use the default\" (appended when left out); long or extra suggestions are dropped", async () => {
    const ivo = await signUp(m.fixture, "ivo", "Ivo Brandt");
    await firstDayScan(ivo);
    const profile = await quickReplies(ivo, ["Sounds right", "Something's off"]);
    m.llm.script("chat", [text("What should I call you?"), call("quick_replies", { options: ["Ivo", "a name that is much too long for a chip", "Mr Brandt", "Doc"] })]);
    const frames = await say(ivo, "Sounds right", "ivo-1", profile);
    expect(questionBeforeChips(frames, "What should I call you?").payload.options).toEqual(["Ivo", "Mr Brandt", DEFAULT]);

    // Round 2: the default given first is put last, once.
    m.llm.script("chat", [text("And what should I call myself?"), call("quick_replies", { options: [DEFAULT, "Juniper"] })]);
    const two = await say(ivo, "Ivo", "ivo-2", await lastChips(ivo));
    expect(lastSystem(m)).toContain("1 of 3 questions asked so far");
    expect(questionBeforeChips(two, "And what should I call myself?").payload.options).toEqual(["Juniper", DEFAULT]);
    // Still counted as a setup question on the next turn.
    m.llm.script("chat", [text("How should I sound?"), call("quick_replies", { options: ["Warm"] })]);
    await say(ivo, "Juniper", "ivo-3", await lastChips(ivo));
    expect(lastSystem(m)).toContain("2 of 3 questions asked so far");
  });

  test("\"Something's off\": an open question, so no chips even if the model sends some", async () => {
    const uma = await signUp(m.fixture, "umaoff", "Uma Off");
    await firstDayScan(uma);
    const profile = await quickReplies(uma, ["Sounds right", "Something's off"]);
    m.llm.script("chat", [text("What did I get wrong?"), call("quick_replies", { options: ["Job", "Location"] })], [text("Tell me in your own words.")]);
    const frames = await say(uma, "Something's off", "uma-1", profile);
    expect(messagesOf(frames).some((x) => x.kind === "quick_replies" && x.payload.chosen === null)).toBe(false);
    expect(lastToolResults()).toContain("open question");
  });
});
