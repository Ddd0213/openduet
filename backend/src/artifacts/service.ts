// Make artifacts (L151, L181): POST /api/artifacts stores an Artifact (building) and queues a
// `build` run on the run host. The model writes /workspace/artifacts/<id>/index.html on the assistant's
// computer with backend A's computer tools, then calls finish_build: the HTML is read back through
// Workspace.readFile, gets the shared base (src/make/base.ts) and is stored with its sources; the
// chat gets the artifact card and an "OpenDuet made a page." line. Progress goes out as `artifact`
// events (build.starting_up -> build.waking_workspace -> the model's step lines -> null when done).
// Refresh (now or on the artifact's schedule) and ✎ edit rebuild in place from the stored page.
import type { Artifact as ArtifactRow, Prisma } from "@prisma/client";
import { z } from "zod";
import type { TurnSink } from "../agent/types.ts";
import type { Phrase } from "../contract/common.ts";
import type { ArtifactStartedBy, ArtifactWorkStatus } from "../contract/m21.ts";
import { ArtifactMessage } from "../contract/messages.ts";
import { takeBuildStop } from "../computer/build-stops.ts";
import { ComputerError } from "../computer/client.ts";
import type { Workspace } from "../computer/workspace.ts";
import type { Db } from "../db.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError } from "../http.ts";
import { log } from "../log.ts";
import { checkHtml, countChanged, stripChanged, stripInjected, withBase, withData } from "../make/base.ts";
import { artifactPath, buildPrompt, type ArtifactType, type BuildMode } from "../make/prompts.ts";
import { PageQualityGate } from "../make/quality-gate.ts";
import { KeyedLock } from "../tasks/lock.ts";
import { MAX_ARTIFACT_VERSIONS, type ArtifactVersionBy } from "../contract/m24.ts";
import { ArtifactDataResponse, DATA_UPDATES_PER_MINUTE, type DataRefusalCode, type UpdateArtifactDataInput, type UpdateArtifactDataResult } from "../contract/m27.ts";
import { applyOps, checkedData } from "./data.ts";
import { BuildEvidence, metricWarnings } from "./checks.ts";
import { pageText } from "./text.ts";
import { saveDataVersion, saveVersion, VERSION_ORDER, versionMetrics, versionSummary } from "./versions.ts";
import type { NotifyInput } from "../notify/notifier.ts";
import { NOTIFY_ARTIFACT_FAILED, NOTIFY_ARTIFACT_READY, textParam } from "../notify/phrases.ts";
import { collapseIdFor } from "../notify/triggers.ts";
import type { RunHost, TurnHooks, TurnOutcome } from "../runs/host.ts";
import { taskBuildOutcome, taskBuilds } from "../tasks/builds.ts";
import { postMessage, storedPayload, updatePayload } from "../tasks/thread.ts";
import type { UsageMeter } from "../usage/meter.ts";
import { buildSink } from "./build-sink.ts";
import { pageSize, removedBy, replaceText, shrank, SHRINK_RATIO, type PageSize } from "./page-edit.ts";
import { latestSlot } from "./schedule.ts";
import { contentUpdatedAt, draftTitle, scheduleOf, sourcesOf, toDetail, toSummary, type RefreshSchedule, type Source } from "./serialize.ts";

export const STARTING: Phrase = { key: "build.starting_up" };
export const WAKING: Phrase = { key: "build.waking_workspace" };
/** Build failures (terminal `artifact` event's buildStatus, and the chat line when the user asked). */
export const NOT_FINISHED: Phrase = { key: "artifact.not_finished" };
export const UNREACHABLE: Phrase = { key: "artifact.workspace_unreachable" };
export const INTERRUPTED: Phrase = { key: "artifact.interrupted" };
export const NOT_CONFIGURED: Phrase = { key: "artifact.computer_not_set_up" };
/** M20: the build stopped because the user held the assistant's browser (computer/build-stops.ts). */
export const USER_IN_CONTROL: Phrase = { key: "artifact.user_in_control" };
/** M21: the edit / refresh ended after finish_build refused a much shorter page (page-edit.ts). */
export const PAGE_SHRANK: Phrase = { key: "artifact.page_shrank" };
/** M21 (#46): after an edit / refresh asked for in the chat is saved, one line in that chat. */
export const EDITED_KEY = "artifact.edited";
export const REFRESHED_KEY = "artifact.refreshed";

/** "OpenDuet made a page." and its siblings, by type. */
export const MADE_KEY: Record<ArtifactType, string> = {
  web_page: "system.made_page",
  docs: "system.made_doc",
  slides: "system.made_slides",
  dashboard: "system.made_dashboard",
  design: "system.made_design",
  design_system: "system.made_design_system",
};

/** Largest page finish_build stores. */
export const MAX_HTML_BYTES = 5 * 1024 * 1024;
/** After an edit, served HTML keeps the change markers (the glow) this long. */
export const GLOW_MS = 60_000;
/** How often start() checks refresh schedules. */
export const TICK_MS = 60_000;

export const Metrics = ArtifactMessage.shape.payload.shape.metrics;
export type Metric = z.infer<typeof Metrics>[number];

type Origin = "user" | "schedule";
export type StartedBy = ArtifactStartedBy;

/** M21: who asked for a refresh (refresh_artifact in chat passes the assistant and the chat). */
export interface RefreshBy {
  startedBy?: StartedBy;
  /** asked for in the chat: the thread gets "Refreshed <title>." once it's saved */
  chat?: boolean;
  channelId?: string;
  taskId?: string | null;
  /** M29: asked for by a proactive turn (JobInput.quiet) */
  quiet?: boolean;
}

export interface EditInput {
  userId: string;
  id: string;
  prompt: string;
  channelId?: string;
  taskId?: string | null;
  startedBy?: StartedBy;
  /** M21: asked for in the chat (edit_artifact): the thread gets "Updated <title>." once it's saved */
  chat?: boolean;
  /** M29: asked for by a proactive turn (JobInput.quiet) */
  quiet?: boolean;
}

interface JobInput {
  artifactId: string;
  userId: string;
  mode: BuildMode;
  /** the thread the finished card / failure line goes to */
  channelId: string;
  taskId: string | null;
  /** ✎ edit: the requested change */
  edit?: string;
  origin: Origin;
  /** who asked: the user (Create, ↻, ✎) or the assistant (make_artifact / edit_artifact) or the schedule */
  startedBy: StartedBy;
  /** Display attribution only; lower-trust startedBy remains independent. */
  versionBy?: ArtifactVersionBy;
  /** M21: asked for in the chat (edit_artifact / refresh_artifact): a saved edit or refresh says so there */
  chat?: boolean;
  /** M29: asked for by a proactive turn (check-in, scan, routine): its ready / failed push follows quiet hours */
  quiet?: boolean;
}

