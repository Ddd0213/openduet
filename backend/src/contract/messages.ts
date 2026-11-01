// Chat messages. `kind` selects the bubble or card; `payload` carries its data.
// OpenDuet's text is markdown; inline task links are [title](duet://tasks/<id>) and
// artifact links [title](duet://artifacts/<id>). Date separators and the "New" divider
// are drawn by the app from createdAt and the channel's lastReadAt.
import { z } from "zod";
import { SpendRequest, Approval } from "./approvals.ts";
import { ArtifactSummary } from "./artifacts.ts";
import { ChannelFile } from "./channels.ts";
import { AppName, CardIcon, CardTint, Id, IsoDate, Phrase } from "./common.ts";
import { Forwarded, TaskResult } from "./m18.ts";
import { SignInOutcome, SignInStep } from "./m20.ts";
import { ActiveRun } from "./m21.ts";
import { SoulSetupField } from "./m22.ts";
import { BriefInfo } from "./m23.ts";
import { LineChartBlock } from "./m24.ts";
import { WorkspaceDeleteResult } from "./m26.ts";
import { TaskSummary } from "./tasks.ts";

export const Reaction = z.object({ emoji: z.string().min(1).max(16), by: z.enum(["user", "assistant"]) });

const Base = z.object({
  id: Id,
  channelId: Id,
  /** set when the message belongs to a task's own session */
  taskId: Id.nullable(),
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  /** user messages: "Delivered" (sent) / "Seen" */
  status: z.enum(["sent", "seen"]),
  clientId: z.string().nullable(),
  reactions: z.array(Reaction),
  /**
   * M10: OpenDuet's reply was cut short by Stop (POST /api/channels/:id/stop or /api/tasks/:id/stop);
   * the text streamed before the stop is kept as is. Every other message, and older payloads, false.
   */
  stopped: z.boolean().default(false),
  /**
   * M13: set on what a voice call handed to OpenDuet and on OpenDuet's reply bubbles in those turns.
   * Such messages are left out of the chat (list, task thread, unread, preview); the agent still
   * sees them. Every other message, and older payloads, null.
   */
  callId: Id.nullable().default(null),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});

const kind = <K extends string, P extends z.ZodTypeAny>(k: K, payload: P) =>
  Base.extend({ kind: z.literal(k), payload });

/** A quoted OpenDuet message (swipe right on a bubble): the excerpt is its text without markdown, first 160 chars. */
export const ReplyTo = z.object({ messageId: Id, role: z.enum(["user", "assistant"]), excerpt: z.string() });

export const TextMessage = kind(
  "text",
  z.object({
    /** the /skill the user invoked, if any */
    skill: z.string().nullable(),
    /** composer attachments; images render as image bubbles. M26: a deleted one stays, with deletedAt set */
    attachments: z.array(ChannelFile),
    /** the message this one quotes (user messages sent with replyTo); older payloads parse as null */
    replyTo: ReplyTo.nullable().default(null),
    /** M18: OpenDuet's bubble with a done task's final result (the text); null otherwise */
    taskResult: TaskResult.nullable().default(null),
    /** M18: a user message OpenDuet passed on from the chat into this task's thread (tell_task); null otherwise */
    forwarded: Forwarded.nullable().default(null),
    /** M23 (m23.ts BriefInfo): only on the morning brief's message (the sources it couldn't read); absent otherwise */
    brief: BriefInfo.optional(),
  }),
);
/**
 * A file card from OpenDuet's send_file(path, caption) (L180). M26: once the user deletes the file,
 * `file.deletedAt` is set (the "Deleted" card; the same kind, so older apps still decode it).
 */
