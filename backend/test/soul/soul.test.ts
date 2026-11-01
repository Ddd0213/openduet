// M11-A: the soul. GET / PUT /api/soul (one row per user, empty strings until the first PUT), the
// soul in the prompt, propose_soul_change (an open soul_proposal with `current` filled in; nothing
// changes until Apply) and the card's Apply / Not now, including a channel's soulExtra.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Soul } from "../../src/contract/m11.ts";
import { MessageActionResponse } from "../../src/contract/messages.ts";
import type { DuetEvent } from "../../src/contract/events.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { toolResults } from "../make/harness.ts";
import { act, call, cardOf, channelOf, chatIn, json, lastSystem, startMemoryApp, text, type MemoryApp } from "../memory/harness.ts";

let m: MemoryApp;
let sam: SignedIn;
beforeAll(async () => {
  m = await startMemoryApp();
  sam = await signUp(m.fixture, "sam", "Sam Lee");
});
afterAll(() => m.fixture.cleanup());

const EMPTY = { name: "", addressAs: "", identity: "", persona: "", tone: "", updatedAt: null };
const getSoul = async (user: SignedIn = m.alex) => {
  const response = await m.fixture.app.request("/api/soul", { headers: user.headers });
  expect(response.status).toBe(200);
  return Soul.parse(await response.json());
};
const putSoul = (body: unknown, user: SignedIn = m.alex) => m.fixture.app.request("/api/soul", json(user, "PUT", body));
const lastToolResults = () => toolResults(m.llm.sent("chat").at(-1));
const proposalOf = async (response: Response) => {
  expect(response.status).toBe(200);
  const message = MessageActionResponse.parse(await response.json()).message;
  if (message.kind !== "soul_proposal") throw new Error(`kind ${message.kind}`);
  return message;
};
const hasCard = (frames: Awaited<ReturnType<typeof chatIn>>) =>
  frames.events.some((e) => e.type === "message" && e.payload.message.kind === "soul_proposal");

