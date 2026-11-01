// /api/custom-connectors (M11, Everything > Connectors > "Add connector") and the connection card's
// POST /api/messages/:id/connect. Secrets go in, never out: answers carry only SecretInfo (set +
// last 4). Another user's connector or card is 404.
// M17: POST /api/custom-connectors/import (a pasted mcpServers config), the OAuth sign-in
// (POST .../:id/oauth/start, POST .../:id/oauth/finish, DELETE .../:id/oauth) and the connector
// templates (connector-templates/routes.ts, one catalog and its caches per server).
import type { Context } from "hono";
import type { AppEnv, RegisterRoutes } from "../app.ts";
import { UpdatePolicyRequest } from "../contract/connectors.ts";
import { ConnectRequestSubmit, CreateCustomConnectorRequest, CustomConnectorList, CustomConnectorResponse, UpdateCustomConnectorRequest } from "../contract/m11.ts";
import { ImportConnectorsRequest, ImportConnectorsResponse, OAuthFinishRequest, OAuthStartResponse } from "../contract/m17.ts";
import { MessageActionResponse } from "../contract/messages.ts";
import { TemplateCatalog } from "../connector-templates/catalog.ts";
import { connectorTemplateRoutes } from "../connector-templates/routes.ts";
import { HttpError, readJson } from "../http.ts";
import type { ConnectionCards } from "./cards.ts";
import { importConfig } from "./import.ts";
import { CALLBACK_SCHEME, REDIRECT_URI } from "./oauth.ts";
import type { ConnectorService } from "./service.ts";

const idOf = (c: Context<AppEnv>) => {
  const id = c.req.param("id");
  if (!id) throw new HttpError(404, "not_found", "Not found.");
  return id;
};

export function customConnectorRoutes(service: ConnectorService, cards: ConnectionCards, catalog = new TemplateCatalog({ net: service.net })): RegisterRoutes {
  const templates = connectorTemplateRoutes(service, catalog);
  return (app) => {
    templates(app);

    app.get("/api/custom-connectors", async (c) => c.json(CustomConnectorList.parse({ connectors: await service.list(c.get("user").id) })));

    app.post("/api/custom-connectors", async (c) => {
      const body = await readJson(c, CreateCustomConnectorRequest);
      return c.json(CustomConnectorResponse.parse({ connector: await service.create(c.get("user").id, body) }));
    });

    app.patch("/api/custom-connectors/:id", async (c) => {
      const id = idOf(c);
      const body = await readJson(c, UpdateCustomConnectorRequest);
      return c.json(CustomConnectorResponse.parse({ connector: await service.update(c.get("user").id, id, body) }));
    });

    app.delete("/api/custom-connectors/:id", async (c) => {
      await service.remove(c.get("user").id, idOf(c));
      return c.body(null, 204);
    });

    app.post("/api/custom-connectors/import", async (c) => {
      const body = await readJson(c, ImportConnectorsRequest);
      return c.json(ImportConnectorsResponse.parse(await importConfig(service, c.get("user").id, body.json)));
    });

    app.post("/api/custom-connectors/:id/oauth/start", async (c) => {
      const started = await service.oauthStart(c.get("user").id, idOf(c));
      c.header("Cache-Control", "no-store");
      return c.json(OAuthStartResponse.parse({ authorizeUrl: started.authorizeUrl, callbackScheme: CALLBACK_SCHEME, redirectUri: REDIRECT_URI, expiresAt: started.expiresAt.toISOString() }));
    });

    app.post("/api/custom-connectors/:id/oauth/finish", async (c) => {
      const id = idOf(c);
      const body = await readJson(c, OAuthFinishRequest);
      c.header("Cache-Control", "no-store");
      return c.json(CustomConnectorResponse.parse({ connector: await service.oauthFinish(c.get("user").id, id, body) }));
    });

    app.delete("/api/custom-connectors/:id/oauth", async (c) => c.json(CustomConnectorResponse.parse({ connector: await service.oauthDisconnect(c.get("user").id, idOf(c)) })));

    app.post("/api/custom-connectors/:id/test", async (c) => c.json(CustomConnectorResponse.parse({ connector: await service.test(c.get("user").id, idOf(c)) })));

    app.put("/api/custom-connectors/:id/policy", async (c) => {
      const id = idOf(c);
      const body = await readJson(c, UpdatePolicyRequest);
      return c.json(CustomConnectorResponse.parse({ connector: await service.setPolicy(c.get("user").id, id, body.tool, body.mode) }));
    });

    app.post("/api/messages/:id/connect", async (c) => {
      const id = idOf(c);
      const body = await readJson(c, ConnectRequestSubmit);
      return c.json(MessageActionResponse.parse({ message: await cards.submit(c.get("user").id, id, body) }));
    });
  };
}