export const FileMessage = kind("file", z.object({ file: ChannelFile, caption: z.string() }));
/** A screenshot or other image from OpenDuet. M26: deleted like a file card (`file.deletedAt`). */
export const ImageMessage = kind("image", z.object({ file: ChannelFile, caption: z.string() }));
/** The task spawn chip under the user's message, joined by a curved connector. */
export const TaskSpawnMessage = kind(
  "task_spawn",
  z.object({ task: TaskSummary, anchorMessageId: Id.nullable() }),
);
export const TaskSuggestionsMessage = kind(
  "task_suggestions",
  z.object({
    items: z.array(
      z.object({
        id: Id,
        title: z.string(),
        prompt: z.string(),
        app: AppName.nullable(),
        /** M9: the tile's icon OpenDuet picked; null (and older rows) = lightbulb */
        icon: CardIcon.nullable().default(null),
        /** set once tapped: the card dims and shows a green check */
        taskId: Id.nullable(),
        /** M23: the Up next row for the same item (one answer counts everywhere); null on older cards */
        suggestionId: Id.nullable().default(null),
      }),
    ),
  }),
);
export const ProactiveSuggestionMessage = kind(
  "proactive_suggestion",
  z.object({
    title: z.string(),
    body: z.string(),
    prompt: z.string(),
    state: z.enum(["open", "hidden", "started"]),
    taskId: Id.nullable(),
    /** M23: the Up next row for the same item: Start / Hide on either updates both; null on older cards */
    suggestionId: Id.nullable().default(null),
  }),
);
export const QuickRepliesMessage = kind(
  "quick_replies",
  z.object({ options: z.array(z.string().min(1)).min(1).max(6), chosen: z.string().nullable() }),
);
export const ApprovalMessage = kind("approval", z.object({ approval: Approval }));
export const SpendRequestMessage = kind("spend_request", z.object({ spendRequest: SpendRequest }));
export const ConfirmationMessage = kind(
  "confirmation",
  z.object({ title: z.string(), detail: z.string(), app: AppName.nullable() }),
);
/** "One thing needs you" single-action card (also human checks: action open_browser). */
export const AlertMessage = kind(
  "alert",
  z.object({
    title: Phrase,
    body: Phrase,
    action: z.object({
      label: Phrase,
      type: z.enum(["open_url", "open_browser", "open_connector", "open_usage"]),
      url: z.string().nullable(),
      toolkit: z.string().nullable(),
    }),
  }),
);
/** "Your plate today": a row per item with an outline action pill that sends the action. */
export const PlateMessage = kind(
  "plate",
  z.object({
    items: z.array(
      z.object({
        id: Id,
        title: z.string(),
        detail: z.string(),
        action: z.object({ label: z.string(), prompt: z.string() }),
        done: z.boolean(),
      }),
    ),
  }),
);
/** Centred grey system line: reminders, "Thanks for the feedback", model errors, "OpenDuet made a page." */
export const SystemMessage = kind("system", z.object({ phrase: Phrase }));
/** "⏱ Usage limit reached · resumes ..." + "Get more usage"; shows "Usage limit lifted" once usage is available. */
export const UsageLimitMessage = kind("usage_limit", z.object({ resumesAt: IsoDate }));
export const ArtifactMessage = kind(
  "artifact",
  z.object({
    artifact: ArtifactSummary,
    /** live preview, e.g. a 2x2 metric grid */
    metrics: z.array(z.object({ label: z.string(), value: z.number(), unit: z.string().nullable() })),
  }),
);
/** Live browser card while OpenDuet browses (tap opens "OpenDuet's computer"). */
export const LiveBrowserMessage = kind(
  "live_browser",
  z.object({ domain: z.string(), state: z.enum(["live", "ended"]) }),
);
/**
 * Sign-in card: the password goes straight to the computer, never to the model, DB or logs.
 * M20 (additive, see contract/m20.ts): `step` is the form a pending card shows (the code field
 * comes only after the site asks for one); `reason` why it failed; `outcome` how a card the user
 * took over or dismissed ended (state "expired" for older apps).
 */
