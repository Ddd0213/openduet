// HTTP helpers shared by every route: the ApiError shape and zod request validation.
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

export type ApiErrorCode =
  | "unauthorized"
  | "invalid_credentials"
  | "rate_limited"
  | "validation_failed"
  | "not_found"
  | "stale_version"
  | "expired"
  | "too_large"
  | "request_too_large"
  | "unsupported_type"
  | "not_configured"
  | "transcription_failed"
  | "usage_limited"
  /** M9: POST /api/tasks/:id/run while one of the routine's runs is queued or running */
  | "conflict"
  /** M20: PUT .../policy with Always for a tool on the safety floor or sent to other people */
  | "always_not_allowed"
  /** M20: POST /api/computer/sleep while the assistant is using the browser or the user is in control */
  | "computer_busy"
  /** M26: protected workspace originals and an unreachable computer during file deletion */
  | "protected_path" | "computer_unreachable"
  /** M22: POST /api/tasks/:id/retry (not_retryable, task_running) and /reopen (not_resolved) */
  | "not_retryable" | "task_running" | "not_resolved"
  /** M27 browser: a tab or navigate action while the assistant drives; a computer without tab routes */
  | "take_over_first" | "tabs_unsupported"
  | "internal";

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorBody(code: ApiErrorCode, message: string, field?: string) {
  return { error: field === undefined ? { code, message } : { code, message, field } };
}

export function errorResponse(c: Context, err: HttpError) {
  return c.json(errorBody(err.code, err.message, err.field), err.status);
}

/** Validates the JSON body against a contract schema; 400 validation_failed names the first bad field. */
export async function readJson<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "validation_failed", "Request body must be JSON.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = issue?.path.join(".") || undefined;
    throw new HttpError(400, "validation_failed", `${field ? `${field}: ` : ""}${issue?.message ?? "invalid"}`, field);
  }
  return r.data;
}
