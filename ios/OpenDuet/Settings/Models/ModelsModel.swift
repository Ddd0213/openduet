// M12: what the Models pages load through `\.apiClient` (GET /api/models: providers, models,
// defaults) and their writes. Pages call these; a write throws and the page shows the reason
// inline. Defaults change at once and roll back with the reason. Any change that can turn
// `configured` on or off calls `onChange` (the session refreshes Me, so features.models and the
// composer's "No model set up yet" follow).
import Foundation
import Observation

@MainActor @Observable
final class ModelsModel {
    private(set) var api: APIClient?
    var state = Loadable<ModelsState>()
    /// the Defaults card: a PUT in flight, and the reason of the last refusal
    private(set) var defaultsBusy = false
    private(set) var defaultsFailure: String?
    /// after a change: the session refreshes Me (features.models)
    @ObservationIgnored var onChange: () -> Void = {}

    init() {}

    func attach(_ api: APIClient?) {
        guard self.api == nil, let api else { return }
        self.api = api
    }

    var configured: Bool { state.value?.configured ?? false }

    func load() async {
        guard let api else {
            if state.value == nil { state.fail(String(localized: "Can't reach your server.")) }
            return
        }
        state.begin()
        do {
            state.finish(try await api.modelsState())
        } catch {
            if let reason = SettingsReason.line(for: error) { state.fail(reason) } else { state.loading = false }
        }
    }

    private func client() throws -> APIClient {
        guard let api else { throw APIError.unreachable }
        return api
    }

    /// Takes a fresh state; tells the session when `configured` flipped.
    private func take(_ next: ModelsState) {
        let was = state.value?.configured
        state.finish(next)
        if was != next.configured { onChange() }
    }

    /// After a write whose side effects only the server knows (counts, the default moving).
    private func reload() async {
        guard let api, let next = try? await api.modelsState() else { return }
        take(next)
    }

    private func change(_ edit: (inout ModelsState) -> Void) {
        guard var value = state.value else { return }
        edit(&value)
        state.finish(value)
    }

    // MARK: - Lookups

    func provider(_ id: String) -> ModelProvider? {
        state.value.flatMap { ModelCatalog.provider(id, in: $0) }
    }

    func model(_ id: String) -> ModelEntry? {
        state.value.flatMap { ModelCatalog.model(id, in: $0) }
    }

    func models(of providerId: String) -> [ModelEntry] {
        state.value?.models.filter { $0.providerId == providerId } ?? []
    }

    // MARK: - Providers

    /// POST /api/providers (the server checks the key first).
    func createProvider(_ body: CreateModelProviderRequest) async throws -> ModelProvider {
        let provider = try await client().createProvider(body)
        change { $0.providers.append(provider) }
        await reload()
        return provider
    }

    func updateProvider(_ id: String, _ body: UpdateModelProviderRequest) async throws {
        let provider = try await client().updateProvider(id: id, body)
        change { state in
            if let index = state.providers.firstIndex(where: { $0.id == id }) { state.providers[index] = provider }
        }
        await reload()
    }

    /// "Check again".
    func testProvider(_ id: String) async throws {
        let provider = try await client().testProvider(id: id)
        change { state in
            if let index = state.providers.firstIndex(where: { $0.id == id }) { state.providers[index] = provider }
        }
    }

    func deleteProvider(_ id: String) async throws {
        try await client().deleteProvider(id: id)
        change { state in
            state.providers.removeAll { $0.id == id }
            state.models.removeAll { $0.providerId == id }
        }
        await reload()
    }

    func remoteModels(_ providerId: String) async throws -> [RemoteModel] {
        try await client().remoteModels(providerId: providerId)
    }

    // MARK: - Models

    /// "Add N models": the answer is the whole state.
    func addModels(_ body: CreateModelEntriesRequest) async throws {
        take(try await client().addModels(body))
    }

    /// "Add by id".
    func addModel(_ body: CreateModelEntryRequest) async throws -> ModelEntry {
        let model = try await client().addModel(body)
        change { $0.models.append(model) }
        await reload()
        return model
    }

    func updateModel(_ id: String, _ body: UpdateModelEntryRequest) async throws {
        let model = try await client().updateModel(id: id, body)
        change { state in
            if let index = state.models.firstIndex(where: { $0.id == id }) { state.models[index] = model }
        }
        await reload()
    }

    func deleteModel(_ id: String) async throws {
        try await client().deleteModel(id: id)
        change { $0.models.removeAll { $0.id == id } }
        await reload()
    }

    // MARK: - Defaults

    /// The Defaults card: shown at once, PUT behind, put back with the reason.
    func setDefaults(_ body: UpdateModelDefaultsRequest) async {
        guard !defaultsBusy, let before = state.value else { return }
        var shown = before
        if let patch = body.defaultModelId { shown.defaults.defaultModelId = patch.value }
        if let patch = body.defaultThinking { shown.defaults.defaultThinking = patch.value }
        if let patch = body.utilityModelId { shown.defaults.utilityModelId = patch.value }
        state.finish(shown)
        defaultsBusy = true
        defaultsFailure = nil
        do {
            take(try await client().updateModelDefaults(body))
        } catch {
            if var now = state.value {
                now.defaults = before.defaults
                state.finish(now)
            }
            defaultsFailure = SettingsReason.line(for: error)
        }
        defaultsBusy = false
    }
}

/// The inline lines of the Models pages' refusals: a 409 has its own words here.
enum ModelsReason {
    static func isConflict(_ error: any Error) -> Bool {
        switch error as? APIError {
        case .server(let status, _)?: status == 409
        case .staleVersion?: true
        default: false
        }
    }

    /// Deleting a model or provider that holds the default.
    static func deleteLine(_ error: any Error) -> String? {
        isConflict(error) ? String(localized: "This is your default model. Choose another default model first.") : SettingsReason.line(for: error)
    }

    /// Adding a model by id that this provider already has.
    static func addLine(_ error: any Error) -> String? {
        isConflict(error) ? String(localized: "This model is already in your list.") : SettingsReason.line(for: error)
    }
}
