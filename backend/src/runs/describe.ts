// What a run record shows for each tool call (M8): the fixed title key, the app, the grey detail
// line, and what may be stored as its input and output. The redaction rules per tool live here:
// - computer_type: the field ref only, never the typed text;
// - computer_files_write: path + byte size, never the contents;
// - request_sign_in: the domain only (no refs, no email, no password; the sign-in card's details
//   never pass through the agent at all);
// - computer_files_read: the text read, capped to 2 KB; screenshots: their size and URL, no image;
// - everything else: redacted (redact.ts) and capped to 8 KB.
import type { Phrase } from "../contract/common.ts";
import type { ToolResultBlock, ToolUseBlock } from "../llm/index.ts";
import { FILE_READ_MAX_BYTES, type Redactor } from "./redact.ts";
import { opPaths } from "../artifacts/data.ts";
import { DataOp } from "../contract/m27.ts";

export const COMPUTER_APP = "OpenDuet's computer";

/** Model tool name -> run.step.* title key. Anything not listed is "run.step.tool". */
const TITLE: Record<string, string> = {
  computer_exec: "run.step.exec",
  computer_navigate: "run.step.navigate",
  computer_read: "run.step.read_page",
  computer_snapshot: "run.step.browse", computer_click: "run.step.browse", computer_type: "run.step.browse",
  computer_key: "run.step.browse", computer_scroll: "run.step.browse", request_sign_in: "run.step.browse",
  computer_screenshot: "run.step.screenshot",
  computer_files_list: "run.step.files_list",
  computer_files_read: "run.step.files_read",
  computer_files_write: "run.step.files_write",
  computer_files_edit: "run.step.files_edit",
  computer_files_search: "run.step.files_search",
  send_file: "run.step.send_file",
  web_search: "run.step.web_search",
  web_fetch: "run.step.web_fetch",
  weather: "run.step.weather", exchange_rate: "run.step.exchange_rate", read_feed: "run.step.read_feed",
  check_memory: "run.step.memory",
  remember: "run.step.remember",
  search_past_chats: "run.step.past_chats",
  start_task: "run.step.task", start_first_step: "run.step.task",
  set_steps: "run.step.task_progress", add_update: "run.step.task_progress", add_resource: "run.step.task_progress",
  update_task: "run.step.task_progress", finish_task: "run.step.task_progress", ask_user: "run.step.task_progress",
  make_artifact: "run.step.make", edit_artifact: "run.step.make", finish_build: "run.step.make",
  // M21: Make's local edit and the chat's refresh
  refresh_artifact: "run.step.make", edit_page: "run.step.make",
  update_artifact_data: "run.step.artifact_data",
  request_payment: "run.step.approval", update_approval: "run.step.approval",
  post_message: "run.step.text",
  // M9
  ask_form: "run.step.form",
  show_card: "run.step.card",
  schedule_task: "run.step.schedule", manage_scheduled_task: "run.step.schedule",
  // M22: the server-built task overview card
  show_tasks: "run.step.card",
  propose_soul_setup: "run.step.card",
};

/** One row of the record as it starts. */
export interface CallView {
  tool: string;
  app: string | null;
  title: Phrase;
  detail: string;
  input: string | null;
}

/** One nested call of execute_app_tools, from its result. */
export interface NestedView extends CallView {
  status: "ok" | "error" | "awaiting_approval";
  output: string | null;
  approvalId: string | null;
}

export interface ResultView {
  status: "ok" | "error" | "awaiting_approval";
  output: string | null;
  approvalId: string | null;
  /** a better detail line when the call had none (e.g. the page a click landed on) */
  detail: string | null;
  /** execute_app_tools: one view per nested call, in order */
  nested: NestedView[] | null;
}

type Args = Record<string, unknown>;
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);
const record = (value: unknown): Args => (value && typeof value === "object" && !Array.isArray(value) ? (value as Args) : {});

/** Keys tried, in order, for the detail line of an app tool (Composio) or an unknown tool. */
const DETAIL_KEYS = ["subject", "title", "query", "q", "name", "summary", "url", "path", "recipient_email", "to", "channel", "text", "message", "body", "prompt"];
const SECRETISH = /pass|secret|token|key|auth|cookie|credential/i;

function argDetail(args: Args, redact: Redactor): string {
  for (const key of DETAIL_KEYS) {
    const value = args[key];
    if (str(value)) return redact.line(value);
    if (Array.isArray(value) && value.every((v) => typeof v === "string") && value.length) return redact.line(value.join(", "));
  }
  for (const [key, value] of Object.entries(args)) if (!SECRETISH.test(key) && str(value)) return redact.line(value);
  return "";
}

function titleOf(name: string): Phrase {
  return { key: TITLE[name] ?? "run.step.tool" };
}

