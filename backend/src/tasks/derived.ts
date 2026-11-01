// M22 (A P2-8): resources the task's own records name, added when the assistant didn't add_resource them.
// Rule-based and small: a file the assistant sent in the task's thread (duet://files/<id>), a page it made
// there once it's ready (duet://artifacts/<id>), and the https link a write tool of one of the
// task's runs returned (an event, a doc, a sent mail's permalink...: htmlLink / webViewLink / url
// ...). Deduped by link against what's there; at most NEW_PER_TURN new ones per turn and MAX_TOTAL
// in all, so a chatty run can't flood "Resources".
import type { Task as TaskRow } from "@prisma/client";
import type { Db } from "../db.ts";
import { classify } from "../policy/classify.ts";
import { resourcesOf, type Resource } from "./serialize.ts";
import { storedPayload } from "./thread.ts";

const NEW_PER_TURN = 5;
const MAX_TOTAL = 20;
const COMPOSIO_SLUG = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/;
const HTTPS = /^https:\/\/\S+$/;
/** Where tools put the page of what they made, most specific first. */
const LINK_KEYS = ["htmlLink", "webViewLink", "alternateLink", "webUrl", "web_url", "permalink", "url", "link"];
const TITLE_KEYS = ["summary", "title", "subject", "name"];

/** The resources to add now (empty when there's nothing new). */
export async function derivedResources(db: Db, task: TaskRow): Promise<Resource[]> {
  const have = resourcesOf(task);
  if (have.length >= MAX_TOTAL) return [];
  const seen = new Set(have.map((r) => r.link));
  const out: Resource[] = [];
  const add = (resource: Resource) => {
    if (seen.has(resource.link) || out.length >= Math.min(NEW_PER_TURN, MAX_TOTAL - have.length)) return;
    seen.add(resource.link);
    out.push(resource);
  };
  const cards = await db.message.findMany({
    where: { taskId: task.id, userId: task.userId, role: "assistant", kind: { in: ["file", "artifact"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100, select: { kind: true, payload: true },
  });
  for (const card of cards) {
    const payload = storedPayload(card.payload);
    const item = (card.kind === "file" ? payload.file : payload.artifact) as Record<string, unknown> | undefined;
    if (!item || typeof item.id !== "string") continue;
    if (card.kind === "file" && item.deletedAt) continue;
    if (card.kind === "file" && item.source === "assistant" && typeof item.name === "string") {
      add({ title: item.name, type: "file", link: `duet://files/${item.id}`, app: null });
    } else if (card.kind === "artifact" && item.status === "ready" && typeof item.title === "string") {
      add({ title: item.title, type: "artifact", link: `duet://artifacts/${item.id}`, app: null });
    }
  }
  const steps = await db.runStep.findMany({
    where: { kind: "tool", status: "ok", output: { not: null }, run: { taskId: task.id, userId: task.userId } },
    orderBy: [{ startedAt: "asc" }, { index: "asc" }], take: 200, select: { tool: true, app: true, output: true },
  });
  for (const s of steps) {
    const tool = s.tool ?? "";
    if (!COMPOSIO_SLUG.test(tool) || classify({ slug: tool, toolkit: null }) === "read") continue;
    let value: unknown;
    try {
      value = JSON.parse(s.output!);
    } catch {
      continue;
    }
    const link = find(value, LINK_KEYS, (v) => HTTPS.test(v) && v.length <= 2048);
    if (!link) continue;
    const title = find(value, TITLE_KEYS, (v) => v.trim().length > 0)?.trim().slice(0, 200) ?? s.app ?? tool;
    add({ title, type: typeOf(tool), link, app: s.app });
  }
  return out;
}

/** The first string under one of `keys` (in key order, then breadth-first) that passes `ok`. */
function find(value: unknown, keys: string[], ok: (v: string) => boolean): string | null {
  let level: unknown[] = [value];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const objects = level.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
    for (const key of keys) {
      for (const object of objects) {
        const v = object[key];
        if (typeof v === "string" && ok(v)) return v;
      }
    }
    level = level.flatMap((v) => (v && typeof v === "object" ? Object.values(v as object) : []));
  }
  return null;
}

function typeOf(slug: string): Resource["type"] {
  if (/CALENDAR|EVENT/.test(slug)) return "event";
  if (/MAIL|OUTLOOK/.test(slug)) return "email";
  if (/DOC|SHEET|SLIDE|NOTION|DRIVE|PAGE|FILE/.test(slug)) return "doc";
  return "link";
}
