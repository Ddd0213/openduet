// Up next (L119): the assistant's open suggestions "From your connectors", Add (becomes a task) and Hide.
// The scan behind "Show me" (POST /api/up-next/scan, M4) is registered by the proactive module
// (registerUpNextScanRoutes); GET's `scanning` is true while one is queued or running. Someone
// else's item is 404.
// M23: each row carries `sourceRef` (the email / event it came from, never its id). Add and Hide
// answer for the row's suggestion cards too (one item, one answer): Add marks them started with the
// task, Hide hides them, each with a `message` event; Add on a row a card already started returns
// that task. Hide stamps hiddenAt (dedupe: not offered again for HIDDEN_SUGGESTION_DAYS).
import type { Suggestion as SuggestionRow } from "@prisma/client";
import type { RegisterRoutes } from "../app.ts";
import { AddSuggestionResponse, SaveForLaterRequest, SaveForLaterResponse, Suggestion, UpNext } from "../contract/tasks.ts";
import { HttpError, readJson } from "../http.ts";
import { log } from "../log.ts";
import { upNextScanning } from "../proactive/scanning.ts";
import { hideSuggestion, suggestionLock, syncLinkedCards } from "../suggestions/cards.ts";
import { titleKeyOf } from "../suggestions/dedupe.ts";
import { publicSourceRef } from "../suggestions/source.ts";
import { titleFromPrompt, toTaskSummary } from "../tasks/serialize.ts";
import type { TaskService } from "../tasks/service.ts";

const notFound = () => new HttpError(404, "not_found", "Not found.");

function toSuggestion(row: SuggestionRow) {
  const parsed = Suggestion.safeParse({
    id: row.id, channelId: row.channelId, title: row.title, body: row.body, app: row.app,
    origin: row.origin, fromUser: row.fromUser, sourceRef: publicSourceRef(row.sourceRef), createdAt: row.createdAt.toISOString(),
  });
  if (!parsed.success) log.warn("suggestion does not match the contract", { suggestionId: row.id });
  return parsed.success ? parsed.data : null;
}

export function registerUpNextRoutes(tasks: TaskService): RegisterRoutes {
  return (app) => {
    app.get("/api/up-next", async (c) => {
      const { db } = c.get("deps");
      const userId = c.get("user").id;
      const rows = await db.suggestion.findMany({ where: { userId, status: "open" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      return c.json(UpNext.parse({ suggestions: rows.flatMap((row) => toSuggestion(row) ?? []), scanning: await upNextScanning(db, userId) }));
    });

    app.post("/api/up-next/:id/add", async (c) => {
      const id = c.req.param("id");
      if (!id) throw notFound();
      const userId = c.get("user").id;
      const { db, events } = c.get("deps");
      // One task per item, even when Add is tapped twice or a card of the same item is started at
      // the same moment (the same lock as the card's Start, suggestions/cards.ts).
      const task = await suggestionLock.run(id, async () => {
        const row = await db.suggestion.findFirst({ where: { id, userId } });
        if (!row) throw notFound();
        if (row.taskId) {
          const existing = await tasks.own(userId, row.taskId);
          if (existing) return existing;
        }
        const channel = row.channelId ? await db.channel.findFirst({ where: { id: row.channelId, userId, archived: false }, select: { id: true } }) : null;
        // M22: one the user saved for later is theirs ("You asked"); the assistant's keeps its app ("From Gmail").
        const created = await tasks.create({
          userId, channelId: channel?.id ?? (await tasks.mainChannelId(userId)), title: row.title,
          prompt: row.prompt || row.title, description: row.fromUser ? "" : row.body,
          source: row.fromUser ? "user" : "proactive", noticedAt: row.fromUser ? null : row.createdAt, sourceApp: row.app,
        });
        await db.suggestion.update({ where: { id: row.id }, data: { status: "added", taskId: created.id } });
        return created;
      });
      // The item's cards show it started (outside the row's lock: they take their own).
      await syncLinkedCards({ db, events }, userId, id);
      const summary = toTaskSummary(task);
      if (!summary) throw new Error("task does not match the contract");
      return c.json(AddSuggestionResponse.parse({ task: summary }));
    });

    // M22 (#48): the + sheet's "Save for Up next": the request waits in Up next instead of starting.
    // Scans never hide or replace it (fromUser); Add starts it like any other item.
    app.post("/api/up-next", async (c) => {
      const input = await readJson(c, SaveForLaterRequest);
      const { db } = c.get("deps");
      const userId = c.get("user").id;
      const channel = await db.channel.findFirst({ where: { id: input.channelId, userId, archived: false }, select: { id: true } });
      if (!channel) throw notFound();
      // The user's own ask: never deduped away, but keyed so the assistant doesn't offer it again.
      const title = titleFromPrompt(input.prompt);
      const row = await db.suggestion.create({ data: {
        userId, channelId: channel.id, title, body: input.prompt, prompt: input.prompt,
        app: null, origin: "chat", fromUser: true, titleKey: titleKeyOf(title),
      } });
      const suggestion = toSuggestion(row);
      if (!suggestion) throw new Error("suggestion does not match the contract");
      return c.json(SaveForLaterResponse.parse({ suggestion }), 201);
    });

    app.post("/api/up-next/:id/hide", async (c) => {
      const id = c.req.param("id");
      if (!id) throw notFound();
      const { db, events } = c.get("deps");
      const userId = c.get("user").id;
      const row = await db.suggestion.findFirst({ where: { id, userId } });
      if (!row) throw notFound();
      // Only an open one hides (an added one keeps its task); its cards follow.
      if (await suggestionLock.run(row.id, () => hideSuggestion(db, userId, row.id))) await syncLinkedCards({ db, events }, userId, row.id);
      return c.body(null, 204);
    });
  };
}

/** Starts an Up next scan unless one is already queued or running (L119). */
export interface UpNextScanner { startUpNextScan(userId: string): Promise<void> }

/** POST /api/up-next/scan ("Show me"): 202 whether a scan starts or one is already running. */
export function registerUpNextScanRoutes(scanner: UpNextScanner): RegisterRoutes {
  return (app) => {
    app.post("/api/up-next/scan", async (c) => {
      await scanner.startUpNextScan(c.get("user").id);
      return c.body(null, 202);
    });
  };
}
