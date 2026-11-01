// AuditLog rows for OpenDuet's computer (L140): action, actor, target (a domain, a /workspace path or
// a program name) and outcome. Never typed values, file contents, secrets or full commands.
import type { Db } from "../db.ts";
import { log } from "../log.ts";

export type AuditActor = "assistant" | "user" | "system";
export type AuditOutcome = "ok" | "error" | "denied" | "needs_approval";

export interface AuditEntry {
  userId: string;
  action: string;
  actor: AuditActor;
  /** domain, workspace path or program name; never a secret */
  target?: string | null;
  outcome: AuditOutcome;
  runId?: string | null;
}

const TARGET_MAX = 300;

export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

export class Audit implements AuditSink {
  constructor(private readonly db: Db) {}

  /** Never throws: a failed audit write is logged (without the target) and the action goes on. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.db.auditLog.create({
        data: {
          userId: entry.userId, action: entry.action, actor: entry.actor, outcome: entry.outcome,
          target: (entry.target ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, TARGET_MAX),
          runId: entry.runId ?? null,
        },
      });
    } catch (error) {
      log.warn("audit write failed", { action: entry.action, error: { name: (error as Error)?.name ?? "Error" } });
    }
  }
}
