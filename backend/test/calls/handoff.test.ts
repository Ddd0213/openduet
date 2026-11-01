// M15: the false hand-off check. A voice line that claims a hand-off with no send_to_assistant around
// it gets a notice cue for the voice after the grace; a real hand-off before or after the claim
// doesn't; at most 3 per call; none once the call ended. The instructions say to claim a hand-off
// only after "Sent to Claude."
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handoffClaim, NUDGES_MAX } from "../../src/calls/handoff.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { chatModel, eventsOf, line, realtimeModel, req, settle, startCallsApp, stopCallsApp, text, type CallsApp } from "./harness.ts";

// Production is HANDOFF_GRACE_MS (20 s). 60 ms was too short under a loaded full suite (the
// send_to_assistant request landed after the grace and a notice went out, twice on 2026-10-29).
const GRACE_MS = 300;
let t: CallsApp;
beforeAll(async () => {
  t = await startCallsApp({ handoffGraceMs: GRACE_MS });
});
afterAll(() => stopCallsApp(t));

let users = 0;
async function caller(): Promise<{ u: SignedIn; id: string; start: { instructions: string } }> {
  const u = await signUp(t.fixture, `voice${++users}`, `Voice User${users}`);
  await chatModel(t, u);
  await realtimeModel(t, u, "stepfun");
  const res = await req(t, u, "POST", "/api/calls", { channelId: u.mainChannelId });
  expect(res.status).toBe(200);
  return { u, id: res.body.call.id as string, start: res.body };
}

const say = (u: SignedIn, id: string, lineId: string, words: string) =>
  req(t, u, "POST", `/api/calls/${id}/lines`, { lines: [line(lineId, "voice", words)] });

/** After the grace: the checks made, the timers fired, the cues written. */
async function afterGrace(): Promise<void> {
  await t.calls.service.handoffs.idle();
  await Bun.sleep(GRACE_MS * 3);
  await settle(t);
}

async function nudges(u: SignedIn): Promise<string[]> {
  return (await eventsOf(t, u.userId, "call"))
    .filter((e) => e.payload.kind === "notice" && e.payload.text.includes("send_to_assistant wasn't called"))
    .map((e) => e.payload.text);
}

describe("what counts as a claimed hand-off", () => {
  // What HandoffWatch passes ("Open Duet" too: speech recognition hears two words); padded to check the trim.
  const names = ["  OpenDuet  ", "Open Duet", "Duet", "小克"];
  test.each([
    "好的，我已经转达给 OpenDuet 了。",
    "我这就转达给OpenDuet，请稍等。",
    "好的，我已经转达给 Open Duet 了。",
    "已经交给 Duet 处理了",
    "我跟 OpenDuet 说了，它会去做。",
    "我会告诉小克的。",
    "OK, I've passed that to OpenDuet.",
    "OK, I've passed that to Open  Duet.",
    "No problem, I've sent it to open duet.",
    "Done, I've sent it to openduet.",
    "I'll let duet know.",
  ])("claims: %s", (words) => {
    expect(handoffClaim(words, names)).not.toBeNull();
  });
  test.each([
    "要我转达给 OpenDuet 吗？",
    "我还没有转达给 OpenDuet。",
    "不用转达给 OpenDuet。",
    "OpenDuet 告诉我，订单已经好了。",
    "我可以帮你转达给 OpenDuet",
    "我和 OpenDuet 一起看看",
    "Should I pass this to OpenDuet?",
    "Should I pass this to Open Duet?",
    "I haven't sent it to OpenDuet yet.",
    "I can pass that to OpenDuet if you like.",
    "OpenDuet sent you a link.",
    "Let me check what OpenDuet said.",
  ])("doesn't: %s", (words) => {
    expect(handoffClaim(words, names)).toBeNull();
  });
});

describe("the check on a call", () => {
  test("a claim with no send_to_assistant: one notice for the voice, quoting the claim", async () => {
    const { u, id } = await caller();
    expect((await say(u, id, "v1", "好的，我已经转达给 OpenDuet 了。")).status).toBe(204);
    await afterGrace();
    const sent = await nudges(u);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("«好的，我已经转达给 OpenDuet 了。»");
    expect(sent[0]).toContain("Call send_to_assistant now");
    // Only a voice line counts: the user saying it isn't a claim.
    await req(t, u, "POST", `/api/calls/${id}/lines`, { lines: [line("u1", "user", "我已经转达给 OpenDuet 了")] });
    await afterGrace();
    expect(await nudges(u)).toHaveLength(1);
  });

  test("send_to_assistant right after the claim, or just before it: no notice", async () => {
    const { u, id } = await caller();
    await say(u, id, "v1", "I'll pass that to OpenDuet now.");
    t.scripts.push([text("On it.")], [text("Done.")]);
    const res = await req(t, u, "POST", `/api/calls/${id}/tool`, { name: "send_to_assistant", arguments: { text: "Order the pads." }, lines: [] });
    expect(res.body).toEqual({ result: "Sent to OpenDuet." });
    await afterGrace();
    expect(await nudges(u)).toEqual([]);

    // The claim after the tool (the voice telling the user it went through).
    await req(t, u, "POST", `/api/calls/${id}/tool`, { name: "send_to_assistant", arguments: { text: "Also a chain." }, lines: [] });
    await say(u, id, "v2", "OK, I've passed that to OpenDuet.");
    await afterGrace();
    expect(await nudges(u)).toEqual([]);
  });

  test(`at most ${NUDGES_MAX} per call; none once the call ended`, async () => {
    const { u, id } = await caller();
    for (let i = 1; i <= NUDGES_MAX + 1; i += 1) {
      await say(u, id, `v${i}`, `已经交给 OpenDuet 处理了（第 ${i} 次）。`);
      await afterGrace();
    }
    expect(await nudges(u)).toHaveLength(NUDGES_MAX);

    const other = await caller();
    await say(other.u, other.id, "v1", "我已经转达给 OpenDuet 了。");
    await req(t, other.u, "POST", `/api/calls/${other.id}/end`, { seconds: 5 });
    await afterGrace();
    expect(await nudges(other.u)).toEqual([]);
  });

  test("the instructions: claim a hand-off only after Sent to Claude; a [Notice] is acted on", async () => {
    const { start } = await caller();
    expect(start.instructions).toContain('Only once it answers "Sent to OpenDuet." say briefly that it has the request.');
    expect(start.instructions).toContain("Never say you passed something on without calling send_to_assistant");
    expect(start.instructions).toContain("A [Notice] is from OpenDuet itself: act on it.");
  });
});

describe("what a hand-off shows in the chat (M15)", () => {
  test("the voice's words without the model's quote; nothing else is cut", async () => {
    const { handOffText } = await import("../../src/runs/serialize.ts");
    expect(handOffText("Order 4 sets.\n\n[The user's own words on the call: «We need four»]")).toBe("Order 4 sets.");
    expect(handOffText("Order 4 sets.")).toBe("Order 4 sets.");
    // the voice's own text with the phrase (its "[" became "(" when stored) stays whole
    expect(handOffText("Say (the user's own words on the call: «x»]")).toBe("Say (the user's own words on the call: «x»]");
    // not at the end: left alone
    expect(handOffText("A\n\n[The user's own words on the call: «x»] and more")).toBe("A\n\n[The user's own words on the call: «x»] and more");
  });
});
