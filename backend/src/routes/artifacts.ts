// /api/artifacts* (L151): list, create (queues a build; progress as `artifact` events), detail, the
// page itself (text/html with a CSP that keeps it off the network and the backend API), PATCH
// (title, tab bar, refresh schedule), DELETE, ↻ refresh and ✎ edit. Only the user's own artifacts.
import type { Context } from "hono";
import type { AppEnv, RegisterRoutes } from "../app.ts";
import { ArtifactList, ArtifactResponse, CreateArtifactRequest, EditArtifactRequest, UpdateArtifactRequest } from "../contract/artifacts.ts";
import { ArtifactVersionList, RestoreArtifactRequest } from "../contract/m24.ts";
import { ArtifactDataResponse } from "../contract/m27.ts";
import { HttpError, readJson } from "../http.ts";
import { ARTIFACT_CSP } from "../make/base.ts";
import type { ArtifactService } from "../artifacts/service.ts";

/** The response header adds what a meta CSP can't: sandboxing (an opaque origin) and no framing. */
export const HTML_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": `${ARTIFACT_CSP}; frame-ancestors 'none'; sandbox allow-scripts allow-popups`,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "private, no-store",
};

const param = (c: Context<AppEnv>) => {
  const id = c.req.param("id");
  if (!id) throw new HttpError(404, "not_found", "Not found.");
  return id;
};

export function registerArtifactRoutes(service: ArtifactService): RegisterRoutes {
  return (app) => {
    app.get("/api/artifacts", async (c) => c.json(ArtifactList.parse({ artifacts: await service.list(c.get("user").id) })));

    app.post("/api/artifacts", async (c) => {
      const body = await readJson(c, CreateArtifactRequest);
      const artifact = await service.create({ userId: c.get("user").id, ...body });
      return c.json(ArtifactResponse.parse({ artifact }));
    });

    app.get("/api/artifacts/:id", async (c) => c.json(await service.detail(c.get("user").id, param(c))));

    app.get("/api/artifacts/:id/versions", async (c) => c.json(ArtifactVersionList.parse({ versions: await service.versions(c.get("user").id, param(c)) })));

    app.get("/api/artifacts/:id/data", async (c) => c.json(ArtifactDataResponse.parse(await service.data(c.get("user").id, param(c)))));

    app.post("/api/artifacts/:id/restore", async (c) => {
      const { versionId } = await readJson(c, RestoreArtifactRequest);
      return c.json(ArtifactResponse.parse({ artifact: await service.restore(c.get("user").id, param(c), versionId) }));
    });

    app.get("/api/artifacts/:id/html", async (c) => {
      const html = await service.html(c.get("user").id, param(c));
      return c.body(html, 200, HTML_HEADERS);
    });

    app.patch("/api/artifacts/:id", async (c) => {
      const body = await readJson(c, UpdateArtifactRequest);
      return c.json(ArtifactResponse.parse({ artifact: await service.update(c.get("user").id, param(c), body) }));
    });

    app.delete("/api/artifacts/:id", async (c) => {
      await service.remove(c.get("user").id, param(c));
      return c.body(null, 204);
    });

    app.post("/api/artifacts/:id/refresh", async (c) => c.json(ArtifactResponse.parse({ artifact: await service.refresh(c.get("user").id, param(c)) })));

    app.post("/api/artifacts/:id/edit", async (c) => {
      const { prompt } = await readJson(c, EditArtifactRequest);
      return c.json(ArtifactResponse.parse({ artifact: await service.edit({ userId: c.get("user").id, id: param(c), prompt }) }));
    });
  };
}
