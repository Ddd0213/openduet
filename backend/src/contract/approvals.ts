// Approval cards. Nothing executes until the user taps; Approve executes exactly the stored
// arguments (which never leave the server) and must carry the version the card showed.
import { z } from "zod";
import { AppName, Id, IsoDate, Phrase } from "./common.ts";
import { ApprovalAlways, BrowserAction } from "./m20.ts";

export const ApprovalKind = z.enum(["email", "payment", "sign", "delete", "action"]);
export const ApprovalStatus = z.enum(["pending", "approved", "declined", "expired"]);

/** A labelled row on sign / delete / generic cards (never raw JSON). */
export const DetailRow = z.object({ label: z.string(), value: z.string() });

export const EmailPreview = z.object({
  kind: z.literal("email"),
  app: AppName, // "Gmail"
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  /** file chips that open the preview */
  attachments: z.array(z.object({ name: z.string(), mime: z.string(), fileId: Id.nullable() })),
});

export const PaymentPreview = z.object({
  kind: z.literal("payment"),
  /** minor units (cents); the app formats it in the user's locale */
  amount: z.number().int().nonnegative(),
  currency: z.string().length(3),
  merchant: z.string(),
  description: z.string(),
  testMode: z.boolean(),
});

export const SignPreview = z.object({
  kind: z.literal("sign"),
  app: AppName,
  title: z.string(),
  rows: z.array(DetailRow),
});

export const DeletePreview = z.object({
  kind: z.literal("delete"),
  app: AppName,
  title: z.string(),
  rows: z.array(DetailRow),
});

export const ActionPreview = z.object({
  kind: z.literal("action"),
  app: AppName,
  /** the tool's human name, e.g. "Create calendar event" */
  toolName: z.string(),
  rows: z.array(DetailRow),
  /**
   * M20: set on a browser approval (a consequential click in OpenDuet's browser): the site, the
   * button's real name and what it would do. Older apps show the card as a generic action.
   */
  browser: BrowserAction.nullable().default(null),
});

export const ApprovalPreview = z.discriminatedUnion("kind", [
  EmailPreview, PaymentPreview, SignPreview, DeletePreview, ActionPreview,
]);

export const Approval = z.object({
  id: Id,
  kind: ApprovalKind,
  status: ApprovalStatus,
  version: z.number().int().positive(),
  preview: ApprovalPreview,
  /** set for payments and spend requests only */
  expiresAt: IsoDate.nullable(),
  taskId: Id.nullable(),
  messageId: Id.nullable(),
  /** after Approve: what happened ("Sent", "Paid" ... chosen by the app from kind) */
  result: z
    .object({
      ok: z.boolean(),
      /** failure reason shown inline with Retry and Edit */
      error: Phrase.nullable(),
    })
    .nullable(),
  /** fields changed by the latest edit by chat; the card glows them for ~3 s */
  changedFields: z.array(z.string()),
  /**
   * M20: why this needs the user ("Why am I asked?"), e.g. browser clicks: "This button looks
   * like it places an order." Null on cards that explain themselves (email, payment ...).
   */
  why: Phrase.nullable().default(null),
  /**
   * M20: what an "Always" on this card would cover (one recipient, or one site + kind of click).
   * Null = the card offers no Always (see contract/m20.ts ApprovalAlways).
   */
  always: ApprovalAlways.nullable().default(null),
  updatedAt: IsoDate,
});
export type Approval = z.infer<typeof Approval>;

/**
 * POST /api/approvals/:id/approve and /decline. M20: Approve with `always: true` also stores an
 * Always rule for the card's `always` scope (400 validation_failed when the card has none, or
 * on decline).
 */
export const ApprovalDecisionRequest = z
  .object({ version: z.number().int().positive(), always: z.boolean().optional() })
  .strict();

/** 200 response of approve / decline. 409 { error: { code: "stale_version" } } carries no body beyond the error. */
export const ApprovalDecisionResponse = z.object({ approval: Approval });

/** A Link-style spend request card (request_payment with an item). Test mode: nothing is charged. */
export const SpendRequest = z.object({
  id: Id,
  approvalId: Id,
  amount: z.number().int().nonnegative(),
  currency: z.string().length(3),
  merchant: z.string(),
  description: z.string(),
  item: z.string(),
  expiresAt: IsoDate,
  status: ApprovalStatus,
  testMode: z.boolean(),
});
export type SpendRequest = z.infer<typeof SpendRequest>;