export const SignInMessage = kind(
  "sign_in",
  z.object({
    requestId: Id,
    domain: z.string(),
    state: z.enum(["pending", "sent", "expired", "failed"]),
    step: SignInStep.default("credentials"),
    reason: Phrase.nullable().default(null),
    outcome: SignInOutcome.nullable().default(null),
  }),
);
export const SkillProposalMessage = kind(
  "skill_proposal",
  z.object({
    name: z.string(),
    description: z.string(),
    instructions: z.string(),
    state: z.enum(["open", "saved", "dismissed"]),
    skillId: Id.nullable(),
  }),
);

// ---------------------------------------------------------------- M9: cards OpenDuet writes
// Native components (A2UI-style): OpenDuet sends structured data from a fixed vocabulary and the
// app draws it in its own design system. Text in them is the model's, in the user's language.

export const FormOption = z.object({ id: Id, label: z.string().min(1).max(120), detail: z.string().max(200).nullable() });
/** One question. "single" / "multi" are chips; allowOther adds an "Other" chip with a text field. */
export const FormField = z.discriminatedUnion("type", [
  z.object({
    id: Id, type: z.literal("single"), label: z.string().min(1).max(300), required: z.boolean(),
    options: z.array(FormOption).min(2).max(8), allowOther: z.boolean(),
  }),
  z.object({
    id: Id, type: z.literal("multi"), label: z.string().min(1).max(300), required: z.boolean(),
    options: z.array(FormOption).min(2).max(10), allowOther: z.boolean(),
  }),
  z.object({
    id: Id, type: z.literal("text"), label: z.string().min(1).max(300), required: z.boolean(),
    placeholder: z.string().max(120).nullable(), multiline: z.boolean(),
  }),
]);
/** An answer: chosen option ids, plus the typed text ("Other" or a text field). */
export const FormAnswer = z.object({
  fieldId: Id,
  optionIds: z.array(Id).max(10),
  /** absent = null (Swift's Codable drops nil keys) */
  text: z.string().max(4000).nullable().default(null),
});
/** ask_form: a question card. Submitting sends one user message (SendMessageRequest.form). */
export const FormMessage = kind(
  "form",
  z.object({
    title: z.string().min(1).max(120),
    description: z.string().max(600).nullable(),
    icon: CardIcon,
    fields: z.array(FormField).min(1).max(8),
    submitLabel: z.string().max(40).nullable(),
    state: z.enum(["open", "submitted", "dismissed"]),
    /** "assistant" is present only when the assistant withdrew the open card; omitted means the user closed it. */
    closedBy: z.enum(["user", "assistant"]).optional(),
    /** set once submitted: the card collapses to these */
    answers: z.array(FormAnswer).nullable(),
  }),
);

