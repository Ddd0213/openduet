// M17: GET /api/connector-templates (the MCP Registry as templates: featured first, then the
// registry's pages; search with ?query=, read on with ?cursor=) and POST /api/connector-templates/install.
// Session required like every /api route. The registry being down answers the cached copy, or 502
// `internal` "The MCP Registry couldn't be reached." when there's none.
import type { RegisterRoutes } from "../app.ts";
import { ConnectorTemplateList, ConnectorTemplateQuery, InstallTemplateRequest, InstallTemplateResponse } from "../contract/m17.ts";
import type { ConnectorService } from "../custom-connectors/service.ts";
import { HttpError, readJson } from "../http.ts";
import type { TemplateCatalog } from "./catalog.ts";
import { installTemplate } from "./install.ts";
import { inputsOf, RegistryError } from "./registry.ts";

export function connectorTemplateRoutes(service: ConnectorService, catalog: TemplateCatalog): RegisterRoutes {
  return (app) => {
    app.get("/api/connector-templates", async (c) => {
      const parsed = ConnectorTemplateQuery.safeParse({ query: c.req.query("query") || undefined, cursor: c.req.query("cursor") || undefined });
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path.join(".") || "query";
        throw new HttpError(400, "validation_failed", `${field}: ${parsed.error.issues[0]?.message ?? "invalid"}`, field);
      }
      let page;
      try {
        page = await catalog.list(parsed.data.query ?? "", parsed.data.cursor ?? "");
      } catch (error) {
        if (error instanceof RegistryError) throw new HttpError(502, "internal", "The MCP Registry couldn't be reached. Try again in a moment.");
        throw error;
      }
      const installed = await service.installed(c.get("user").id);
      return c.json(ConnectorTemplateList.parse({
        templates: page.templates.map((t) => ({
          name: t.name, title: t.title, description: t.description, website: t.website, iconUrl: t.iconUrl,
          remote: t.remote, inputs: inputsOf(t), needsSignIn: catalog.signInOf(t.name), installed: installed.has(t.name), featured: t.featured,
        })),
        nextCursor: page.nextCursor,
      }));
    });

    app.post("/api/connector-templates/install", async (c) => {
      const body = await readJson(c, InstallTemplateRequest);
      return c.json(InstallTemplateResponse.parse(await installTemplate(service, catalog, c.get("user").id, body)));
    });
  };
}
