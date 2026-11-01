// M12 routes: model providers (the key goes to the server's vault and never comes back), the
// remote model list, the user's models and the defaults (.pi/handoff/m12-contract.md). A refused
// check is 400 validation_failed with the server's reason; deleting the default model is 409.
// Creating or re-checking a provider waits on the provider (the server gives it 15 s).
import Foundation

extension APIClient {
    /// GET /api/models: providers, models, defaults and whether a usable default is set up.
    nonisolated func modelsState() async throws -> ModelsState { try await get("/api/models") }

    // MARK: - Providers

    nonisolated func createProvider(_ body: CreateModelProviderRequest) async throws -> ModelProvider {
        var request = try makeRequest("POST", "/api/providers", json: body)
        request.timeoutInterval = 45
        return try decode(ModelProviderResponse.self, from: try await send(request)).provider
    }

    nonisolated func updateProvider(id: String, _ body: UpdateModelProviderRequest) async throws -> ModelProvider {
        var request = try makeRequest("PATCH", "/api/providers/\(id.pathSegment)", json: body)
        request.timeoutInterval = 45
        return try decode(ModelProviderResponse.self, from: try await send(request)).provider
    }

    /// DELETE /api/providers/:id (204); 409 when it hosts the default and other chat models exist.
    nonisolated func deleteProvider(id: String) async throws {
        _ = try await send(try makeRequest("DELETE", "/api/providers/\(id.pathSegment)"))
    }

    /// POST /api/providers/:id/test: "Check again" (status and error stored, 200 either way).
    nonisolated func testProvider(id: String) async throws -> ModelProvider {
        let data = try await send(try makeRequest("POST", "/api/providers/\(id.pathSegment)/test", timeout: 45))
        return try decode(ModelProviderResponse.self, from: data).provider
    }

    /// GET /api/providers/:id/remote-models (400 with the reason when the provider can't be reached).
    nonisolated func remoteModels(providerId: String) async throws -> [RemoteModel] {
        let list: RemoteModelList = try await get("/api/providers/\(providerId.pathSegment)/remote-models", timeout: 45)
        return list.models
    }

    // MARK: - Models

    /// POST /api/models: one model by its id (409 when that provider already has it).
    nonisolated func addModel(_ body: CreateModelEntryRequest) async throws -> ModelEntry {
        let response: ModelEntryResponse = try await call("POST", "/api/models", json: body)
        return response.model
    }

    /// POST /api/models/batch: the remote picker's "Add N models" (ids already added are skipped).
    nonisolated func addModels(_ body: CreateModelEntriesRequest) async throws -> ModelsState {
        try await call("POST", "/api/models/batch", json: body)
    }

    nonisolated func updateModel(id: String, _ body: UpdateModelEntryRequest) async throws -> ModelEntry {
        let response: ModelEntryResponse = try await call("PATCH", "/api/models/\(id.pathSegment)", json: body)
        return response.model
    }

    /// DELETE /api/models/:id (204); 409 for the current default while other chat models exist.
    nonisolated func deleteModel(id: String) async throws {
        _ = try await send(try makeRequest("DELETE", "/api/models/\(id.pathSegment)"))
    }

    /// PUT /api/model-defaults (only the fields that change).
    nonisolated func updateModelDefaults(_ body: UpdateModelDefaultsRequest) async throws -> ModelsState {
        try await call("PUT", "/api/model-defaults", json: body)
    }
}
