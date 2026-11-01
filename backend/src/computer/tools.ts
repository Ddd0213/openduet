// The agent's tools on OpenDuet's computer (L140, L141, L142, L180): schemas, descriptions and the
// built-in "OpenDuet's computer" toolkit the assistant sheet shows with Ask / Always pickers (ToolPolicy).
import { z } from "zod";
import type { Mode } from "../policy/service.ts";

/** ToolPolicy toolkit of the computer tools ("toolkit:duet_computer"); can't collide with a Composio slug's tools (lowercase). */
export const COMPUTER_TOOLKIT = "duet_computer";
export const COMPUTER_APP = "OpenDuet's computer";

const Ref = z.string().trim().min(1).max(100);
const Path = z.string().trim().min(1).max(1024);

export const schemas = {
  computer_navigate: z.object({ url: z.string().max(8192).pipe(z.url({ protocol: /^https?$/ })) }).strict(),
  computer_read: z.object({}).strict(),
  computer_snapshot: z.object({}).strict(),
  computer_click: z.object({ ref: Ref }).strict(),
  computer_type: z.object({ ref: Ref, text: z.string().max(10_000), submit: z.boolean().optional() }).strict(),
  computer_key: z.object({ key: z.string().trim().min(1).max(40), ref: Ref.optional() }).strict(),
  computer_scroll: z.object({ deltaY: z.number().int().min(-5000).max(5000).optional() }).strict(),
  computer_screenshot: z.object({ caption: z.string().max(500).optional(), sendToChat: z.boolean().optional() }).strict(),
  computer_files_list: z.object({ path: Path.optional() }).strict(),
  computer_files_read: z.object({ path: Path, offset: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), limit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  computer_files_write: z.object({ path: Path, contents: z.string().max(900_000), append: z.boolean().optional() }).strict(),
  computer_files_edit: z.object({ path: Path, old_string: z.string().min(1).max(1_000_000), new_string: z.string().max(1_000_000), replace_all: z.boolean().optional() }).strict(),
  computer_files_search: z.object({ query: z.string().min(1).max(10_000).refine(q => !q.includes("\u0000"), "Query can't contain NUL"), regex: z.boolean().optional(), path: Path.optional(), glob: z.string().min(1).max(1024).refine(g => !g.includes("\u0000"), "Glob can't contain NUL").optional(), ignore_case: z.boolean().optional() }).strict(),
  computer_exec: z.object({ command: z.string().trim().min(1).max(20_000), cwd: Path.optional(), timeoutSeconds: z.number().int().min(1).max(600).optional() }).strict(),
  // M20: the computer finds the login form itself (/sign-in/fill); the refs are still accepted
  // (older prompts send them) and ignored.
  request_sign_in: z.object({
    domain: z.string().trim().min(1).max(253),
    emailRef: Ref.optional(),
    passwordRef: Ref.optional(),
    snapshotId: z.number().int().nonnegative().optional(),
  }).strict(),
  send_file: z.object({ path: Path, caption: z.string().max(1000).optional() }).strict(),
};
export type ToolName = keyof typeof schemas;

/** The computer_* tools: governed by ToolPolicy (request_sign_in and send_file only post cards). */
export const POLICY_TOOLS = [
  "computer_navigate", "computer_read", "computer_snapshot", "computer_click", "computer_type", "computer_key",
  "computer_scroll", "computer_screenshot", "computer_files_list", "computer_files_read", "computer_files_write", "computer_files_edit", "computer_files_search", "computer_exec",
] as const satisfies readonly ToolName[];
export type PolicyTool = (typeof POLICY_TOOLS)[number];

export const BROWSER_TOOLS = new Set<ToolName>([
  "computer_navigate", "computer_read", "computer_snapshot", "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_screenshot",
]);

/** The assistant sheet rows: display name, Read (Always) / Write group, the default mode (L140), common first. */
export const TOOL_INFO: Record<PolicyTool, { name: string; description: string; access: "read" | "write"; defaultMode: Mode; common: boolean }> = {
  computer_navigate: { name: "Open a page", description: "Open a web page in OpenDuet's own browser.", access: "read", defaultMode: "always", common: true },
  computer_read: { name: "Read the page", description: "Read the text of the open page.", access: "read", defaultMode: "always", common: true },
  computer_snapshot: { name: "Look at the page", description: "List what can be clicked or typed into on the open page.", access: "read", defaultMode: "always", common: true },
  computer_screenshot: { name: "Take a screenshot", description: "Capture the open page, and send it to the chat when asked.", access: "read", defaultMode: "always", common: false },
  computer_scroll: { name: "Scroll", description: "Scroll the open page.", access: "read", defaultMode: "always", common: false },
  computer_files_list: { name: "List files", description: "List the files in OpenDuet's workspace.", access: "read", defaultMode: "always", common: false },
  computer_files_read: { name: "Read files", description: "Read a file in OpenDuet's workspace.", access: "read", defaultMode: "always", common: false },
  computer_files_search: { name: "Search files", description: "Find text in files in OpenDuet's workspace.", access: "read", defaultMode: "always", common: false },
  computer_click: { name: "Click", description: "Click a button or link on the open page.", access: "write", defaultMode: "always", common: true },
  computer_type: { name: "Type", description: "Type into a field on the open page.", access: "write", defaultMode: "always", common: true },
  computer_key: { name: "Press a key", description: "Press a key such as Enter or Tab on the open page.", access: "write", defaultMode: "always", common: false },
  computer_files_write: { name: "Write files", description: "Save a file in OpenDuet's workspace; it's shared in this chat.", access: "write", defaultMode: "always", common: false },
  computer_files_edit: { name: "Edit files", description: "Replace text in a file in OpenDuet's workspace; it's shared in this chat.", access: "write", defaultMode: "always", common: false },
  computer_exec: { name: "Run commands", description: "Run a shell command (git, Python, Node) on OpenDuet's computer, in its own container without the browser's logins. A command can change files and reach the internet, so it asks first.", access: "write", defaultMode: "ask", common: true },
};

export const descriptions: Record<ToolName, string> = {
  // M23 W4: only after web_fetch, for what it can't do (user's case 2026-10-28).
  computer_navigate: "Open an http(s) URL in OpenDuet's own browser (signed in only where the user signed in through it). Use it only for a page that needs a sign-in, a page that needs JavaScript (web_fetch returned little or no text), or to click, fill in or post; to read, summarise or quote a link use web_fetch first. Returns the page's URL, title and readable text.",
  computer_read: "Read the open page's text again (after clicks or form submits) without navigating.",
  computer_snapshot: "List the page's interactive elements with refs (e.g. e12) for computer_click / computer_type / computer_key. Refs are valid only for the latest snapshot: take a new one after the page changes.",
  computer_click: "Click the element with this ref from the latest computer_snapshot.",
  computer_type: "Type text into the field with this ref from the latest snapshot (replaces its content); submit: true presses Enter after. Never type passwords: use request_sign_in.",
  computer_key: "Press a key (Enter, Tab, Escape, ArrowDown, PageDown ...), optionally on the element with this ref.",
  computer_scroll: "Scroll the open page by deltaY pixels (positive = down, default 600).",
  computer_screenshot: "Take a screenshot of the open page. sendToChat: true posts it in the chat as an image (with caption) so the user can see it.",
  computer_files_list: "List files and folders in /workspace (paths relative to /workspace).",
  computer_files_read: "Read a UTF-8 text file in /workspace (up to 10 MB). Optional offset and limit select lines (1-based); returns at most 60,000 characters with fromLine, toLine, totalLines and truncated. Without a range, reads from the beginning. Older computers can only read the beginning, not an offset.",
  computer_files_write: "Write a text file in /workspace (path relative to it; parent folders are created). The file is shared in this chat.",
  computer_files_edit: "Edit an existing UTF-8 file in /workspace (at most 1 MB) by replacing exact old_string with new_string. old_string must match once unless replace_all: true; copy its whitespace exactly from computer_files_read. The edited file is shared in this chat.",
  computer_files_search: "Search files in /workspace: query is literal unless regex: true (extended regex). Optional path is a folder (default root), glob selects file names (e.g. *.csv), ignore_case ignores case. Skips binary files, .git and node_modules; at most 200 matches, 300 characters per line, 20 seconds. Returns path:line: text, with a note when capped; no file card.",
  computer_exec: "Run a program in /workspace on OpenDuet's computer (the Environment section lists its programs), e.g. scripts and builds. Only for running programs: to list, read, write, edit or search files, use computer_files_list / read / write / edit / search, which don't ask the user by default (computer_exec does). timeoutSeconds: 120 by default, 600 at most; on timeout the whole process group is killed. Returns exit code, stdout and stderr (the end of long output).",
  request_sign_in: "When a site needs the user's password: open its sign-in page first, then call this with the site's domain to show the user a sign-in card for it. Domain only: the computer finds the login form on the open page itself. The user's details (and a verification code, if the site asks) go straight into the page; you never see them. Ends the turn: wait for the user.",
  send_file: "Send a file from /workspace to the user as a file card in this chat (up to 25 MB), with an optional caption.",
};

export function toolDefinition(name: ToolName, override?: { description?: string; schema?: z.ZodTypeAny }) {
  return {
    name,
    description: override?.description ?? descriptions[name],
    inputSchema: z.toJSONSchema(override?.schema ?? schemas[name], { io: "input" }) as Record<string, unknown>,
  };
}

/** For models without vision the screenshot goes to the chat only (the model can't look at it). */
export const SCREENSHOT_NO_VISION = {
  description: "Take a screenshot of the open page and post it in the chat as an image (with caption) for the user. You can't see screenshots yourself: use computer_read / computer_snapshot to read the page.",
  schema: z.object({ caption: z.string().max(500).optional() }).strict(),
};
