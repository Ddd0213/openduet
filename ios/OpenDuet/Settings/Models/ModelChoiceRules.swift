// M12 picks, without SwiftUI for the host tests: the remote models picker's selection ("Add N
// models"), a channel's model and thinking level (optimistic, rolled back with the reason) and the
// labels the pickers show.
import Foundation

/// The remote models picker: rows already in the list show checked and can't be picked again.
struct RemoteModelSelection: Hashable, Sendable {
    /// POST /api/models/batch takes up to 100 ids
    static let limit = 100

    /// picked model ids, in the order they were tapped
    private(set) var picked: [String] = []

    func isPicked(_ id: String) -> Bool { picked.contains(id) }

    static func isAdded(_ model: RemoteModel) -> Bool { model.addedAs != nil }

    func canPick(_ model: RemoteModel) -> Bool {
        !Self.isAdded(model) && (isPicked(model.modelId) || picked.count < Self.limit)
    }

    mutating func toggle(_ model: RemoteModel) {
        guard !Self.isAdded(model) else { return }
        if let index = picked.firstIndex(of: model.modelId) {
            picked.remove(at: index)
        } else if picked.count < Self.limit {
            picked.append(model.modelId)
        }
    }

    var count: Int { picked.count }

    /// A fresh list arrived: picks that are gone or added meanwhile drop out.
    mutating func prune(to models: [RemoteModel]) {
        let open = Set(models.filter { !Self.isAdded($0) }.map(\.modelId))
        picked.removeAll { !open.contains($0) }
    }

    func request(providerId: String) -> CreateModelEntriesRequest? {
        picked.isEmpty ? nil : CreateModelEntriesRequest(providerId: providerId, modelIds: picked)
    }

    /// M27: the Models side's rows: realtime models are added on the Voice page only.
    static func chatRows(_ models: [RemoteModel]) -> [RemoteModel] {
        models.filter { !$0.realtime }
    }

    /// The search field: label or id, case- and accent-insensitive; empty shows everything.
    static func filter(_ models: [RemoteModel], query: String) -> [RemoteModel] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return models }
        return models.filter {
            $0.label.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil
                || $0.modelId.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }
}

/// A channel's Model and Thinking rows: shown at once, PATCHed behind, put back on failure.
struct ChannelModelChoice: Hashable, Sendable {
    /// what the server has
    private(set) var savedModelId: String?
    private(set) var savedThinking: ThinkingLevel?
    /// what the rows show
    private(set) var modelId: String?
    private(set) var thinking: ThinkingLevel?
    private(set) var busy = false
    private(set) var failure: String?

    init(modelId: String?, thinking: ThinkingLevel?) {
        savedModelId = modelId
        savedThinking = thinking
        self.modelId = modelId
        self.thinking = thinking
    }

    /// A newer copy of the channel (a `channel` event): taken unless a change of ours is running.
    mutating func sync(modelId: String?, thinking: ThinkingLevel?) {
        savedModelId = modelId
        savedThinking = thinking
        guard !busy else { return }
        self.modelId = modelId
        self.thinking = thinking
    }

    /// Pick a model (nil = Default). The thinking level goes back to Default too when the model
    /// the channel then runs on doesn't have it. Returns the PATCH body, nil when nothing changes.
    mutating func pickModel(_ id: String?, in state: ModelsState) -> UpdateChannelRequest? {
        guard !busy, id != modelId else { return nil }
        var body = UpdateChannelRequest()
        body.modelId = Patch(id)
        let levels = ModelCatalog.levels(of: ModelCatalog.effectiveModel(channelModelId: id, in: state))
        if let level = thinking, !levels.contains(level) {
            thinking = nil
            body.thinkingLevel = .clear
        }
        modelId = id
        begin()
        return body
    }

    /// Pick a thinking level (nil = Default).
    mutating func pickThinking(_ level: ThinkingLevel?) -> UpdateChannelRequest? {
        guard !busy, level != thinking else { return nil }
        thinking = level
        begin()
        var body = UpdateChannelRequest()
        body.thinkingLevel = Patch(level)
        return body
    }

    private mutating func begin() {
        busy = true
        failure = nil
    }

    /// The server's answer (the channel as it has it now).
    mutating func succeed(modelId: String?, thinking: ThinkingLevel?) {
        busy = false
        savedModelId = modelId
        savedThinking = thinking
        self.modelId = modelId
        self.thinking = thinking
    }

    /// The PATCH failed: back to what the server has, with its reason (nil = cancelled).
    mutating func fail(reason: String?) {
        busy = false
        modelId = savedModelId
        thinking = savedThinking
        failure = reason
    }

    /// The Thinking row's options: Default plus the levels of the model the channel runs on.
    func thinkingOptions(in state: ModelsState) -> [ThinkingLevel] {
        ModelCatalog.levels(of: ModelCatalog.effectiveModel(channelModelId: modelId, in: state))
    }

    /// The Model row's options: Default plus the usable chat models.
    static func modelOptions(in state: ModelsState) -> [ModelEntry] {
        ModelCatalog.usableChatModels(state)
    }

    /// The channel's own model was deleted or lost its key: the row shows Default.
    func ownModelMissing(in state: ModelsState) -> Bool {
        guard let modelId else { return false }
        guard let model = ModelCatalog.model(modelId, in: state) else { return true }
        return !ModelCatalog.isUsableChat(model, in: state)
    }
}

/// The words of the pickers' rows.
enum ModelChoiceCopy {
    /// "Default · Claude Opus 4.6", or just "Default" when no default model is set up.
    static func defaultModel(_ state: ModelsState) -> String {
        guard let model = ModelCatalog.defaultModel(state) else { return String(localized: "Default") }
        return String(localized: "Default · \(model.label)")
    }

    /// "Default · Medium" (the user's default thinking), "Default" when automatic.
    static func defaultThinking(_ state: ModelsState) -> String {
        guard let level = state.defaults.defaultThinking else { return String(localized: "Default") }
        return String(localized: "Default · \(String(localized: level.label))")
    }
}
