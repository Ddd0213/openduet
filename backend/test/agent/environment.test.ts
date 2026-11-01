// M21 the Environment section (agent/environment.ts): generated from this server's real
// configuration, right after the capability brief and before the language rule and the soul.
// Pure function, the program probe, then the real runtime with and without Claude's computer.
import { afterEach, describe, expect, test } from "bun:test";
import { environmentLines, offeredList, parseProbe, ProgramProbe, PROBE_COMMAND, type ComputerFacts, type EnvironmentFacts } from "../../src/agent/environment.ts";
import { computerRig, text, type ComputerRig } from "../computer/harness.ts";

const COMPUTER_TOOLS = ["computer_navigate", "computer_read", "computer_snapshot", "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_screenshot", "computer_files_list", "computer_files_read", "computer_files_write", "computer_files_edit", "computer_files_search", "computer_exec"];
const CHAT_TOOLS = ["web_fetch", "web_search", "search_past_chats", "get_time", "ask_form", "quick_replies", "show_card", "start_task", "propose_tasks", "propose_task", "tell_task", "resolve_task", "schedule_task", "manage_scheduled_task", "update_approval", "search_app_tools", "execute_app_tools", "manage_app_connections", "request_connection", ...COMPUTER_TOOLS, "request_sign_in", "send_file", "make_artifact", "edit_artifact", "propose_skill", "use_skill", "react", "remember", "forget", "propose_soul_change", "set_reminder", "set_weekends", "mcp_a1b2c3_list_issues", "mcp_a1b2c3_create_issue"];
const computer = (over: Partial<ComputerFacts> = {}): ComputerFacts => ({
  reachable: true, userInControl: false, programs: ["bash", "node", "bun", "git", "python3", "officecli", "unpdf (Node package)"], memoryBytes: 2 * 1024 ** 3,
  always: COMPUTER_TOOLS.filter((t) => t !== "computer_exec"), ask: ["computer_exec"], ...over,
});
const facts = (over: Partial<EnvironmentFacts> = {}): EnvironmentFacts => ({
  kind: "chat", modelLabel: "Claude Sonnet 4.5", tools: CHAT_TOOLS, search: true, computer: computer(), browserMode: "headless", browserIdleMs: 30 * 60_000, ...over,
});
/** ~4 characters a token for this kind of English (the brief's budgets: <= 600 full, <= 150 build). */
const tokens = (lines: string[]) => Math.ceil(lines.join("\n").length / 4);