interface Job extends JobInput {
  quality: PageQualityGate;
  evidence: BuildEvidence;
  runId: string | null;
  finished: boolean;
  failure: Phrase | null;
  /** M14: removed from its task's running builds (tasks/builds.ts) */
  taskSettled?: boolean;
  /** M21: edit / refresh: the page the build started from (as written to the workspace) and its size */
  original?: string;
  originalSize?: PageSize;
  /** Refreshes of live dashboards save data only, never read or change the page. */
  liveData?: boolean;
  /** M21: what edit_page removed on purpose this build (credited by the shrink guard) */
  cut?: PageSize;
  /** M21: the last finish_build was refused as a much shorter page (the build fails with page_shrank) */
  shrank?: boolean;
}

/** Edits and refreshes report their own status (M21); a first build reports buildStatus only. */
type WorkMode = Exclude<BuildMode, "create">;
const isWork = (mode: BuildMode): mode is WorkMode => mode !== "create";

export interface FinishArgs {
  path: string;
  title: string | null;
  sources: Source[] | null;
  metrics: Metric[] | null;
  refreshSchedule: RefreshSchedule | null;
  data?: unknown;
}

export type FinishResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

export interface ArtifactDeps {
  db: Db;
  events: EventBus;
  runs: RunHost;
  workspace: Workspace;
  /** when set, user-started builds respect the usage limits (429) and scheduled ones skip */
  usage?: UsageMeter;
  /** M29: the ready / failed push of a build (index.ts wires the Notifier) */
  notify?: (input: NotifyInput) => Promise<unknown>;
  now?: () => Date;
}

/** Make's order (M10): pinned first, newest pin first; then updatedAt desc (id breaks ties). */
const PINNED_FIRST = [
  { pinnedAt: { sort: "desc", nulls: "last" } },
  { updatedAt: "desc" },
  { id: "desc" },
] satisfies Prisma.ArtifactOrderByWithRelationInput[];

const notFound = () => new HttpError(404, "not_found", "Not found.");
const notConfigured = () => new HttpError(503, "not_configured", "OpenDuet's computer isn't set up on this server.");

