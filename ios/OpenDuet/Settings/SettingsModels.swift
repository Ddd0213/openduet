// M11: one memory layer's editor data (About you, or a channel's own memory), and what a
// channel's OpenDuet sheet loads and changes (what it can use, "Use About you", the soul addendum).
// Both load through `\.apiClient`; previews pass a fixed state and no client.
import Foundation
import Observation

@MainActor @Observable
final class MemoryLayerModel {
    enum Layer: Hashable, Sendable {
        case aboutYou
        case channel(String)

        /// POST /api/memory/facts channelId (nil = About you)
        var channelId: String? {
            if case .channel(let id) = self { id } else { nil }
        }
    }

    let layer: Layer
    private(set) var api: APIClient?
    var state = Loadable<MemoryLayerState>()

    init(layer: Layer, state: MemoryLayerState? = nil) {
        self.layer = layer
        if let state { self.state.finish(state) }
    }

    func attach(_ api: APIClient?) {
        guard self.api == nil, let api else { return }
        self.api = api
    }

    /// Profile > Memory: the store loaded the document; its facts come along.
    func seed(_ memory: MemoryState) {
        state.finish(MemoryLayerState(memory))
    }

    func load() async {
        guard let api else {
            if state.value == nil { state.fail(String(localized: "Can't reach your server.")) }
            return
        }
        state.begin()
        do {
            switch layer {
            case .aboutYou: state.finish(MemoryLayerState(try await api.memory()))
            case .channel(let id): state.finish(MemoryLayerState(try await api.channelMemory(channelId: id)))
            }
        } catch {
            if let reason = SettingsReason.line(for: error) { state.fail(reason) } else { state.loading = false }
        }
    }

    private func client() throws -> APIClient {
        guard let api else { throw APIError.unreachable }
        return api
    }

    func saveDocument(_ document: String) async throws {
        switch layer {
        case .aboutYou: state.finish(MemoryLayerState(try await client().saveMemory(document)))
        case .channel(let id): state.finish(MemoryLayerState(try await client().updateChannelMemory(channelId: id, document: document)))
        }
    }

    func addFact(_ text: String) async throws {
        let fact = try await client().addMemoryFact(CreateMemoryFactRequest(channelId: layer.channelId, text: text))
        mutate { $0.facts = FactList.upsert(fact, into: $0.facts) }
    }

    func editFact(_ id: String, text: String) async throws {
        let fact = try await client().updateMemoryFact(id: id, text: text)
        mutate { $0.facts = FactList.upsert(fact, into: $0.facts) }
    }

    /// DELETE archives it (the assistant never sees it again).
    func forgetFact(_ id: String) async throws {
        try await client().forgetMemoryFact(id: id)
        mutate { $0.facts = FactList.remove(id, from: $0.facts) }
    }

    private func mutate(_ change: (inout MemoryLayerState) -> Void) {
        guard var value = state.value else { return }
        change(&value)
        state.finish(value)
    }
}

/// A channel's OpenDuet sheet: what it can use (optimistic switches), its own memory, "Use About
/// you" and "Here, OpenDuet also…". Kept per channel (the sheet has `.id(channel.id)`).
@MainActor @Observable
final class ChannelSettingsModel {
    let channelId: String
    private(set) var api: APIClient?
    var access = Loadable<AccessToggles>()
    let memory: MemoryLayerModel
    /// shown at once; the PATCH runs behind it and a failure puts it back
    var useSharedMemory: Bool
    var sharedBusy = false
    var sharedFailure: String?
    /// the saved addendum (the editor compares its draft with it)
    var soulExtra: String
    /// M12: the models the Model row offers (GET /api/models) and the channel's own choice
    var models = Loadable<ModelsState>()
    private(set) var modelChoice: ChannelModelChoice