describe("environmentLines (pure)", () => {
  test("a chat turn with the computer: every fact from the configuration, under 600 tokens", () => {
    const lines = environmentLines(facts());
    const all = lines.join("\n");
    expect(lines[0]).toStartWith("Environment (");
    for (const part of [
      "This turn's model: \"Claude Sonnet 4.5\"", "not their phone",
      "not a throwaway sandbox", "/workspace and browser logins persist across sleep and restarts", "Programs: bash, node, bun, git, python3, officecli, unpdf (Node package).", "2 GB memory",
      "120 s default, 600 s max", "process group is killed", "nohup", "no long-running services", "schedule_task",
      "only via the server's proxy", "no access to the server's host or the user's devices", "Browser: headless", "sleeps after 30 idle minutes", "\"off\" in its state = asleep, not reset", "take over",
      "web_fetch first; the browser only for logins, JavaScript or clicks", "opening a page is not a web search",
      "computer_click/type/key/files_write run without a card (Always)", "computer_exec asks first", "always asks", "payments, passwords and sends to others always ask",
      "Tools this turn: web_fetch, web_search, computer_* (14), request_sign_in, send_file",
    ]) expect(all).toContain(part);
    expect(tokens(lines)).toBeLessThanOrEqual(600);
    // Nothing of the soul (name, tone) and no hard-coded model id.
    expect(all).not.toContain("Your name in replies");
    expect(all).not.toMatch(/claude-[a-z0-9-]+-\d/);
  });

  test("a build gets only the three computer lines (<= 150 tokens); without a computer nothing", () => {
    const build = environmentLines(facts({ kind: "build" }));
    expect(build).toHaveLength(3);
    expect(build[0]).toContain("OpenDuet's computer: a Linux container");
    expect(build[1]).toContain("computer_exec: 120 s default");
    expect(build[1]).not.toContain("schedule_task");
    expect(build[2]).toContain("proxy");
    expect(tokens(build)).toBeLessThanOrEqual(150);
    expect(environmentLines(facts({ kind: "build", computer: null }))).toEqual([]);
  });
});
describe("environmentLines: what changes with the configuration", () => {
  test("no computer: one line instead of the computer's, no browser advice; no search: said so", () => {
    const all = environmentLines(facts({ computer: null, search: false, tools: ["web_fetch", "remember"] })).join("\n");
    expect(all).toContain("No computer for this account on this server");
    expect(all).not.toContain("OpenDuet's computer:");
    expect(all).not.toContain("the browser only for");
    expect(all).toContain("For a URL the user gives, use web_fetch.");
    expect(all).toContain("There's no web search on this server; opening a page is not a web search.");
    expect(all).not.toContain("On the computer");
  });

  test("the approval line follows ToolPolicy; programs not probed yet; unknown model; state right now", () => {
    const asked = environmentLines(facts({ computer: computer({ always: ["computer_navigate", "computer_read"], ask: ["computer_click", "computer_type", "computer_exec"] }) })).join("\n");
    expect(asked).not.toContain("run without a card");
    expect(asked).toContain("computer_click/type/exec ask first");
    const exec = environmentLines(facts({ computer: computer({ always: COMPUTER_TOOLS, ask: [] }) })).join("\n");
    expect(exec).toContain("computer_click/type/key/files_write/exec run without a card (Always)");
    const fresh = environmentLines(facts({ modelLabel: null, computer: computer({ programs: null, memoryBytes: null }) })).join("\n");
    expect(fresh).toContain("Programs not checked yet: try `command -v` first.");
    expect(fresh).not.toContain("memory");
    expect(fresh).toContain("not known here (don't guess a name)");
    expect(environmentLines(facts({ computer: computer({ reachable: false }) })).join("\n")).toContain("isn't answering");
    expect(environmentLines(facts({ computer: computer({ userInControl: true }) })).join("\n")).toContain("the user is driving it");
    expect(environmentLines(facts({ browserMode: "headed", browserIdleMs: 0 })).join("\n")).toContain("Browser: headed, signed in only where the user signed in through it; it stays open.");
  });

  test("the tools line groups the computer's and each custom connector's tools, key tools first", () => {
    expect(offeredList(["remember", "computer_read", "web_fetch", "computer_click", "mcp_a1b2c3_x", "mcp_a1b2c3_y"])).toBe("web_fetch, computer_* (2), remember, mcp_a1b2c3_* (2)");
    expect(offeredList([])).toBe("none");
    expect(offeredList(CHAT_TOOLS)).toMatch(/ and \d+ more$/);
  });
});

