// Skills (L156): /api/skills CRUD (own skills only, validated), propose_skill -> the
// "Save this as a skill?" card, Save skill / Not now on it, and /<name> injecting the instructions.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Skill, SkillList } from "../../src/contract/account.ts";
import { MessageActionResponse, type Message } from "../../src/contract/messages.ts";
import { errorOf } from "../helpers/http.ts";
import { signUp, type SignedIn } from "../helpers/session.ts";
import { call, chat, json, messagesOf, startMake, text, toolResults, type MakeApp } from "../make/harness.ts";

let m: MakeApp;
let sam: SignedIn;
beforeAll(async () => {
  m = await startMake();
  sam = await signUp(m.fixture, "sam", "Sam Lee");
});
afterAll(() => m.fixture.cleanup());

const api = (path: string, init: RequestInit = {}) => m.fixture.app.request(path, init);
const list = async (user: SignedIn) => SkillList.parse(await (await api("/api/skills", { headers: user.headers })).json()).skills;
const act = (messageId: string, action: string, user: SignedIn = m.alex) => api(`/api/messages/${messageId}/action`, json(user, "POST", { action }));
const card = async (response: Response): Promise<Message> => {
  expect(response.status).toBe(200);
  return MessageActionResponse.parse(await response.json()).message;
};

describe("/api/skills", () => {
  test("create, list (own only), replace by name, delete; validated", async () => {
    const res = await api("/api/skills", json(m.alex, "POST", { name: "standup", description: "Daily standup notes", instructions: "Three bullets: yesterday, today, blockers." }));
    expect(res.status).toBe(200);
    const skill = Skill.parse(await res.json());
    expect(skill.name).toBe("standup");
    const again = Skill.parse(await (await api("/api/skills", json(m.alex, "POST", { name: "standup", description: "Standup", instructions: "Two bullets." }))).json());
    expect(again.id).toBe(skill.id);
    expect((await list(m.alex)).map((s) => [s.name, s.instructions])).toEqual([["standup", "Two bullets."]]);
    expect(await list(sam)).toEqual([]);
    for (const body of [{ name: "Bad Name", description: "", instructions: "x" }, { name: "/slash", description: "", instructions: "x" }, { name: "ok", description: "", instructions: " " }, { name: "ok", description: "", instructions: "x", extra: 1 }]) {
      const bad = await api("/api/skills", json(m.alex, "POST", body));
      expect(bad.status).toBe(400);
      expect((await errorOf(bad)).code).toBe("validation_failed");
    }
    expect((await api(`/api/skills/${skill.id}`, json(sam, "DELETE"))).status).toBe(404);
    expect((await api(`/api/skills/${skill.id}`, json(m.alex, "DELETE"))).status).toBe(204);
    expect(await list(m.alex)).toEqual([]);
    expect((await api("/api/skills")).status).toBe(401);
  });
});

describe("propose_skill card", () => {
  const propose = async (clientId: string, name: string) => {
    m.llm.script("chat", [call("propose_skill", { name, description: "How I write emails", instructions: "Short sentences. No exclamation marks. Sign off with -A." })], [text("Want me to keep that?")]);
    const frames = await chat(m, "I always write short emails, no exclamation marks, sign off -A", clientId);
    const posted = messagesOf(frames).find((x) => x.kind === "skill_proposal");
    if (!posted || posted.kind !== "skill_proposal") throw new Error("no card");
    return posted;
  };

  test("posts the card (nothing saved yet); Save skill stores it; a second tap answers as is", async () => {
    const posted = await propose("s-1", "/my-writing-style");
    expect(posted.payload).toEqual({ name: "my-writing-style", description: "How I write emails", instructions: "Short sentences. No exclamation marks. Sign off with -A.", state: "open", skillId: null });
    expect(toolResults(m.llm.sent("chat").at(-1))).toContain("saved only when the user taps Save skill");
    expect(await list(m.alex)).toEqual([]);
    const saved = await card(await act(posted.id, "save_skill"));
    if (saved.kind !== "skill_proposal") throw new Error("kind");
    expect(saved.payload.state).toBe("saved");
    const skills = await list(m.alex);
    expect(skills.map((s) => [s.id, s.name])).toEqual([[saved.payload.skillId!, "my-writing-style"]]);
    const twice = await card(await act(posted.id, "dismiss"));
    if (twice.kind !== "skill_proposal") throw new Error("kind");
    expect(twice.payload.state).toBe("saved");
  });

  test("Not now collapses it without saving; other actions are 400; someone else's card is 404", async () => {
    const posted = await propose("s-2", "email-tone");
    expect((await act(posted.id, "start")).status).toBe(400);
    expect((await act(posted.id, "save_skill", sam)).status).toBe(404);
    const dismissed = await card(await act(posted.id, "dismiss"));
    if (dismissed.kind !== "skill_proposal") throw new Error("kind");
    expect([dismissed.payload.state, dismissed.payload.skillId]).toEqual(["dismissed", null]);
    expect((await list(m.alex)).map((s) => s.name)).not.toContain("email-tone");
  });

  test("a bad name is an error result, not a card", async () => {
    m.llm.script("chat", [call("propose_skill", { name: "Not A Slug!", description: "x", instructions: "y" })], [text("ok")]);
    const frames = await chat(m, "remember this", "s-3");
    expect(messagesOf(frames).some((x) => x.kind === "skill_proposal")).toBe(false);
    expect(toolResults(m.llm.sent("chat").at(-1))).toContain("Invalid tool arguments");
  });
});

describe("/<name> injection", () => {
  test("a message starting with /name (or the composer's skill) gets the skill's instructions this turn only", async () => {
    m.llm.script("chat", [text("Done.")]);
    await chat(m, "/my-writing-style reply to Dana about Friday", "s-4");
    const withSkill = m.llm.sent("chat").at(-1)!.system;
    expect(withSkill).toContain("invoked their skill /my-writing-style");
    expect(withSkill).toContain("Sign off with -A.");

    m.llm.script("chat", [text("Done.")]);
    await chat(m, "reply to Dana about Friday", "s-5", { skill: "my-writing-style" });
    expect(m.llm.sent("chat").at(-1)!.system).toContain("Sign off with -A.");

    m.llm.script("chat", [text("Sure.")]);
    await chat(m, "what's on today?", "s-6");
    expect(m.llm.sent("chat").at(-1)!.system).not.toContain("Sign off with -A.");

    m.llm.script("chat", [text("Sure.")]);
    await chat(m, "/unknown-skill do it", "s-7");
    expect(m.llm.sent("chat").at(-1)!.system).toContain("no skill with that name");
  });

  test("someone else's skill of the same name is never injected", async () => {
    await api("/api/skills", json(sam, "POST", { name: "secret", description: "", instructions: "SAM-ONLY-INSTRUCTIONS" }));
    m.llm.script("chat", [text("ok")]);
    await chat(m, "/secret hi", "s-8");
    expect(m.llm.sent("chat").at(-1)!.system).not.toContain("SAM-ONLY-INSTRUCTIONS");
  });
});