    init(channel: Channel, memory: MemoryLayerState? = nil, access: ChannelAccess? = nil) {
        channelId = channel.id
        useSharedMemory = channel.useSharedMemory
        soulExtra = channel.soulExtra
        modelChoice = ChannelModelChoice(modelId: channel.modelId, thinking: channel.thinkingLevel)
        self.memory = MemoryLayerModel(layer: .channel(channel.id), state: memory)
        if let access { self.access.finish(AccessToggles(access)) }
    }

    func attach(_ api: APIClient?) {
        guard self.api == nil, let api else { return }
        self.api = api
        memory.attach(api)
    }

    /// A newer copy of the channel (a `channel` event): taken unless a change of ours is running.
    func sync(_ channel: Channel) {
        if !sharedBusy { useSharedMemory = channel.useSharedMemory }
        soulExtra = channel.soulExtra
        modelChoice.sync(modelId: channel.modelId, thinking: channel.thinkingLevel)
    }

    func refresh() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.loadAccess() }
            group.addTask { await self.memory.load() }
            group.addTask { await self.loadModels() }
        }
    }

    func loadAccess() async {
        guard let api else {
            if access.value == nil { access.fail(String(localized: "Can't reach your server.")) }
            return
        }
        access.begin()
        do {
            access.finish(AccessToggles(try await api.channelAccess(channelId: channelId)))
        } catch {
            if let reason = SettingsReason.line(for: error) { access.fail(reason) } else { access.loading = false }
        }
    }

    /// A skill / connector / app switch: shown at once, rolled back with the reason on failure.
    func toggle(_ item: ChannelAccess.Item, on: Bool) {
        guard let api, let body = access.value?.begin(item, on: on) else { return }
        let ref = item.ref
        Task {
            do {
                let answer = try await api.updateChannelAccess(channelId: channelId, body)
                access.value?.succeed(ref, with: answer)
            } catch {
                access.value?.fail(ref, reason: SettingsReason.line(for: error))
            }
        }
    }

    /// "Use About you" (PATCH useSharedMemory): optimistic, rolled back with the reason.
    func setUseSharedMemory(_ on: Bool) {
        guard let api, !sharedBusy, on != useSharedMemory else { return }
        let before = useSharedMemory
        useSharedMemory = on
        sharedBusy = true
        sharedFailure = nil
        Task {
            do {
                let channel = try await api.updateChannel(id: channelId, UpdateChannelRequest(useSharedMemory: on))
                useSharedMemory = channel.useSharedMemory
            } catch {
                useSharedMemory = before
                sharedFailure = SettingsReason.line(for: error)
            }
            sharedBusy = false
        }
    }

    /// "Here, OpenDuet also…" (PATCH soulExtra, trimmed by the server).
    func saveSoulExtra(_ text: String) async throws {
        guard let api else { throw APIError.unreachable }
        let channel = try await api.updateChannel(id: channelId, UpdateChannelRequest(soulExtra: text))
        soulExtra = channel.soulExtra
    }

    // MARK: - M12 model and thinking

    /// The Model / Thinking rows (PATCH modelId / thinkingLevel; null = Default).
    func pickModel(_ id: String?) {
        guard let state = models.value, let body = modelChoice.pickModel(id, in: state) else { return }
        patchModel(body)
    }

    func pickThinking(_ level: ThinkingLevel?) {
        guard let body = modelChoice.pickThinking(level) else { return }
        patchModel(body)
    }

    func loadModels() async {
        guard let api else {
            if models.value == nil { models.fail(String(localized: "Can't reach your server.")) }
            return
        }
        models.begin()
        do {
            models.finish(try await api.modelsState())
        } catch {
            if let reason = SettingsReason.line(for: error) { models.fail(reason) } else { models.loading = false }
        }
    }

    private func patchModel(_ body: UpdateChannelRequest) {
        guard let api else {
            modelChoice.fail(reason: String(localized: "Can't reach your server."))
            return
        }
        Task {
            do {
                let channel = try await api.updateChannel(id: channelId, body)
                modelChoice.succeed(modelId: channel.modelId, thinking: channel.thinkingLevel)
            } catch {
                modelChoice.fail(reason: SettingsReason.line(for: error))
            }
        }
    }
}