describe("the program probe", () => {
  test("parses programs and the memory limit; cgroup 'max' or the v1 sentinel is no limit", () => {
    expect(parseProbe("has bash\nhas git\nhas unpdf (Node package)\n2147483648\n")).toEqual({ programs: ["bash", "git", "unpdf (Node package)"], memoryBytes: 2147483648 });
    expect(parseProbe("has bash\nmax\n").memoryBytes).toBeNull();
    expect(parseProbe("has bash\n9223372036854771712\n").memoryBytes).toBeNull();
    expect(PROBE_COMMAND).toContain("command -v");
    for (const program of ["git", "python3", "officecli"]) expect(PROBE_COMMAND).toContain(program);
  });

  test("probes once and caches; a failure is retried only after a minute; a slow probe doesn't hold the turn", async () => {
    let clock = 0;
    const calls: string[] = [];
    let fail = true;
    const probe = new ProgramProbe(async (command) => {
      calls.push(command);
      if (fail) throw new Error("unreachable");
      return { exitCode: 0, stdout: "has bash\nhas node\n" };
    }, () => clock);
    expect(await probe.get(100)).toBeNull();
    expect(await probe.get(100)).toBeNull();
    expect(calls).toHaveLength(1);
    clock = 61_000;
    fail = false;
    expect(await probe.get(100)).toEqual({ programs: ["bash", "node"], memoryBytes: null });
    expect(await probe.get(100)).toEqual({ programs: ["bash", "node"], memoryBytes: null });
    expect(calls).toHaveLength(2);

    const slow = new ProgramProbe(() => new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0, stdout: "has bash\n" }), 200)));
    const started = performance.now();
    expect(await slow.get(20)).toBeNull();
    expect(performance.now() - started).toBeLessThan(150);
    expect(slow.peek()).toBeNull();
    await Bun.sleep(250);
    expect(slow.peek()).toEqual({ programs: ["bash"], memoryBytes: null });
  });
});
describe("in the system prompt (real runtime, fake computer, scripted model)", () => {
  let rig: ComputerRig | undefined;
  afterEach(async () => { await rig?.cleanup(); rig = undefined; });
  const probes = (r: ComputerRig) => r.fake.calls.filter((c) => c.path === "/exec" && (c.body as { command?: unknown }).command === PROBE_COMMAND);

  test("a chat turn: brief, then Environment, then the language rule; the model's label; the probe runs once; ToolPolicy is read each turn", async () => {
    rig = await computerRig();
    rig.llm.script("chat", [text("Hi!")], [text("Again.")]);
    await rig.send(rig.alex, "Hello");
    const system = rig.llm.sent("chat")[0]!.system!;
    const at = (needle: string) => { const i = system.indexOf(needle); expect(i).toBeGreaterThanOrEqual(0); return i; };
    expect(at("You run inside openduet")).toBeLessThan(at("Environment (facts about this server and this turn):"));
    expect(at("Environment (facts")).toBeLessThan(at("User language:"));
    expect(at("User language:")).toBeLessThan(at("Your name in replies"));
    expect(system).toContain("This turn's model: \"Test only\"");
    expect(system).toMatch(/Programs: [^\n]*bash/);
    expect(system).toContain("computer_exec asks first");
    // M29: a chat turn names its core tools; the computer's and the built-in lookups wait under "More tools".
    expect(system).toContain("Tools ready now: web_fetch, web_search, set_reminder, search_past_chats, quick_replies, load_tools. The others are listed under \"More tools\" below");
    expect(system).toContain("More tools (offered on this turn, not loaded yet).");
    for (const name of ["weather", "exchange_rate", "read_feed", "computer_navigate", "computer_exec", "request_sign_in", "send_file"]) expect(system).toContain(`\n- ${name}: `);
    // The computer's GUIDE defers to the probe instead of naming programs.
    expect(system).toContain("the programs on it are the ones the Environment section lists");
    expect(system).not.toContain("bash, git, Python and Node");

    await rig.fixture.db.toolPolicy.create({ data: { userId: rig.alex.userId, toolSlug: "computer_exec", mode: "always" } });
    await rig.send(rig.alex, "And now?");
    const next = rig.llm.sent("chat")[1]!.system!;
    expect(next).toContain("computer_click/type/key/files_write/exec run without a card (Always)");
    expect(next).not.toContain("asks first");
    expect(probes(rig)).toHaveLength(1);
  });

  test("a Make build gets only the three computer lines", async () => {
    rig = await computerRig({ trustedBuild: () => true });
    rig.llm.script("task", [text("Built.")]);
    const runId = await rig.fixture.runs.submit({ userId: rig.alex.userId, channelId: rig.alex.mainChannelId, taskId: null, kind: "build", prompt: "Build it" });
    await rig.waitFor(rig.alex.userId, (e) => e.type === "done" && e.payload.runId === runId);
    const system = rig.llm.sent("task")[0]!.system!;
    expect(system).toContain("- OpenDuet's computer: a Linux container here");
    expect(system).toContain("- computer_exec: 120 s default, 600 s max");
    expect(system).toContain("- Network only via the server's proxy");
    for (const absent of ["Environment (facts", "Tools this turn", "Approvals:", "Browser: headless"]) expect(system).not.toContain(absent);
  });

  test("no computer on this server: one line says so, nothing reaches a computer, key-less search remains", async () => {
    rig = await computerRig({ configured: false });
    rig.llm.script("chat", [text("No browser here.")]);
    await rig.send(rig.alex, "Open example.com");
    const system = rig.llm.sent("chat")[0]!.system!;
    expect(system).toContain("- No computer for this account on this server: no browser, shell or files of yours.");
    expect(system).toContain("web_search finds sources; opening a page is not a web search.");
    expect(system).not.toContain("OpenDuet's computer: a Linux container");
    expect(rig.fake.calls).toHaveLength(0);
  });
});
