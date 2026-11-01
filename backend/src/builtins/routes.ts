import type { RegisterRoutes } from "../app.ts";
import { BuiltinConnectorList } from "../contract/m25.ts";
import type { BuiltinConfig } from "./config.ts";
import { connectorList } from "./state.ts";

/** Registered after createApp's /api/* authentication middleware. No probes, URLs or keys. */
export function registerBuiltinRoutes(config: BuiltinConfig): RegisterRoutes {
  return app => { app.get("/api/builtin-connectors", c => c.json(BuiltinConnectorList.parse(connectorList(config)))); };
}
