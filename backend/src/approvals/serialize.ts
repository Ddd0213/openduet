// Approval / SpendRequest rows -> contract shapes. Stored arguments never leave the server.
import type { Approval as ApprovalRow, SpendRequest as SpendRow } from "@prisma/client";
import { z } from "zod";
import { Approval, SpendRequest } from "../contract/approvals.ts";
import { Phrase } from "../contract/common.ts";
import { ApprovalAlways } from "../contract/m20.ts";
import { minorDigits } from "./money.ts";

const Args = z.record(z.string(), z.unknown());
const Fields = z.array(z.string());

const json = (text: string | null): unknown => {
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return undefined; }
};

export function toApproval(row: ApprovalRow): Approval {
  return Approval.parse({
    id: row.id, kind: row.kind, status: row.status, version: row.version, preview: json(row.preview),
    expiresAt: row.expiresAt?.toISOString() ?? null, taskId: row.taskId, messageId: row.messageId,
    result: json(row.result), changedFields: Fields.catch([]).parse(json(row.changedFields)),
    // M20: written when the card is made; an unreadable value shows no reason / no Always row.
    why: Phrase.nullable().catch(null).parse(json(row.why)),
    always: ApprovalAlways.nullable().catch(null).parse(json(row.always)),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function storedArgs(row: ApprovalRow): Record<string, unknown> {
  return Args.parse(json(row.arguments));
}

export function toSpendRequest(row: SpendRow): SpendRequest {
  if (!row.approvalId) throw new Error("spend request without an approval");
  return SpendRequest.parse({
    id: row.id, approvalId: row.approvalId, amount: row.amount, currency: row.currency, merchant: row.merchant,
    description: row.description, item: row.item, expiresAt: row.expiresAt.toISOString(), status: row.status, testMode: true,
  });
}

/** One line for the model and the task runner (English, model-facing; the app never shows it). */
export function summarize(approval: Approval): string {
  const p = approval.preview;
  switch (p.kind) {
    case "email": return `${p.app} · Email to ${p.to.join(", ")}${p.subject ? `: ${p.subject}` : ""}`;
    case "payment": {
      const digits = minorDigits(p.currency);
      return `Payment of ${(p.amount / 10 ** digits).toFixed(digits)} ${p.currency} to ${p.merchant}${p.testMode ? " (test mode, nothing charged)" : ""}`;
    }
    case "sign": return `${p.app} · Signature request: ${p.title}`;
    case "delete": return `${p.app} · Delete: ${p.title}`;
    case "action": {
      const first = p.rows[0];
      return `${p.app} · ${p.toolName}${first ? `: ${first.label} ${first.value}` : ""}`.slice(0, 300);
    }
  }
}
