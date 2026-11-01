import type { Handler } from "hono";
import type { AppEnv } from "../app.ts";
import { version } from "../../package.json";
import { ServerInfo } from "../contract/auth.ts";

export const serverInfo: Handler<AppEnv> = (c) => c.json(ServerInfo.parse({
  name: c.get("deps").config.SERVER_NAME, version, apiVersion: 1,
}));