/** show_card blocks: a bounded vocabulary the app draws natively. */
export const CardBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1).max(2000) }),
  z.object({
    type: z.literal("rows"),
    rows: z.array(z.object({ icon: CardIcon.nullable(), title: z.string().min(1).max(160), detail: z.string().max(300).nullable(), value: z.string().max(60).nullable() })).min(1).max(12),
  }),
  z.object({
    type: z.literal("metrics"),
    items: z.array(z.object({ label: z.string().min(1).max(60), value: z.string().min(1).max(40), delta: z.string().max(20).nullable(), trend: z.enum(["up", "down", "flat"]).nullable() })).min(1).max(6),
  }),
  z.object({ type: z.literal("progress"), label: z.string().min(1).max(120), value: z.number().min(0).max(1), detail: z.string().max(120).nullable() }),
  /**
   * M24: an item with an `id` (set by the server, unique in the card) can be checked off by the user:
   * POST /api/messages/:id/action {action: "check" | "uncheck", itemId}. Items without one (older
   * cards, a status list) are read-only. Older apps decode the block as before and draw it read-only.
   */
  z.object({
    type: z.literal("checklist"),
    items: z.array(z.object({ text: z.string().min(1).max(200), done: z.boolean(), id: Id.nullable().default(null) })).min(1).max(12),
  }),
  z.object({
    type: z.literal("bars"),
    items: z.array(z.object({ label: z.string().min(1).max(40), value: z.number().nonnegative() })).min(2).max(12),
    unit: z.string().max(20).nullable(),
  }),
  /**
   * M22: one group of rows with a count, built by the server from real data (show_tasks: "Needs
   * you 2", "Working 1", "Suggested 3", "Done 4 (last 7 days)"). `empty` is the one line shown when
   * the group has no rows. A row's `route` opens on tap: duet://tasks/<id>, or
   * duet://suggestions/<id> (an Up next suggestion: tapping starts it, POST /api/up-next/:id/add,
   * then opens the new task). Older apps skip the block (CardBlock.unsupported).
   */
  z.object({
    type: z.literal("group"),
    title: z.string().min(1).max(60),
    count: z.number().int().nonnegative(),
    empty: z.string().max(160).nullable(),
    rows: z.array(z.object({
      title: z.string().min(1).max(160),
      detail: z.string().max(300).nullable(),
      route: z.string().min(1).max(300).nullable(),
    })).max(5),
  }),
  /** M24 (m24.ts LineChartBlock): a trend, 1-3 series over 2-24 labels. Older apps skip the block. */
  LineChartBlock,
]);
/** A card button. "send" sends `value` as the user; "open_url" an https URL in the in-app Safari sheet; "open_route" a duet:// route. */
export const CardAction = z.object({
  label: z.string().min(1).max(40),
  type: z.enum(["send", "open_url", "open_route"]),
  value: z.string().min(1).max(2000),
  style: z.enum(["primary", "secondary"]),
});
/** show_card: an information card (summary, comparison, status, options to pick by tapping). */
export const CardMessage = kind(
  "card",
  z.object({
    icon: CardIcon,
    tint: CardTint,
    title: z.string().min(1).max(120),
    subtitle: z.string().max(200).nullable(),
    blocks: z.array(CardBlock).max(8),
    actions: z.array(CardAction).max(3),
  }),
);

/**
 * M11: the "Remembered · Undo" chip under OpenDuet's reply (remember / forget). Undo
 * (POST /api/messages/:id/action { action: "undo" }) archives a remembered fact or restores a
 * forgotten one; the chip turns `undone`.
 */
export const MemoryNoteMessage = kind(
  "memory_note",
  z.object({
    op: z.enum(["remembered", "forgot"]),
    factId: Id,
    text: z.string().max(2000),
    /** shared = "About you"; channel = this channel's own memory */
    scope: z.enum(["shared", "channel"]),
    state: z.enum(["done", "undone"]),
  }),
);
/**
 * M11: propose_soul_change: OpenDuet never changes the soul quietly. "Apply"
 * (action "apply") writes `proposed` into the field; "Not now" (action "dismiss") leaves it.
 * `field` soulExtra is this channel's addendum.
 */
export const SoulProposalMessage = kind(
  "soul_proposal",
  z.object({
    field: z.enum(["name", "addressAs", "identity", "persona", "tone", "soulExtra"]),
    current: z.string().max(4000),
    proposed: z.string().max(4000),
    reason: z.string().max(500),
    state: z.enum(["open", "applied", "dismissed"]),
  }),
);
/**
 * M22: propose_soul_setup, the end of setting up "who OpenDuet is" in the chat (m22.ts
 * SoulSetupField): every field the user chose, read back as "now → new". "Apply" (action "apply")
 * writes them all at once (PUT /api/soul semantics); "Not now" (action "dismiss") changes nothing.
 * Asking for a change in the chat afterwards posts a new card and turns this one `superseded`.
 */