function appOf(name: string): string | null {
  return name.startsWith("computer_") || name === "send_file" || name === "request_sign_in" ? COMPUTER_APP : null;
}

function detailOf(name: string, args: Args, redact: Redactor): string {
  switch (name) {
    case "computer_exec": return redact.line(args.command);
    case "computer_navigate": case "web_fetch": case "read_feed": return redact.line(args.url);
    case "weather": return redact.line(args.place);
    case "exchange_rate": return redact.line(`${str(args.base) ?? ""} → ${Array.isArray(args.quotes) ? args.quotes.filter(q => typeof q === "string").join(", ") : ""}`);
    case "web_search": case "search_past_chats": case "search_app_tools": return redact.line(args.query);
    case "computer_files_list": case "computer_files_search": return redact.line(str(args.path) ?? "/workspace");
    case "computer_files_read": {
      const from = typeof args.offset === "number" ? args.offset : 1;
      const range = args.offset !== undefined || args.limit !== undefined
        ? ` (lines ${from}–${typeof args.limit === "number" ? from + args.limit - 1 : "end"})` : "";
      return redact.line(`${str(args.path) ?? ""}${range}`);
    }
    case "computer_files_write": case "computer_files_edit": case "send_file": return redact.line(args.path);
    case "computer_click": case "computer_type": return redact.line(args.ref);
    case "computer_key": return redact.line(args.key);
    case "computer_screenshot": return redact.line(args.caption);
    case "request_sign_in": return redact.line(args.domain);
    case "remember": return redact.line(args.fact);
    case "start_task": case "start_first_step": case "update_task": case "make_artifact": case "add_resource":
    case "ask_form": case "show_card": case "schedule_task": return redact.line(args.title);
    case "manage_scheduled_task": return redact.line([str(args.action), str(args.taskId)].filter(Boolean).join(" "));
    case "add_update": case "post_message": case "set_reminder": case "send_feedback": return redact.line(args.text);
    case "cancel_reminder": return redact.line(str(args.text) ?? str(args.at));
    case "finish_task": return redact.line(args.summary);
    case "ask_user": return redact.line(args.question);
    case "edit_artifact": return redact.line(args.prompt);
    case "update_artifact_data": {
      if (!Array.isArray(args.ops)) return "";
      const ops = args.ops.flatMap(op => { const parsed = DataOp.safeParse(op); return parsed.success ? [parsed.data] : []; });
      return redact.line(opPaths(ops));
    }
    case "set_steps": {
      const steps = Array.isArray(args.steps) ? args.steps.map(record) : [];
      return redact.line(str(steps.find((s) => s.state === "current")?.text) ?? str(steps[0]?.text) ?? "");
    }
    case "manage_app_connections": return Array.isArray(args.apps) ? redact.line(args.apps.filter((a) => typeof a === "string").join(", ")) : "";
    case "get_app_tool_schemas": case "load_tools": return Array.isArray(args.tools) ? redact.line(args.tools.filter((a) => typeof a === "string").join(", ")) : "";
    case "request_payment": return redact.line(args.merchant);
    case "quick_replies": return Array.isArray(args.options) ? redact.line(args.options.filter((a) => typeof a === "string").join(" · ")) : "";
    default: return argDetail(args, redact);
  }
}

/** What may be stored as a call's input (see the rules at the top). */
function inputOf(name: string, args: Args, redact: Redactor): string | null {
  switch (name) {
    case "computer_type": return redact.body({ ref: args.ref, ...(args.submit !== undefined ? { submit: args.submit } : {}) });
    case "computer_files_write": {
      const contents = typeof args.contents === "string" ? args.contents : "";
      return redact.body({ path: args.path, bytes: new TextEncoder().encode(contents).byteLength, ...(args.append ? { append: true } : {}) });
    }
    case "computer_files_edit": return redact.body({ path: args.path });
    case "computer_files_search": return redact.body({ path: args.path ?? "/workspace" });
    case "request_sign_in": return redact.body({ domain: args.domain });
    case "computer_exec": {
      const command = typeof args.command === "string" ? args.command : "";
      const extra = [args.cwd ? `cwd: ${String(args.cwd)}` : "", args.timeoutSeconds ? `timeout: ${String(args.timeoutSeconds)} s` : ""].filter(Boolean);
      return redact.plain([command, ...extra].join("\n"));
    }
    default: return Object.keys(args).length ? redact.body(args) : null;
  }
}

/** The record row for a tool call as it starts. execute_app_tools shows its first nested call. */
export function describeCall(call: ToolUseBlock, redact: Redactor): CallView {
  const args = record(call.input);
  if (call.name === "execute_app_tools") {
    const calls = Array.isArray(args.calls) ? args.calls.map(record) : [];
    const first = calls[0] ?? {};
    const slug = str(first.tool)?.toUpperCase() ?? call.name;
    return { tool: slug, app: null, title: { key: "run.step.tool" }, detail: argDetail(record(first.arguments), redact), input: redact.body(first.arguments ?? null) };
  }
  return { tool: call.name, app: appOf(call.name), title: titleOf(call.name), detail: detailOf(call.name, args, redact), input: inputOf(call.name, args, redact) };
}

