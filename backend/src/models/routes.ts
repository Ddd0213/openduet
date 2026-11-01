// M12 routes (contract "Routes"): every one needs the session, another user's ids are 404, errors
// are the existing ApiError codes (validation_failed with `field`, not_found, conflict).
import type { RegisterRoutes } from "../app.ts";
import {
  CreateModelEntriesRequest, CreateModelEntryRequest, CreateModelProviderRequest, ModelEntryResponse, ModelProviderResponse,
  ModelsState, RemoteModelList, UpdateModelDefaultsRequest, UpdateModelEntryRequest, UpdateModelProviderRequest,
} from "../contract/m12.ts";
import { readJson } from "../http.ts";
import type { ModelService } from "./service.ts";

export function registerModelRoutes(service: ModelService): RegisterRoutes {
  return (app) => {
    /** The user, after the one-time import. */
    const userOf = async (c: { get(key: "user"): { id: string } }) => {
      const userId = c.get("user").id;
      await service.ready(userId);
      return userId;
    };
    const id = (c: { req: { param(name: string): string | undefined } }) => c.req.param("id") ?? "";

    app.get("/api/models", async (c) => c.json(ModelsState.parse(await service.state(await userOf(c)))));

    app.post("/api/providers", async (c) => {
      const userId = await userOf(c);
      const input = await readJson(c, CreateModelProviderRequest);
      return c.json(ModelProviderResponse.parse({ provider: await service.providers.create(userId, input) }));
    });
    app.patch("/api/providers/:id", async (c) => {
      const userId = await userOf(c);
      const input = await readJson(c, UpdateModelProviderRequest);
      return c.json(ModelProviderResponse.parse({ provider: await service.providers.update(userId, id(c), input) }));
    });
    app.delete("/api/providers/:id", async (c) => {
      await service.deletes.provider(await userOf(c), id(c));
      return c.body(null, 204);
    });
    app.post("/api/providers/:id/test", async (c) => c.json(ModelProviderResponse.parse({ provider: await service.providers.test(await userOf(c), id(c)) })));
    app.get("/api/providers/:id/remote-models", async (c) => c.json(RemoteModelList.parse(await service.providers.remote(await userOf(c), id(c)))));

    app.post("/api/models", async (c) => {
      const userId = await userOf(c);
      const input = await readJson(c, CreateModelEntryRequest);
      return c.json(ModelEntryResponse.parse({ model: await service.entries.add(userId, input) }));
    });
    app.post("/api/models/batch", async (c) => {
      const userId = await userOf(c);
      const input = await readJson(c, CreateModelEntriesRequest);
      await service.entries.addMany(userId, input);
      return c.json(ModelsState.parse(await service.state(userId)));
    });
    app.patch("/api/models/:id", async (c) => {
      const userId = await userOf(c);
      const input = await readJson(c, UpdateModelEntryRequest);
      return c.json(ModelEntryResponse.parse({ model: await service.entries.update(userId, id(c), input) }));
    });
    app.delete("/api/models/:id", async (c) => {
      await service.deletes.model(await userOf(c), id(c));
      return c.body(null, 204);
    });
    app.put("/api/model-defaults", async (c) => {
      const userId = await userOf(c);
      const input = await readJson(c, UpdateModelDefaultsRequest);
      await service.entries.putDefaults(userId, input);
      return c.json(ModelsState.parse(await service.state(userId)));
    });
  };
}