export const SoulSetupMessage = kind(
  "soul_setup",
  z.object({
    fields: z.array(SoulSetupField).min(1).max(5),
    reason: z.string().max(500),
    state: z.enum(["open", "applied", "dismissed", "superseded"]),
  }),
);
/**
 * M11: request_connection / request_secret. The app shows a form; what the user types goes to
 * POST /api/messages/:id/connect (into the vault), never into the chat or the model's context.
 * `app`: a Composio app; the card's Connect button uses the existing OAuth flow
 * (POST /api/connectors/:toolkit/connect) and the server marks the card connected once the account
 * is active. "Not now" = action "dismiss".
 */
export const ConnectionRequestMessage = kind(
  "connection_request",
  z.object({
    type: z.enum(["mcp", "api_key", "app"]),
    name: AppName,
    /** why OpenDuet asks, shown on the card */
    purpose: z.string().max(500),
    /** mcp: the server URL; api_key: null */
    url: z.string().max(2000).nullable(),
    /** api_key: the bound domain; mcp: null */
    domain: z.string().max(253).nullable(),
    /** app: the Composio toolkit slug */
    toolkit: z.string().nullable(),
    /** api_key: the header for the key and its prefix */
    headerName: z.string().nullable(),
    valuePrefix: z.string().nullable(),
    /** what the user fills in. api_key: one secret field "key"; mcp: one per header */
    fields: z.array(z.object({
      key: z.string().min(1).max(64),
      label: z.string().min(1).max(80),
      secret: z.boolean(),
      placeholder: z.string().max(120).nullable(),
    })).max(10),
    state: z.enum(["open", "connected", "dismissed"]),
    /** "assistant" is present only when the assistant withdrew the open card; omitted means the user closed it. */
    closedBy: z.enum(["user", "assistant"]).optional(),
    /** set once connected */
    connectorId: Id.nullable(),
  }),
);

/**
 * M12: a turn that failed (the model refused, timed out, the key was refused, no model set up).
 * Replaces the grey system line. "Retry" (action "retry", optional modelId = "Switch model")
 * resubmits the same turn; "dismiss" hides the buttons. retry false: nothing to retry with
 * (system.no_model: the app offers "Set up models" instead).
 */
export const ModelErrorMessage = kind(
  "model_error",
  z.object({
    phrase: Phrase,
    /** the ModelEntry that failed (null when none was usable) */
    modelId: Id.nullable(),
    modelLabel: z.string().nullable(),
    runId: Id,
    retry: z.boolean(),
    state: z.enum(["open", "retrying", "dismissed"]),
  }),
);

/** M13: a voice call's one line in the chat ("Voice call · 3 min"); tapping opens GET /api/calls/:id. */
export const CallMessage = kind(
  "call",
  z.object({
    callId: Id,
    seconds: z.number().int().min(0),
    /** a few words in the user's language; "" when there was nothing to name */
    title: z.string(),
    lineCount: z.number().int().min(0),
  }),
);

export const Message = z.discriminatedUnion("kind", [
  TextMessage, FileMessage, ImageMessage, TaskSpawnMessage, TaskSuggestionsMessage,
  ProactiveSuggestionMessage, QuickRepliesMessage, ApprovalMessage, SpendRequestMessage,
  ConfirmationMessage, AlertMessage, PlateMessage, SystemMessage, UsageLimitMessage,
  ArtifactMessage, LiveBrowserMessage, SignInMessage, SkillProposalMessage,
  FormMessage, CardMessage,
  MemoryNoteMessage, SoulProposalMessage, ConnectionRequestMessage,
  ModelErrorMessage, CallMessage, SoulSetupMessage,
]);
export type Message = z.infer<typeof Message>;
export const MESSAGE_KINDS = Message.options.map((o) => o.shape.kind.value);

/** GET /api/channels/:id/messages?before=<messageId>&limit=50 (oldest first within the page). */
export const MessagePage = z.object({
  messages: z.array(Message),
  hasMore: z.boolean(),
  /** M21 (m21.ts ActiveRun): the turn running in this thread now (also on Channel); null when none */
  activeRun: ActiveRun.nullable().default(null),
});