describe("GET / PUT /api/soul", () => {
  test("no row: empty strings and updatedAt null; no session is 401", async () => {
    const nadia = await signUp(m.fixture, "nadia", "Nadia Park");
    expect(await getSoul(nadia)).toEqual(EMPTY);
    expect(await m.fixture.db.soul.count({ where: { userId: nadia.userId } })).toBe(0);
    expect((await m.fixture.app.request("/api/soul")).status).toBe(401);
    expect((await m.fixture.app.request("/api/soul", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
  });

  test("PUT creates the one row, trims, and merges: fields left out keep their value", async () => {
    const first = await putSoul({ name: "  Juniper ", tone: "Warm and brief\n" });
    expect(first.status).toBe(200);
    const created = Soul.parse(await first.json());
    expect(created).toMatchObject({ name: "Juniper", addressAs: "", identity: "", persona: "", tone: "Warm and brief" });
    expect(created.updatedAt).not.toBeNull();

    const second = Soul.parse(await (await putSoul({ addressAs: "Al", identity: "Alex's chief of staff" })).json());
    expect(second).toMatchObject({ name: "Juniper", addressAs: "Al", identity: "Alex's chief of staff", tone: "Warm and brief" });
    // An empty string is a value too: back to the default.
    expect(Soul.parse(await (await putSoul({ name: "" })).json()).name).toBe("");
    expect(await getSoul()).toMatchObject({ name: "", addressAs: "Al", identity: "Alex's chief of staff", tone: "Warm and brief" });
    expect(await m.fixture.db.soul.count({ where: { userId: m.alex.userId } })).toBe(1);
    // Someone else's soul is untouched.
    expect(await getSoul(sam)).toEqual(EMPTY);
  });

  test("bad bodies are 400 validation_failed with the field and change nothing", async () => {
    const before = await getSoul();
    const tooLong = await putSoul({ name: "x".repeat(41) });
    expect(tooLong.status).toBe(400);
    expect(await errorOf(tooLong)).toMatchObject({ code: "validation_failed", field: "name" });
    const unknown = await putSoul({ mood: "grumpy" });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).code).toBe("validation_failed");
    expect((await putSoul({ tone: 5 })).status).toBe(400);
    expect((await putSoul({ persona: "p".repeat(4001) })).status).toBe(400);
    const notJson = await m.fixture.app.request("/api/soul", { method: "PUT", headers: { ...m.alex.headers, "Content-Type": "application/json" }, body: "{" });
    expect(notJson.status).toBe(400);
    expect(await getSoul()).toEqual(before);
  });

  test("the prompt carries the saved soul as quoted values, after the defaults are replaced", async () => {
    await putSoul({ name: "Juniper", addressAs: "Al", persona: "Calm" });
    m.llm.script("chat", [text("hi")]);
    await chatIn(m, "hello", "soul-prompt");
    const system = lastSystem(m);
    expect(system).toContain("Your name in replies: \"Juniper\"");
    expect(system).toContain("Address the user as: \"Al\"");
    expect(system).toContain("Persona: \"Calm\"");
    expect(system).not.toContain("Your name in replies: \"OpenDuet\"");
  });
});
describe("soul_proposal", () => {
  test("propose_soul_change posts an open card with current filled in; nothing changes until Apply; Apply writes it once", async () => {
    await putSoul({ tone: "Warm and brief" });
    m.llm.script("chat", [call("propose_soul_change", { field: "tone", proposed: "  Dry and to the point ", reason: "You asked me to stop cushioning things." })], [text("I've suggested a change.")]);
    const card = cardOf(await chatIn(m, "be blunter", "p-1"), "soul_proposal");
    expect(card).toMatchObject({ role: "assistant", channelId: m.alex.mainChannelId, payload: { field: "tone", current: "Warm and brief", proposed: "Dry and to the point", reason: "You asked me to stop cushioning things.", state: "open" } });
    expect(lastToolResults()).toContain("Nothing changes until the user taps Apply");
    expect((await getSoul()).tone).toBe("Warm and brief");

    // Only the card's own user; only Apply / Not now.
    expect((await act(m, card.id, "apply", sam)).status).toBe(404);
    const undo = await act(m, card.id, "undo");
    expect(undo.status).toBe(400);
    expect(await errorOf(undo)).toMatchObject({ code: "validation_failed", field: "action" });
    expect((await getSoul()).tone).toBe("Warm and brief");

    const applied = await proposalOf(await act(m, card.id, "apply"));
    expect(applied.payload.state).toBe("applied");
    expect((await getSoul()).tone).toBe("Dry and to the point");
    // A decided card answers as it is: a second tap (or a late Not now) changes nothing.
    await putSoul({ tone: "Changed by hand" });
    expect((await proposalOf(await act(m, card.id, "apply"))).payload.state).toBe("applied");
    expect((await proposalOf(await act(m, card.id, "dismiss"))).payload.state).toBe("applied");
    expect((await getSoul()).tone).toBe("Changed by hand");
  });

  test("Not now dismisses and leaves the soul as it was; Apply afterwards does nothing", async () => {
    const before = await getSoul();
    m.llm.script("chat", [call("propose_soul_change", { field: "persona", proposed: "Chatty", reason: "More small talk?" })], [text("ok")]);
    const card = cardOf(await chatIn(m, "hmm", "p-2"), "soul_proposal");
    expect(card.payload.current).toBe(before.persona);
    expect((await proposalOf(await act(m, card.id, "dismiss"))).payload.state).toBe("dismissed");
    expect((await proposalOf(await act(m, card.id, "apply"))).payload.state).toBe("dismissed");
    expect(await getSoul()).toEqual(before);
  });

  test("Apply creates the soul row for a user who never saved one; the next prompt uses it", async () => {
    expect(await getSoul(sam)).toEqual(EMPTY);
    m.llm.script("chat", [call("propose_soul_change", { field: "addressAs", proposed: "Captain", reason: "You signed off as Captain." })], [text("ok")]);
    const card = cardOf(await chatIn(m, "aye", "p-3", { user: sam }), "soul_proposal");
    expect(card.payload.current).toBe("");
    await proposalOf(await act(m, card.id, "apply", sam));
    expect(await getSoul(sam)).toMatchObject({ name: "", addressAs: "Captain", identity: "", persona: "", tone: "" });
    expect((await getSoul(sam)).updatedAt).not.toBeNull();
    m.llm.script("chat", [text("Morning, Captain.")]);
    await chatIn(m, "morning", "p-4", { user: sam });
    expect(lastSystem(m)).toContain("Address the user as: \"Captain\"");
  });

  test("refused proposals are error results with no card: soulExtra on the main thread, the current value, over the limit, an unknown field", async () => {
    await putSoul({ tone: "Steady" });
    m.llm.script("chat", [
      call("propose_soul_change", { field: "soulExtra", proposed: "Main extra", reason: "r" }),
      call("propose_soul_change", { field: "tone", proposed: " Steady ", reason: "r" }),
      call("propose_soul_change", { field: "name", proposed: "n".repeat(41), reason: "r" }),
      call("propose_soul_change", { field: "mood", proposed: "x", reason: "r" }),
    ], [text("ok")]);
    const frames = await chatIn(m, "change yourself", "p-5");
    expect(hasCard(frames)).toBe(false);
    const results = lastToolResults();
    expect(results).toContain("soulExtra is a channel's addendum");
    expect(results).toContain("That is already the current value.");
    expect(results).toContain("name is at most 40 characters");
    expect(results).toContain("Invalid tool arguments");
    expect((await m.fixture.db.channel.findUniqueOrThrow({ where: { id: m.alex.mainChannelId } })).soulExtra).toBe("");
  });

  test("in a channel, soulExtra: current is the channel's addendum; Apply writes the channel and emits a channel event", async () => {
    const shop = await channelOf(m, m.alex, { name: "Bike shop", purpose: "Orders", soulExtra: "Numbers first." });
    m.llm.script("chat", [call("propose_soul_change", { field: "soulExtra", proposed: "Numbers first, then the suppliers.", reason: "You always ask about suppliers next." })], [text("ok")]);
    const card = cardOf(await chatIn(m, "suppliers?", "p-6", { channelId: shop.id }), "soul_proposal");
    expect(card).toMatchObject({ channelId: shop.id, payload: { field: "soulExtra", current: "Numbers first.", proposed: "Numbers first, then the suppliers.", state: "open" } });
    expect((await m.fixture.db.channel.findUniqueOrThrow({ where: { id: shop.id } })).soulExtra).toBe("Numbers first.");

    const seen: DuetEvent[] = [];
    const off = m.fixture.events.subscribe(m.alex.userId, (event) => { seen.push(event); });
    const soulBefore = await getSoul();
    try {
      expect((await proposalOf(await act(m, card.id, "apply"))).payload.state).toBe("applied");
    } finally {
      off();
    }
    expect((await m.fixture.db.channel.findUniqueOrThrow({ where: { id: shop.id } })).soulExtra).toBe("Numbers first, then the suppliers.");
    const channelEvent = seen.find((e) => e.type === "channel");
    expect(channelEvent).toMatchObject({ type: "channel", channelId: shop.id, payload: { channel: { id: shop.id, soulExtra: "Numbers first, then the suppliers." } } });
    // The soul itself is untouched; the channel's next prompt carries the new addendum.
    expect(await getSoul()).toEqual(soulBefore);
    m.llm.script("chat", [text("ok")]);
    await chatIn(m, "and now?", "p-7", { channelId: shop.id });
    expect(lastSystem(m)).toContain("Numbers first, then the suppliers.");
  });
});