/** The result's text blocks (images are left out and noted). */
function resultText(result: ToolResultBlock): { text: string; images: number } {
  let text = "";
  let images = 0;
  for (const block of result.content) {
    if (block.type === "text") text += (text ? "\n" : "") + block.text;
    else images++;
  }
  return { text, images };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A program failure is not a tool failure. Put its exit code first so a long command can't hide it. */
export function execFailureDetail(output: unknown, redact: Redactor, command?: unknown): string | null {
  const data = record(output);
  return typeof data.exitCode === "number" && data.exitCode !== 0
    ? redact.line([`exit ${data.exitCode}`, str(command)].filter(Boolean).join(" · ")) : null;
}

/** How a call ended, and what may be stored as its output. */
export function describeResult(call: ToolUseBlock, result: ToolResultBlock, redact: Redactor): ResultView {
  const { text, images } = resultText(result);
  const data = parse(text);
  const json = record(data);
  const awaiting = json.status === "awaiting_approval" && typeof json.approvalId === "string";
  const status = result.isError ? "error" : awaiting ? "awaiting_approval" : "ok";
  const nested = call.name === "execute_app_tools" && Array.isArray(json.results) ? nestedViews(call, json.results.map(record), redact) : null;
  const view: ResultView = { status, output: null, approvalId: awaiting ? (json.approvalId as string) : null, detail: null, nested };
  if (awaiting) return view;
  switch (call.name) {
    case "computer_files_read": case "computer_files_search":
      view.output = typeof json.text === "string" && !result.isError ? redact.plain(json.text, FILE_READ_MAX_BYTES) : redact.body(text, FILE_READ_MAX_BYTES);
      break;
    case "computer_exec":
      view.output = !result.isError && typeof json.exitCode === "number"
        ? redact.plain([`exit ${json.exitCode}${json.timedOut ? " (timed out)" : ""}`, str(json.stdout) ?? "", str(json.stderr) ? `stderr:\n${json.stderr as string}` : ""].filter(Boolean).join("\n\n"))
        : redact.body(text);
      if (!result.isError) view.detail = execFailureDetail(json, redact, record(call.input).command);
      break;
    case "computer_screenshot":
      view.output = redact.body({ ...json, ...(images ? { image: "not stored" } : {}) });
      break;
    case "computer_navigate": case "computer_read": case "web_fetch":
      view.output = !result.isError && typeof json.text === "string"
        ? redact.plain([str(json.title), str(json.url), json.text as string].filter(Boolean).join("\n\n"))
        : redact.body(text);
      break;
    default:
      view.output = redact.body(text);
  }
  if (typeof json.url === "string" && json.url) view.detail = redact.line(json.url);
  return view;
}

/**
 * What an approved call returned (ApprovalService), stored like the same tool's live output:
 * exec as exit / stdout / stderr, files_read capped to 2 KB, no screenshot image. A string is a
 * failure reason and is kept as text.
 */
export function approvedOutput(slug: string, output: unknown, redact: Redactor): string | null {
  if (output === undefined || output === null) return null;
  if (typeof output === "string") return redact.plain(output);
  const call: ToolUseBlock = { type: "tool_use", id: "approved", name: slug, input: {} };
  const result: ToolResultBlock = { type: "tool_result", toolUseId: "approved", content: [{ type: "text", text: JSON.stringify(output) ?? "null" }] };
  return describeResult(call, result, redact).output;
}

/** execute_app_tools: each nested call's own row (title = the app tool's display name). */
function nestedViews(call: ToolUseBlock, results: Args[], redact: Redactor): NestedView[] {
  const calls = Array.isArray(record(call.input).calls) ? (record(call.input).calls as unknown[]).map(record) : [];
  return calls.map((item, index) => {
    const result = results.find((r) => r.index === index) ?? results[index] ?? {};
    const app = str(result.app) ?? null;
    const name = str(result.tool);
    const status = result.status === "ok" ? "ok" : result.status === "awaiting_approval" ? "awaiting_approval" : "error";
    const output = status === "ok" ? redact.body(result.data ?? null) : status === "error" ? redact.body({ ...result, index: undefined, app: undefined, tool: undefined }) : null;
    return {
      tool: str(item.tool)?.toUpperCase() ?? "execute_app_tools",
      app,
      title: name ? { text: name } : { key: "run.step.tool" },
      detail: argDetail(record(item.arguments), redact),
      input: redact.body(item.arguments ?? null),
      status,
      output,
      approvalId: status === "awaiting_approval" && typeof result.approvalId === "string" ? result.approvalId : null,
    };
  });
}
