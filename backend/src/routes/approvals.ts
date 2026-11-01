// POST /api/approvals/:id/approve and /decline (docs/API.md). Approve carries the version the card
// showed: 409 stale_version, 410 expired. Someone else's approval is 404. M20: approve with
// `always: true` also stores the card's Always rule (400 validation_failed when it has none);
// `always: true` on decline is a 400 validation_failed.
import type { Context } from "hono";
import type { AppEnv, RegisterRoutes } from "../app.ts";
import { ApprovalDecisionRequest, ApprovalDecisionResponse } from "../contract/approvals.ts";
import { Id } from "../contract/common.ts";
import { HttpError, readJson } from "../http.ts";
import type { ApprovalService } from "../approvals/service.ts";

function approvalId(c: Context<AppEnv>): string {
  const id = Id.safeParse(c.req.param("id"));
  if (!id.success) throw new HttpError(404, "not_found", "Not found.");
  return id.data;
}

export function approvalRoutes(service: ApprovalService): RegisterRoutes {
  return (app) => {
    app.post("/api/approvals/:id/approve", async (c) => {
      const id = approvalId(c);
      const { version, always } = await readJson(c, ApprovalDecisionRequest);
      return c.json(ApprovalDecisionResponse.parse({ approval: await service.approve(c.get("user").id, id, version, always === true) }));
    });
    app.post("/api/approvals/:id/decline", async (c) => {
      const id = approvalId(c);
      const { version, always } = await readJson(c, ApprovalDecisionRequest);
      if (always === true) throw new HttpError(400, "validation_failed", "always: only Approve can store an Always rule.", "always");
      return c.json(ApprovalDecisionResponse.parse({ approval: await service.decline(c.get("user").id, id, version) }));
    });
  };
}