/** POST /api/channels/:id/messages and POST /api/tasks/:id/messages (answers with SSE). */
export const SendMessageRequest = z
  .object({
    text: z.string().max(32000),
    clientId: z.string().min(1).max(64),
    /** ids from POST /api/channels/:id/files, uploaded before sending */
    fileIds: z.array(Id).max(10).default([]),
    skill: z.string().max(64).nullable().default(null),
    /** tapping a quick-reply chip */
    quickReply: z.object({ messageId: Id, option: z.string() }).nullable().default(null),
    /** quote reply: one of OpenDuet's messages in the same thread (else 400 validation_failed, field replyTo) */
    replyTo: Id.nullable().default(null),
    /**
     * M9: submitting a form card. `text` is the app's readable summary (one "label: answer" line
     * per question), stored as the user's message; the answers are checked against the card's
     * fields (400 validation_failed, field form) and the card turns "submitted". 409 stale_version
     * when the card isn't open any more.
     */
    form: z.object({ messageId: Id, answers: z.array(FormAnswer).min(1).max(8) }).nullable().default(null),
  })
  .strict()
  .refine((m) => m.text.trim().length > 0 || m.fileIds.length > 0, { message: "empty message" });

/** POST /api/messages/:id/action: card buttons (Start / Hide a suggestion, Save skill / Not now ...). */
export const MessageActionRequest = z
  .object({
    /**
     * M11: "apply" on a soul_proposal, "undo" on a memory_note, "dismiss" also on connection_request.
     * M22: "apply" / "dismiss" on a soul_setup
     * M12: "retry" on a model_error card
     * M24: "check" / "uncheck" on a card's checklist item (itemId = the item's id); sets done, so a repeat is harmless
     */
    action: z.enum(["start", "hide", "save_skill", "dismiss", "done", "apply", "undo", "retry", "check", "uncheck"]),
    /** item id inside task_suggestions / plate cards / a card's checklist (M9: "dismiss" on a form card skips it) */
    itemId: Id.nullable().default(null),
    /** M12: retry on this model instead ("Switch model"); ModelEntry.id */
    modelId: Id.optional(),
  })
  .strict();
export const MessageActionResponse = z.object({ message: Message });

/** PUT / DELETE /api/messages/:id/reactions/:emoji -> the updated message */
export const ReactionResponse = z.object({ message: Message });

/** POST /api/feedback (Good / Bad response, or "Send feedback" in the profile sheet). */
export const FeedbackRequest = z
  .object({
    messageId: Id.nullable().default(null),
    rating: z.enum(["good", "bad"]).nullable().default(null),
    text: z.string().max(4000).default(""),
  })
  .strict();

/**
 * M10: POST /api/channels/:id/stop (the channel's own chat turn) and POST /api/tasks/:id/stop (the
 * task's own session) -> how many turns were stopped. 409 conflict when none is running or queued.
 */
export const StopResponse = z.object({ stopped: z.number().int().nonnegative() });

/** POST /api/channels/:id/files (multipart "file") */
export const UploadFileResponse = z.object({ file: ChannelFile });

/**
 * M26: DELETE /api/files/:id (m26.ts DeleteFileRequest / DeleteFileQuery) -> 200. `file` is the
 * deleted file (deletedAt set; taskTitle / artifactId filled in). `message` is the card or text
 * message it was in, as it now reads (the file shown as deleted; the same `message` event goes to the
 * channel), or null for an upload never sent (that row is gone). `workspace` says what became of
 * the original in /workspace. Before M26 this answered 204, and only for uploads never sent.
 */
export const DeleteFileResponse = z.object({
  file: ChannelFile,
  message: Message.nullable(),
  workspace: WorkspaceDeleteResult,
});
export type DeleteFileResponse = z.infer<typeof DeleteFileResponse>;