/** "artifacts/<id>/index.html", from "/workspace/artifacts/<id>/index.html" or "./artifacts/..." too. */
export function workspaceRelative(path: string): string {
  return path.trim().replace(/^\/workspace\//, "").replace(/^\.\//, "");
}

export class ArtifactService {
  private readonly now: () => Date;
  private readonly contentLock = new KeyedLock();
  /** build runs by run id, from the run's start (before hook) until it settles */
  private readonly jobs = new Map<string, Job>();
  /** artifact id -> runs queued or running for it */
  private readonly pending = new Map<string, number>();
  /** artifact id -> the build view's current status while a run is live */
  private readonly live = new Map<string, Phrase>();
  /** artifact id -> until when served HTML keeps an edit's change markers */
  private readonly glow = new Map<string, number>();
  /** artifact id -> the schedule slot (ms) already refreshed (or tried) in this process */
  private readonly claims = new Map<string, number>();
  /**
   * M18: artifact id -> edits asked for while its first build was still building (in memory only:
   * a server restart drops them). Applied as one edit right after that build finishes; folded into
   * the prompt when it fails, so a retry includes them.
   */
  private readonly queuedEdits = new Map<string, { prompt: string; startedBy: StartedBy; versionBy: ArtifactVersionBy; chat?: boolean }[]>();
  /** M21: artifact id -> its builds queued or running that haven't saved or failed yet */
  private readonly working = new Map<string, Set<Job>>();
  /** M21: artifact id -> why its last edit / refresh failed (cleared once a page is saved) */
  private readonly failures = new Map<string, Partial<Record<WorkMode, Phrase>>>();
  private readonly dataSaves = new Map<string, number[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<number> | null = null;

  constructor(private readonly deps: ArtifactDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get configured(): boolean {
    return this.deps.workspace.configured;
  }

  /** OpenDuet's computer is set up and this user is its owner (one owner per deployment). */
  async usable(userId: string): Promise<boolean> {
    const { workspace } = this.deps;
    return workspace.configured && (workspace.allows ? await workspace.allows(userId) : true);
  }

  /** A build run the user started themselves (Create, ↻, ✎): its tools may run without asking. */
  userStarted(runId: string): boolean {
    const job = this.jobs.get(runId);
    return !!job && job.origin === "user" && job.startedBy === "user";
  }

  /** Whether this run is a Make build (its tools are finish_build and the computer tools). */
  isBuild(runId: string): boolean {
    return this.jobs.has(runId);
  }

  /** M21: what this build run does (edit / refresh runs also get edit_page); null when it isn't one. */
  buildMode(runId: string): BuildMode | null {
    return this.jobs.get(runId)?.mode ?? null;
  }

  dataOnly(runId: string): boolean {
    const job = this.jobs.get(runId);
    return job?.mode === "refresh" && job.liveData === true;
  }

  /** M10: pinned first (newest pin first), then the newest content first. */
  async list(userId: string) {
    const rows = await this.deps.db.artifact.findMany({ where: { userId }, orderBy: PINNED_FIRST });
    return rows.map(toSummary);
  }

  async detail(userId: string, id: string) {
    // Raw update deliberately leaves the content timestamp alone, including under a concurrent save.
    return this.deps.db.$transaction(async tx => {
      const count = await tx.$executeRaw`UPDATE Artifact SET lastOpenedAt = ${this.now()} WHERE id = ${id} AND userId = ${userId}`;
      if (!count) throw notFound();
      return toDetail(await tx.artifact.findUniqueOrThrow({ where: { id } }));
    });
  }

  /** Tool reads do not count as the person opening the page. */
  async read(userId: string, id: string) {
    const row = await this.deps.db.artifact.findFirst({ where: { id, userId } });
    if (!row) return null;
    return { artifactId: row.id, type: row.type, title: row.title, status: row.status,
      updatedAt: contentUpdatedAt(row).toISOString(), dataVersion: row.dataVersion,
      ...(row.type === "dashboard" && row.data !== null ? { data: JSON.parse(row.data) } : {}), sources: sourcesOf(row), ...pageText(row.html) };
  }

  async data(userId: string, id: string): Promise<ArtifactDataResponse> {
    const row = await this.own(userId, id);
    return ArtifactDataResponse.parse({ artifactId: id, dataVersion: row.dataVersion, dataUpdatedAt: row.dataUpdatedAt?.toISOString() ?? null, json: row.data });
  }

  async updateData(userId: string, runId: string, input: UpdateArtifactDataInput): Promise<UpdateArtifactDataResult> {
    return this.contentLock.run(input.artifactId, async () => {
      const row = await this.deps.db.artifact.findFirst({ where: { id: input.artifactId, userId } });
      const refuse = (code: DataRefusalCode, error: string, retryAfterMs: number | null = null): UpdateArtifactDataResult => ({ code, error, dataVersion: row?.dataVersion ?? null, retryAfterMs });
      if (!row) return refuse("not_found", "No artifact with that id.");
      if (row.type !== "dashboard") return refuse("not_dashboard", "Only dashboards have live data. Use edit_artifact or refresh_artifact for this page.");
      if (row.status !== "ready" || !row.html) return refuse("not_ready", "Its first build hasn't saved a page yet. Try again once its card is in the thread.");
      if (row.data === null) return refuse("no_data", "This dashboard was built without live data. Use refresh_artifact, or edit_artifact to rebuild it on live data.");
      if (input.expectedVersion !== null && input.expectedVersion !== row.dataVersion) return refuse("version_conflict", `The data is at version ${row.dataVersion} now. Call read_artifact again and redo the change.`);
      const applied = input.ops ? applyOps(row.data, input.ops) : checkedData(input.data, row.data);
      if (!applied.ok) return refuse(applied.code, applied.error);
      const answer = (status: "updated" | "unchanged", saved: ArtifactRow): UpdateArtifactDataResult => ({ status, artifactId: saved.id, title: saved.title, dataVersion: saved.dataVersion,
        bytes: new TextEncoder().encode(applied.data).byteLength, note: status === "updated" ? "Saved. An open dashboard shows it within seconds; nothing was rebuilt." : "The data was already like this; nothing was saved." });
      if (!applied.changed) return answer("unchanged", row);
      const now = this.now();
      const times = (this.dataSaves.get(row.id) ?? []).filter(time => time > now.getTime() - 60_000);
      this.dataSaves.set(row.id, times);
      if (times.length >= DATA_UPDATES_PER_MINUTE) return refuse("too_frequent", "Batch the changes into one call; this dashboard has reached 20 saved updates in the last minute.", Math.max(0, times[0]! + 60_000 - now.getTime()));
      const updated = await this.deps.db.$transaction(async tx => {
        const latest = await tx.artifactVersion.findFirst({ where: { artifactId: row.id }, orderBy: VERSION_ORDER });
        const updated = await tx.artifact.update({ where: { id: row.id }, data: { data: applied.data, dataVersion: { increment: 1 },
          dataUpdatedAt: new Date(Math.max(now.getTime(), contentUpdatedAt(row).getTime() + 1)), updatedAt: row.updatedAt } });
        await saveDataVersion(tx, updated, { runId, metrics: input.metrics ? JSON.stringify(input.metrics) : latest?.metrics ?? null, now });
        return updated;
      });
      times.push(now.getTime());
      await this.emitCurrent(updated);
      await this.syncCards(updated, input.metrics ?? null);
      return answer("updated", updated);
    });
  }

  async versions(userId: string, id: string) {
    await this.own(userId, id);
    const rows = await this.deps.db.artifactVersion.findMany({ where: { artifactId: id }, orderBy: VERSION_ORDER, take: MAX_ARTIFACT_VERSIONS,
      select: { id: true, artifactId: true, by: true, reason: true, prompt: true, createdAt: true, dataUpdates: true } });
    return rows.map(row => versionSummary({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  async restore(userId: string, id: string, versionId: string) {
    return this.contentLock.run(id, async () => {
      await this.own(userId, id);
      if (this.busy(id)) throw new HttpError(409, "conflict", "Wait for this artifact's build to finish before restoring a version.");
      const result = await this.deps.db.$transaction(async tx => {
        const row = await tx.artifact.findFirst({ where: { id, userId } });
        if (!row) throw notFound();
        const version = await tx.artifactVersion.findFirst({ where: { id: versionId, artifactId: id } });
        if (!version) throw notFound();
        const latest = await tx.artifactVersion.findFirst({ where: { artifactId: id }, orderBy: VERSION_ORDER });
        if (version.id === latest?.id) return { row, metrics: null, changed: false };
        // A repeated tap still names the old id, not the new restore row's id.
        if (latest?.reason === "restore" && stripChanged(row.html) === stripChanged(version.html)
          && row.sources === version.sources && row.data === version.data && (version.metrics === null || version.metrics === latest.metrics)) {
          return { row, metrics: null, changed: false };
        }
        const now = new Date(Math.max(this.now().getTime(), contentUpdatedAt(row).getTime() + 1));
        const pageChanged = stripChanged(row.html) !== stripChanged(version.html) || row.sources !== version.sources;
        const dataChanged = row.data !== version.data;
        const updated = await tx.artifact.update({ where: { id }, data: { html: stripChanged(version.html), sources: version.sources, data: version.data, status: "ready",
          updatedAt: pageChanged ? now : row.updatedAt,
          ...(dataChanged ? { dataVersion: { increment: 1 }, dataUpdatedAt: now } : {}) } });
        await saveVersion(tx, updated, { by: "user", reason: "restore", prompt: null, metrics: version.metrics ?? latest?.metrics ?? null, now });
        return { row: updated, metrics: versionMetrics(version.metrics), changed: true };
      });
      if (result.changed) {
        this.glow.delete(id);
        this.failures.delete(id);
        await this.emit(result.row, null, false);
        await this.syncCards(result.row, result.metrics);
      }
      return toSummary(result.row);
    });
  }

  /** The stored page; an edit's change markers only while its glow window is open. */
  async html(userId: string, id: string): Promise<string> {
    const row = await this.own(userId, id);
    if (!row.html) throw new HttpError(404, "not_found", "This artifact has no page yet.");
    const until = this.glow.get(id);
    const html = until !== undefined && until > this.now().getTime() ? row.html : stripChanged(row.html);
    return row.type === "dashboard" && row.data !== null ? withData(html, row.data, row.dataVersion) : html;
  }

  /** The newest artifacts (pinned ones first, as in Make), for the model's context in chat (data, not instructions). */
  async recent(userId: string, limit = 8) {
    const rows = await this.deps.db.artifact.findMany({ where: { userId }, orderBy: PINNED_FIRST, take: limit, select: { id: true, type: true, title: true, status: true, data: true } });
    return rows.map(({ data, ...row }) => ({ ...row, liveData: row.type === "dashboard" && data !== null }));
  }

  /**
   * A new artifact (Describe sheet, gallery composer, make_artifact in chat). 503 not_configured when
   * OpenDuet's computer isn't set up (nothing is stored), 404 for someone else's channel.
   */
  async create(input: { userId: string; type: ArtifactType; prompt: string; channelId: string; taskId?: string | null; title?: string; startedBy?: StartedBy; quiet?: boolean }) {
    const { db } = this.deps;
    const channel = await db.channel.findFirst({ where: { id: input.channelId, userId: input.userId }, select: { id: true } });
    if (!channel) throw notFound();
    if (!(await this.usable(input.userId))) throw notConfigured();
    await this.ensureUsage(input.userId);
    // M21 (#18): who started it is stored, so Retry later rebuilds it with the same trust.
    const startedBy = input.startedBy ?? "user";
    const row = await db.artifact.create({ data: {
      userId: input.userId, channelId: input.channelId, type: input.type, title: input.title?.trim() || draftTitle(input.prompt),
      prompt: input.prompt, status: "building", startedBy,
    } });
    await this.queue(row, { artifactId: row.id, userId: input.userId, mode: "create", channelId: input.channelId, taskId: input.taskId ?? null, origin: "user", startedBy, quiet: input.quiet });
    return toSummary(await this.own(input.userId, row.id));
  }

  /**
   * PATCH: rename, Add to / Remove from tab bar (one artifact is the 4th tab at a time), the
   * refresh schedule and (M10) Pin / Unpin in Make (any number; pinning a pinned one keeps its pin
   * time). updatedAt stays: it means "content updated" ("Updated now", Changed today).
   */
  async update(userId: string, id: string, body: { title?: string; pinnedToTabBar?: boolean; pinned?: boolean; refreshSchedule?: RefreshSchedule | null }) {
    const { db } = this.deps;
    const row = await this.own(userId, id);
    if (body.pinnedToTabBar === true) {
      const others = await db.artifact.findMany({ where: { userId, pinnedToTabBar: true, id: { not: id } } });
      for (const other of others) {
        const unpinned = await db.artifact.update({ where: { id: other.id }, data: { pinnedToTabBar: false, updatedAt: other.updatedAt } });
        await this.emitCurrent(unpinned);
      }
    }
    const data: Record<string, unknown> = { updatedAt: row.updatedAt };
    if (body.title !== undefined) data.title = body.title;
    if (body.pinnedToTabBar !== undefined) data.pinnedToTabBar = body.pinnedToTabBar;
    if (body.pinned !== undefined) data.pinnedAt = body.pinned ? (row.pinnedAt ?? this.now()) : null;
    if (body.refreshSchedule !== undefined) data.refreshSchedule = body.refreshSchedule === null ? null : JSON.stringify(body.refreshSchedule);
    const updated = await db.artifact.update({ where: { id }, data });
    await this.emitCurrent(updated);
    await this.syncCards(updated, null);
    return toSummary(updated);
  }

  /** DELETE. Cards already in chat stay as they were (opening one answers 404). */
  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.deps.db.artifact.deleteMany({ where: { id, userId } });
    if (count === 0) throw notFound();
    this.live.delete(id);
    this.glow.delete(id);
    this.claims.delete(id);
    this.queuedEdits.delete(id);
    this.working.delete(id);
    this.failures.delete(id);
    this.dataSaves.delete(id);
  }

  /**
   * ↻ Refresh now: rebuild from the stored sources. A refresh already queued or running answers
   * as is; an artifact whose first build failed builds again from its prompt, in place (M21 #18:
   * this is the build view's Retry; same artifact, no new one).
   * M21: the rebuild runs with the lower trust of who asks and who started the artifact
   * (Artifact.startedBy): a prompt the assistant wrote never gets the user's trust from a tap on Retry or ↻.
   */
  async refresh(userId: string, id: string, origin: Origin = "user", by: RefreshBy = {}) {
    const row = await this.own(userId, id);
    if (!(await this.usable(userId))) throw notConfigured();
    if (this.pendingFor(id) > 0) return toSummary(row);
    if (origin === "user") await this.ensureUsage(userId);
    const startedBy: StartedBy = by.startedBy === "assistant" || row.startedBy === "assistant" ? "assistant" : "user";
    const job = { artifactId: id, userId, origin, startedBy, versionBy: origin === "schedule" ? "assistant" as const : by.startedBy ?? "user", channelId: by.channelId ?? row.channelId, taskId: by.taskId ?? null, chat: by.chat, quiet: by.quiet };
    if (!row.html) {
      const building = await this.deps.db.artifact.update({ where: { id }, data: { status: "building" } });
      await this.queue(building, { ...job, mode: "create", channelId: row.channelId, chat: false });
      return toSummary(building);
    }
    await this.queue(row, { ...job, mode: "refresh" });
    return toSummary(row);
  }

  /**
   * ✎ edit (or edit_artifact from chat): the assistant changes the page as asked and it re-renders in
   * place; the changed passages carry the change marker and glow (GLOW_MS on the served HTML).
   */
  async edit(input: EditInput) {
    return (await this.requestEdit(input)).artifact;
  }

  /**
   * M18: edit(), and while the first build is still building (no page yet) the edit is kept and
   * applied right after it (queued: true). Still 400 when there's no page and nothing building.
   * M21: `chat` = asked for in the chat (edit_artifact): once saved, that chat gets "Updated <title>.".
   */
  async requestEdit(input: EditInput) {
    if (!(await this.usable(input.userId))) throw notConfigured();
    // Read last, right before the synchronous check: a first build finishing meanwhile has written
    // its page (and taken the queued edits), so this edit then runs as a normal edit.
    const row = await this.own(input.userId, input.id);
    // M21: the edit prompt carries the artifact's own request (row.prompt), so an artifact the assistant
    // started is edited with the assistant's trust even when the user asks (the lower of the two, as refresh()).
    const startedBy: "user" | "assistant" = input.startedBy === "assistant" || row.startedBy === "assistant" ? "assistant" : "user";
    if (!row.html && row.status === "building" && this.pendingFor(row.id) > 0) {
      this.queuedEdits.set(row.id, [...(this.queuedEdits.get(row.id) ?? []), { prompt: input.prompt, startedBy, versionBy: input.startedBy ?? "user", chat: input.chat }]);
      return { artifact: toSummary(row), queued: true };
    }
    if (!row.html) throw new HttpError(400, "validation_failed", "There's nothing to edit yet.");
    await this.ensureUsage(input.userId);
    await this.queue(row, {
      artifactId: row.id, userId: input.userId, mode: "edit", edit: input.prompt,
      channelId: input.channelId ?? row.channelId, taskId: input.taskId ?? null, origin: "user", startedBy, versionBy: input.startedBy ?? "user", chat: input.chat, quiet: input.quiet,
    });
    return { artifact: toSummary(row), queued: false };
  }

  /**
   * M18: the first build finished: the edits kept meanwhile run, the user's as one edit and
   * the assistant's as another (each keeps who asked, so its text never runs with the user's trust).
   * Never throws.
   */
  private async applyQueuedEdits(row: ArtifactRow, job: Job): Promise<void> {
    const edits = this.queuedEdits.get(row.id);
    this.queuedEdits.delete(row.id);
    if (!edits?.length) return;
    try {
      for (const startedBy of ["user", "assistant"] as const) {
        const mine = edits.filter((e) => e.startedBy === startedBy);
        if (!mine.length) continue;
        await this.queue(row, {
          artifactId: row.id, userId: job.userId, mode: "edit", edit: mine.map((e) => e.prompt).join("\n\n"),
          channelId: job.channelId, taskId: null, origin: "user", startedBy, versionBy: mine.some(e => e.versionBy === "assistant") ? "assistant" : "user", chat: mine.some((e) => e.chat),
        });
      }
    } catch (error) {
      log.warn("queued artifact edit failed to start", { artifactId: row.id, error: { name: (error as Error).name } });
    }
  }

  /**
   * M18: the first build failed: the edits kept meanwhile join its prompt, so a retry includes them.
   * M21 (#18): only edits that don't raise the prompt's trust join it: into a prompt the user wrote
   * only the user's own edits; into one the assistant started, any (they then run with the assistant's trust).
   * The rest stay queued and run as their own edit once a retry has built the page.
   */
  private async foldQueuedEdits(id: string): Promise<void> {
    const edits = this.queuedEdits.get(id);
    this.queuedEdits.delete(id);
    if (!edits?.length) return;
    const row = await this.deps.db.artifact.findFirst({ where: { id }, select: { prompt: true, startedBy: true } });
    if (!row) return;
    const fold = edits.filter((e) => row.startedBy === "assistant" || e.startedBy === "user");
    const keep = edits.filter((e) => !fold.includes(e));
    if (keep.length) this.queuedEdits.set(id, keep);
    if (!fold.length) return;
    await this.deps.db.artifact.update({ where: { id }, data: { prompt: `${row.prompt}\n\nAlso: ${fold.map((e) => e.prompt).join("\n\nAlso: ")}` } });
  }

  /** M21: whether a build, edit or refresh of this artifact is queued or running (refresh() then queues nothing). */
  busy(id: string): boolean {
    return this.pendingFor(id) > 0;
  }

  private pendingFor(id: string): number {
    return this.pending.get(id) ?? 0;
  }

  private bump(id: string, by: 1 | -1): void {
    const next = this.pendingFor(id) + by;
    if (next > 0) this.pending.set(id, next);
    else this.pending.delete(id);
  }

  /**
   * Queues the build run; a refused submit (shutting down) fails the build honestly. M21: the job
   * counts as working from here (its STARTING event already says editStatus / refreshStatus
   * working) until it saves a page or fails.
   */
  private queue(row: ArtifactRow, input: JobInput): Promise<void> {
    return this.contentLock.run(row.id, () => this.queueUnlocked(row, input));
  }

  private async queueUnlocked(row: ArtifactRow, input: JobInput): Promise<void> {
    const liveData = row.type === "dashboard" && row.data !== null;
    const job: Job = { ...input, liveData, runId: null, finished: false, failure: null, quality: new PageQualityGate(), evidence: new BuildEvidence() };
    const prompt = buildPrompt({ mode: input.mode, type: row.type as ArtifactType, id: row.id, prompt: row.prompt, title: row.title, edit: input.edit, sources: sourcesOf(row), liveData });
    this.track(job);
    try {
      await this.emit(row, STARTING, true);
    } catch (error) {
      this.untrack(job);
      throw error;
    }
    this.bump(row.id, 1);
    // M14: finish_task refuses while a build its task started is still building.
    if (job.taskId) taskBuilds.started(job.taskId, row.id);
    let runId: string | null = null;
    try {
      runId = await this.deps.runs.submit({ userId: input.userId, channelId: row.channelId, taskId: null, kind: "build", prompt, hooks: this.hooks(job), queue: `artifact:${row.id}` });
    } catch (error) {
      this.settleTask(job, false); // never queued: it no longer holds up the task's finish_task
      this.untrack(job);
      throw error;
    } finally {
      if (!runId) this.bump(row.id, -1);
    }
    if (!runId) await this.fail(job, INTERRUPTED, true, false);
  }

  /** M21: this job is working on its artifact; a new edit / refresh replaces that mode's last failure. */
  private track(job: Job): void {
    const set = this.working.get(job.artifactId) ?? new Set<Job>();
    set.add(job);
    this.working.set(job.artifactId, set);
    if (isWork(job.mode)) delete this.failures.get(job.artifactId)?.[job.mode];
  }

  private untrack(job: Job): void {
    const set = this.working.get(job.artifactId);
    set?.delete(job);
    if (set && !set.size) this.working.delete(job.artifactId);
  }

  /** The job is over (saved, failed, or its artifact is gone): it no longer counts as working. */
  private close(job: Job): void {
    job.finished = true;
    this.untrack(job);
  }

  /**
   * M21: the artifact event's editStatus / refreshStatus: working while an edit (refresh) of it is
   * queued or running, failed with the reason after the last one gave up, null otherwise.
   */
  private workStatus(id: string, mode: WorkMode): ArtifactWorkStatus | null {
    for (const job of this.working.get(id) ?? []) if (job.mode === mode) return { state: "working", reason: null };
    const reason = this.failures.get(id)?.[mode];
    return reason ? { state: "failed", reason } : null;
  }

  private hooks(job: Job): TurnHooks {
    return {
      before: async (runId) => {
        job.runId = runId;
        this.jobs.set(runId, job);
        try {
          return await this.prepare(job);
        } catch (error) {
          log.warn("build prepare failed", { runId, error: { name: (error as Error).name } });
          // M20: the computer refused the page's write because the user holds the browser.
          job.failure = error instanceof ComputerError && error.kind === "human_in_control" ? USER_IN_CONTROL : UNREACHABLE;
          return false;
        }
      },
      around: (input, next) => next({ ...input, sink: this.sink(job, input.sink), steps: job.evidence.steps(input.steps) }),
      after: (outcome) => this.settle(job, outcome),
    };
  }

  /** Right before the run: the artifact still exists, the workspace is up and holds the current page. */
  private async prepare(job: Job): Promise<boolean> {
    const row = await this.deps.db.artifact.findFirst({ where: { id: job.artifactId, userId: job.userId } });
    if (!row) {
      this.close(job); // deleted while queued: nothing to report
      return false;
    }
    if (!(await this.usable(job.userId))) {
      job.failure = NOT_CONFIGURED;
      return false;
    }
    await this.emit(row, WAKING, true);
    if (job.mode !== "create" && row.html) {
      // Edits and refreshes start from the stored page (the workspace may have been reset), as the
      // model wrote it: M21 (#10) without the base, CSP and viewport the server injects, so none of
      // it is read, copied and saved back as the page's own. finish_build injects it again.
      const current = stripInjected(stripChanged(row.html));
      job.original = current;
      job.originalSize = pageSize(current);
      job.cut = { markup: 0, text: 0 };
      await this.deps.workspace.writeFile(job.userId, artifactPath(row.id), new TextEncoder().encode(current), { runId: job.runId ?? undefined });
      if (row.type === "dashboard" && row.data !== null) await this.deps.workspace.writeFile(job.userId, `artifacts/${row.id}/data.json`, new TextEncoder().encode(JSON.stringify(JSON.parse(row.data), null, 2)), { runId: job.runId ?? undefined });
    }
    return true;
  }

  private sink(job: Job, raw: TurnSink): TurnSink {
    return buildSink(raw, {
      channelId: job.channelId,
      taskId: job.taskId,
      step: async (text) => {
        if (job.finished) return;
        const row = await this.deps.db.artifact.findFirst({ where: { id: job.artifactId } });
        if (row) await this.emit(row, { text }, true);
      },
    });
  }

  /** After the run: anything that didn't reach finish_build fails with a reason. */
  private async settle(job: Job, outcome: TurnOutcome): Promise<void> {
    this.jobs.delete(outcome.runId);
    this.bump(job.artifactId, -1);
    const stopped = takeBuildStop(outcome.runId);
    if (job.finished) {
      this.settleTask(job, false); // e.g. deleted while queued: no outcome for the task, just not running
      return;
    }
    // M29: a build stopped (Stop, a delete, a shutdown, the user's Take over) isn't pushed as failed.
    if (outcome.skipped) return this.fail(job, job.failure ?? INTERRUPTED, true, job.failure !== null);
    const { result } = outcome;
    if (result.status === "cancelled") return this.fail(job, INTERRUPTED, true, false);
    // A failed turn already got its grey line from the run host (model error); don't repeat it.
    if (result.status === "failed") return this.fail(job, result.error ?? INTERRUPTED, false);
    // M20: a build the user's Take over stopped says so, not "didn't finish".
    if (stopped === "user_in_control") return this.fail(job, USER_IN_CONTROL, true, false);
    // M21: it ended right after finish_build refused a much shorter page.
    return this.fail(job, job.shrank ? PAGE_SHRANK : NOT_FINISHED);
  }

  /**
   * A build that ended without a page: a first build turns failed (status failed); a refresh or
   * edit keeps the last good version. The terminal event carries the reason; when the user asked
   * for it, the thread gets it as a grey line too. M29: `push` = notify.artifact_failed (notifyBuilt()).
   */
  private async fail(job: Job, reason: Phrase, post = true, push = true): Promise<void> {
    this.close(job);
    const forTask = this.settleTask(job);
    // M18: the task's outcome is delivered below; if anything before it throws, the task still
    // stops waiting for it (taskBuilds.undelivered).
    let delivering = forTask && job.taskId !== null;
    try {
      const row = await this.deps.db.artifact.findFirst({ where: { id: job.artifactId } });
      if (!row) {
        this.queuedEdits.delete(job.artifactId);
        return;
      }
      if (!row.html && job.mode === "create") await this.foldQueuedEdits(row.id);
      const current = row.html ? row : await this.deps.db.artifact.update({ where: { id: row.id }, data: { status: "failed" } });
      if (this.pendingFor(row.id) === 0) this.live.delete(row.id);
      // M21 (#9): an edit / refresh that gave up keeps the page (status ready) and says why in its
      // own status, until a later build saves a page. buildStatus still carries the reason (older apps).
      if (row.html && isWork(job.mode)) this.failures.set(row.id, { ...this.failures.get(row.id), [job.mode]: reason });
      await this.emit(current, reason, false);
      if (post && job.origin === "user") await this.line(job.userId, job.channelId, job.taskId, reason);
      if (push) this.notifyBuilt(job, current, false);
      // M14: a build the task started failed: the task says so and waits for the user.
      if (forTask && job.taskId) {
        delivering = false;
        await taskBuildOutcome(this.deps, { userId: job.userId, taskId: job.taskId, artifactId: row.id, ok: false, title: row.title, reason });
      }
    } finally {
      if (delivering && job.taskId) taskBuilds.delivered(job.taskId);
    }
  }

  /**
   * M29: one push when a build ends: notify.artifact_ready for one the user asked for (Create, ↻,
   * ✎, or make / edit / refresh_artifact in a turn), notify.artifact_failed for that or a scheduled
   * refresh (quiet). A scheduled refresh that saved isn't pushed; a task's build is reported by the
   * task's status. Rings unless a proactive turn asked for it (JobInput.quiet). Never throws.
   */
  private notifyBuilt(job: Job, row: ArtifactRow, ok: boolean): void {
    const { notify } = this.deps;
    if (!notify || job.taskId || (ok && job.origin !== "user")) return;
    void notify({
      userId: job.userId, channelId: job.channelId,
      body: { key: ok ? NOTIFY_ARTIFACT_READY : NOTIFY_ARTIFACT_FAILED, params: { title: textParam(row.title) } },
      route: `duet://artifacts/${encodeURIComponent(row.id)}`, collapseId: collapseIdFor.artifact(row.id),
      quiet: job.origin === "schedule" || job.quiet === true,
    }).catch((error: unknown) => log.warn("artifact notification failed", { artifactId: row.id, error: { name: (error as Error).name } }));
  }

  /**
   * M14: this job's build no longer counts as running for its task; true the first time only.
   * M18: `outcome` = the caller delivers taskBuildOutcome next (until then the task can't count as
   * done on its own).
   */
  private settleTask(job: Job, outcome = true): boolean {
    if (!job.taskId || job.taskSettled) return false;
    job.taskSettled = true;
    taskBuilds.settled(job.taskId, job.artifactId, outcome);
    return true;
  }

  /**
   * finish_build: reads the page back from the workspace, injects the base and stores it. A problem
   * the model can fix (wrong path, missing file, external URLs) is an error result, not a failure.
   */
  async finish(runId: string, args: FinishArgs, signal?: AbortSignal): Promise<FinishResult> {
    const job = this.jobs.get(runId);
    if (!job) return { ok: false, error: "There is no build in progress in this run." };
    const done = await this.contentLock.run(job.artifactId, () => this.finishUnlocked(runId, args, signal));
    if (done.ok && job.mode === "create") {
      const row = await this.deps.db.artifact.findUnique({ where: { id: job.artifactId } });
      if (row) await this.applyQueuedEdits(row, job);
    }
    return done;
  }

  private async finishUnlocked(runId: string, args: FinishArgs, signal?: AbortSignal): Promise<FinishResult> {
    const { db, workspace } = this.deps;
    const job = this.jobs.get(runId);
    if (!job || job.finished) return { ok: false, error: "There is no build in progress in this run." };
    job.shrank = false; // the last refusal decides why the build failed, if it ends here
    const expected = artifactPath(job.artifactId);
    if (workspaceRelative(args.path) !== expected) return { ok: false, error: `Write the page to /workspace/${expected} and pass that path.` };
    const row = await db.artifact.findFirst({ where: { id: job.artifactId, userId: job.userId } });
    if (!row) { this.close(job); return { ok: false, error: "This artifact was deleted while you were building it. Stop here." }; }
    const hasData = args.data !== undefined && args.data !== null;
    if (row.type !== "dashboard" && hasData) return { ok: false, error: "Only dashboards may pass data." };
    const dataOnly = job.mode === "refresh" && job.liveData === true;
    if (row.type === "dashboard" && (job.mode === "create" || dataOnly) && !hasData) return { ok: false, error: "Pass data: a JSON object with every number, row and label the dashboard shows." };
    const nextData = hasData ? checkedData(args.data, row.data ?? "") : null;
    if (nextData && !nextData.ok) return { ok: false, error: nextData.error };
    let page = "";
    if (!dataOnly) {
      let bytes: Uint8Array;
      try { bytes = await workspace.readFile(job.userId, expected, { maxBytes: MAX_HTML_BYTES, runId }); }
      catch { return { ok: false, error: `Couldn't read /workspace/${expected}. Write the file there first (at most 5 MB), then call finish_build again.` }; }
      if (bytes.byteLength > MAX_HTML_BYTES) return { ok: false, error: "The page is over 5 MB. Make it smaller before saving." };
      page = new TextDecoder().decode(bytes);
      const problem = checkHtml(page);
      if (problem) return { ok: false, error: problem };
    }
    const declared = args.sources ?? sourcesOf(row);
    const sourceCheck = job.evidence.check(declared);
    // A refresh must actually read at least one declared source this run. Unlike layout issues,
    // fabricated freshness never becomes acceptable on the third attempt. A page that declares no
    // source has nothing to read (its ↻ is a plain rebuild), so the check can't apply to it.
    if (job.mode === "refresh" && declared.length > 0 && sourceCheck.verified === 0) return { ok: false, error: "Not refreshed: no declared source was successfully read in this build. Read its sources with tools, then call finish_build again; do not change old numbers and claim they are fresh." };
    const quality = dataOnly ? { ok: true as const, warnings: [] } : job.quality.check(page, { type: row.type as ArtifactType, mode: job.mode, metrics: args.metrics ?? (job.mode === "create" ? [] : undefined) });
    if (!quality.ok) return { ok: false, error: quality.error };
    const refused = dataOnly ? null : await this.shrinkGuard(job, page);
    if (refused) return { ok: false, error: refused };
    const user = await db.user.findUnique({ where: { id: job.userId }, select: { language: true } });
    const title = dataOnly ? row.title : args.title?.trim() || row.title;
    let html = dataOnly ? row.html : withBase(page, { lang: user?.language === "zh-Hans" ? "zh-Hans" : "en", title });
    if (!dataOnly && job.mode !== "edit") html = stripChanged(html);
    const changed = job.mode === "edit" ? countChanged(html) : 0;
    const now = new Date(Math.max(this.now().getTime(), contentUpdatedAt(row).getTime() + 1));
    const data: Prisma.ArtifactUpdateInput = { html, title, status: "ready", updatedAt: dataOnly ? row.updatedAt : now };
    if (nextData?.ok && nextData.changed) Object.assign(data, { data: nextData.data, dataVersion: { increment: 1 }, dataUpdatedAt: now });
    if (args.sources) data.sources = JSON.stringify(args.sources);
    if (args.refreshSchedule) data.refreshSchedule = JSON.stringify(args.refreshSchedule);
    const { updated, metrics } = await db.$transaction(async tx => {
      signal?.throwIfAborted();
      const latest = await tx.artifactVersion.findFirst({ where: { artifactId: row.id }, orderBy: VERSION_ORDER });
      const metrics = args.metrics ?? (job.mode === "create" ? [] : versionMetrics(latest?.metrics ?? null));
      const updated = await tx.artifact.update({ where: { id: row.id }, data });
      await saveVersion(tx, updated, { by: job.versionBy ?? (job.origin === "schedule" ? "assistant" : job.startedBy), reason: job.mode,
        prompt: job.mode === "create" ? row.prompt : job.mode === "edit" ? job.edit ?? null : null,
        metrics: metrics === null ? null : JSON.stringify(metrics), now });
      // A stopped/timed-out finish must roll back the page and snapshot together.
      signal?.throwIfAborted();
      return { updated, metrics };
    });
    const warnings = [...quality.warnings, ...sourceCheck.warnings, ...metricWarnings(page, metrics ?? [], updated.type === "dashboard" && updated.data !== null ? JSON.parse(updated.data) : undefined)];
    this.close(job);
    // M21: a saved page clears what earlier edits / refreshes said went wrong.
    this.failures.delete(row.id);
    // M14: no longer building for its task (finish_task checks), from here on.
    const forTask = this.settleTask(job);
    if (changed > 0) this.glow.set(row.id, this.now().getTime() + GLOW_MS);
    else this.glow.delete(row.id);
    if (this.pendingFor(row.id) <= 1) this.live.delete(row.id);
    try {
      await this.emit(updated, null, false);
      if (job.mode === "create") await this.announce(job, updated, args.metrics ?? []);
      else {
        await this.syncCards(updated, args.metrics);
        // M21 (#46): an edit or refresh asked for in the chat says it's done there (the card it
        // updated may be far up). The viewer's ✎ / ↻ and the schedule post nothing; a task's build
        // is reported by the task's own carry-on turn.
        if (job.chat && !job.taskId) {
          const key = job.mode === "edit" ? EDITED_KEY : REFRESHED_KEY;
          await this.line(job.userId, job.channelId, null, { key, params: { title: { type: "text", value: updated.title } } });
        }
      }
      this.notifyBuilt(job, updated, true);
    } finally {
      // M14: built after its task already finished: the page becomes one of the task's resources;
      // built while it's open: the task's session carries on (M14a review #1). After the card is
      // posted, so the carry-on turn sees it in the task's thread.
      if (forTask && job.taskId) await taskBuildOutcome(this.deps, { userId: job.userId, taskId: job.taskId, artifactId: updated.id, ok: true, title: updated.title, artifactType: updated.type });
    }
    return { ok: true, data: { status: "ready", artifactId: updated.id, title: updated.title, warnings, ...(job.mode === "edit" ? { changedPassages: changed } : {}) } };
  }

  /**
   * M21 (#10): an edit or refresh whose new page lost much of the old one (page-edit.ts: under
   * half by markup and by text, old page at least 4,000 characters, edit_page deletions credited)
   * is refused: usually the page was read only in part and rewritten from that. The workspace gets
   * the page the build started from again, so reading it again gives the whole page. Returns the
   * error for the model, or null to save.
   */
  private async shrinkGuard(job: Job, page: string): Promise<string | null> {
    if (!isWork(job.mode) || job.original === undefined || !job.originalSize) return null;
    const next = pageSize(stripInjected(stripChanged(page)));
    if (!shrank(job.originalSize, next, job.cut)) return null;
    job.shrank = true;
    const path = artifactPath(job.artifactId);
    let restored = true;
    try {
      await this.deps.workspace.writeFile(job.userId, path, new TextEncoder().encode(job.original), { runId: job.runId ?? undefined });
      job.cut = { markup: 0, text: 0 };
    } catch (error) {
      restored = false;
      log.warn("shrunk page restore failed", { artifactId: job.artifactId, error: { name: (error as Error).name } });
    }
    const percent = Math.round(SHRINK_RATIO * 100);
    return [
      `Not saved: the new page is much shorter than the page you started from (${next.text} characters of text, ${next.markup} of HTML; it had ${job.originalSize.text} and ${job.originalSize.markup}; anything under ${percent}% is refused). Your read of the page was probably cut off, and rewriting it from that would lose the rest.`,
      restored ? `/workspace/${path} holds the page you started from again (any changes to it in this build were undone).` : "",
      "Read the page again and make the change with edit_page (old_string -> new_string) instead of rewriting the whole file; edit_page also removes sections when the request asks for that. Then call finish_build again.",
    ].filter(Boolean).join(" ");
  }

  /**
   * M21 (#10): edit_page in an edit or refresh build: replaces old_string with new_string in this
   * build's page in the workspace (exact match; unique unless replaceAll), so a small change
   * doesn't rewrite the page. Saving still goes through finish_build (and its shrink guard), which
   * credits what edit_page removed.
   */
  async editPage(runId: string, args: { oldString: string; newString: string; replaceAll: boolean }): Promise<FinishResult> {
    const job = this.jobs.get(runId);
    if (!job || job.finished || !isWork(job.mode) || this.dataOnly(runId)) return { ok: false, error: "edit_page only works while editing or refreshing an existing page, not a data-only refresh." };
    const path = artifactPath(job.artifactId);
    let current: string;
    try {
      current = new TextDecoder().decode(await this.deps.workspace.readFile(job.userId, path, { maxBytes: MAX_HTML_BYTES, runId }));
    } catch {
      return { ok: false, error: `Couldn't read /workspace/${path}. It should hold the page; write it there (at most 5 MB) before editing it.` };
    }
    const replaced = replaceText(current, args.oldString, args.newString, args.replaceAll);
    if (!replaced.ok) return { ok: false, error: replaced.error };
    if (new TextEncoder().encode(replaced.html).byteLength > MAX_HTML_BYTES) return { ok: false, error: "The page would be over 5 MB after this change; make it smaller." };
    try {
      await this.deps.workspace.writeFile(job.userId, path, new TextEncoder().encode(replaced.html), { runId });
    } catch (error) {
      log.warn("edit_page write failed", { artifactId: job.artifactId, error: { name: (error as Error).name } });
      return { ok: false, error: `Couldn't write /workspace/${path}; the page is unchanged. Try again.` };
    }
    const removed = removedBy(current, replaced.html);
    const cut = job.cut ?? { markup: 0, text: 0 };
    job.cut = { markup: cut.markup + removed.markup, text: cut.text + removed.text };
    return { ok: true, data: { status: "edited", path: `/workspace/${path}`, replacements: replaced.replacements, note: "Saved in the workspace. Make any other changes, then call finish_build with this path." } };
  }

  /** The finished artifact in the thread: "OpenDuet made a page." then the card. */
  private async announce(job: Job, row: ArtifactRow, metrics: Metric[]): Promise<void> {
    const type = row.type as ArtifactType;
    await this.line(job.userId, job.channelId, job.taskId, { key: MADE_KEY[type] ?? "system.made_page" });
    try {
      await postMessage(this.deps.db, this.deps.events, {
        userId: job.userId, channelId: job.channelId, taskId: job.taskId, role: "assistant", kind: "artifact", text: "",
        payload: { artifact: toSummary(row), metrics },
      });
    } catch (error) {
      log.warn("artifact card failed", { artifactId: row.id, error: { name: (error as Error).name } });
    }
  }

  /** Cards already in chat show the artifact as it is now (title, pin, updatedAt, metrics). */
  private async syncCards(row: ArtifactRow, metrics: Metric[] | null): Promise<void> {
    const { db, events } = this.deps;
    const cards = await db.message.findMany({ where: { userId: row.userId, kind: "artifact", payload: { contains: `"id":"${row.id}"` } }, orderBy: { createdAt: "desc" }, take: 20 });
    const artifact = toSummary(row);
    for (const card of cards) {
      const stored = storedPayload(card.payload);
      const current = ArtifactMessage.shape.payload.safeParse(stored);
      if (!current.success || current.data.artifact.id !== row.id) continue;
      await updatePayload(db, events, row.userId, card.id, "artifact", { artifact, metrics: metrics ?? current.data.metrics });
    }
  }

  /**
   * The `artifact` event; `live` keeps the build view's line for events that aren't build steps.
   * M21: every one carries the edit / refresh status as it is now (workStatus).
   */
  private async emit(row: ArtifactRow, buildStatus: Phrase | null, live: boolean): Promise<void> {
    if (live && buildStatus) this.live.set(row.id, buildStatus);
    await this.deps.events.emit(row.userId, row.channelId, "artifact", { artifact: toSummary(row), buildStatus, ...this.statuses(row.id) });
  }

  /** A change outside a build (rename, pin): the build view keeps its current line. */
  private async emitCurrent(row: ArtifactRow): Promise<void> {
    await this.deps.events.emit(row.userId, row.channelId, "artifact", { artifact: toSummary(row), buildStatus: this.live.get(row.id) ?? null, ...this.statuses(row.id) });
  }

  private statuses(id: string): { editStatus: ArtifactWorkStatus | null; refreshStatus: ArtifactWorkStatus | null } {
    return { editStatus: this.workStatus(id, "edit"), refreshStatus: this.workStatus(id, "refresh") };
  }

  /** A grey system line in the thread (a task's own session when taskId is set). */
  private async line(userId: string, channelId: string, taskId: string | null, phrase: Phrase): Promise<void> {
    try {
      await postMessage(this.deps.db, this.deps.events, { userId, channelId, taskId, role: "system", kind: "system", text: "", payload: { phrase } });
    } catch (error) {
      log.warn("artifact line failed", { channelId, error: { name: (error as Error).name } });
    }
  }

  /**
   * Scheduled refreshes (L151): every ready artifact with a refreshSchedule whose latest slot (in
   * the owner's timezone) is newer than its content gets one refresh per slot. A slot counts as
   * done once updatedAt passes it, so a restart never refreshes the same slot again; a refresh
   * that fails isn't retried until the next slot. Returns how many refreshes were queued.
   */
  tick(): Promise<number> {
    if (this.ticking) return this.ticking;
    const run = this.tickNow().finally(() => { this.ticking = null; });
    this.ticking = run;
    return run;
  }

  private async tickNow(): Promise<number> {
    if (!this.configured) return 0;
    const { db, usage } = this.deps;
    const rows = await db.artifact.findMany({ where: { status: "ready", refreshSchedule: { not: null } } });
    if (rows.length === 0) return 0;
    const owners = await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, timezone: true } });
    const zones = new Map(owners.map((u) => [u.id, u.timezone]));
    const now = this.now();
    let queued = 0;
    for (const row of rows) {
      const schedule = scheduleOf(row);
      const slot = schedule ? latestSlot(schedule, zones.get(row.userId) ?? "UTC", now) : null;
      if (!slot || contentUpdatedAt(row).getTime() >= slot.getTime()) continue;
      if (this.pendingFor(row.id) > 0 || this.claims.get(row.id) === slot.getTime()) continue;
      if (!(await this.usable(row.userId))) continue;
      this.claims.set(row.id, slot.getTime());
      if (usage && (await usage.state(row.userId)).limited) continue;
      try {
        await this.refresh(row.userId, row.id, "schedule");
        queued++;
      } catch (error) {
        log.warn("scheduled refresh failed", { artifactId: row.id, error: { name: (error as Error).name } });
      }
    }
    return queued;
  }

  /** The refresh tick; index.ts starts it after listen and stops it on shutdown. */
  start(intervalMs = TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * At startup, BEFORE runs.recoverStaleRuns(): first builds a previous process left running fail
   * with "interrupted" (nothing is building them any more). Refreshes and edits kept their page.
   */
  async recoverAfterRestart(): Promise<number> {
    const { db } = this.deps;
    const rows = await db.artifact.findMany({ where: { status: "building" } });
    for (const row of rows) {
      const failed = await db.artifact.update({ where: { id: row.id }, data: { status: row.html ? "ready" : "failed" } });
      await this.emit(failed, INTERRUPTED, false);
      await this.line(row.userId, row.channelId, null, INTERRUPTED);
    }
    return rows.length;
  }

  private async ensureUsage(userId: string): Promise<void> {
    if (this.deps.usage && (await this.deps.usage.state(userId)).limited) throw new HttpError(429, "usage_limited", "Usage limit reached.");
  }

  private async own(userId: string, id: string): Promise<ArtifactRow> {
    const row = await this.deps.db.artifact.findFirst({ where: { id, userId } });
    if (!row) throw notFound();
    return row;
  }
}
