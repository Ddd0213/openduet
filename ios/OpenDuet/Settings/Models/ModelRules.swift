// M12 model configuration, without SwiftUI for the host tests: the thinking ladder's names, which
// models the assistant can chat with (purpose chat, tools, a provider with a key), the models list grouped
// by provider, the model a channel really runs on and its levels, the defaults' picker options,
// the badges of a remote / saved model and the presets' names. Forms: ProviderDraft.swift,
// ModelEditDraft.swift; picks: ModelChoiceRules.swift.
import Foundation

extension ThinkingLevel {
    /// The level's name in the app.
    var label: LocalizedStringResource {
        switch self {
        case .off: "Off"
        case .minimal: "Minimal"
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .xhigh: "Extra high"
        case .max: "Max"
        }
    }

    /// Ladder order, each level once.
    static func ladder(_ levels: some Sequence<ThinkingLevel>) -> [ThinkingLevel] {
        Array(Set(levels)).sorted()
    }
}

extension ThinkingFormat {
    var label: LocalizedStringResource {
        switch self {
        case .effort: "Effort"
        case .budget: "Budget"
        case .noThinking: "None"
        }
    }
}

extension ProviderKind {
    /// The preset's name (the server names a new provider this way unless the user types one).
    var title: LocalizedStringResource {
        switch self {
        case .openai: "OpenAI"
        case .anthropic: "Anthropic"
        case .gemini: "Google Gemini"
        case .stepfun: "StepFun"
        case .custom: "Custom"
        }
    }

    /// The grey line under a preset in Add provider.
    var blurb: LocalizedStringResource {
        switch self {
        case .openai: "GPT and o-series models"
        case .anthropic: "Claude models"
        case .gemini: "Gemini models"
        case .stepfun: "Step models"
        case .custom: "Any OpenAI- or Anthropic-compatible address"
        }
    }

    /// The two letters on the provider's tile.
    var monogram: String {
        switch self {
        case .openai: "AI"
        case .anthropic: "A"
        case .gemini: "G"
        case .stepfun: "S"
        case .custom: "C"
        }
    }
}

extension ProviderProtocol {
    var label: LocalizedStringResource {
        switch self {
        case .openai: "OpenAI-compatible"
        case .anthropic: "Anthropic-compatible"
        }
    }
}

extension ProviderAuth {
    var label: LocalizedStringResource {
        switch self {
        case .xApiKey: "x-api-key"
        case .bearer: "Bearer"
        }
    }
}

/// A provider's models in the list (server order).
struct ModelGroup: Hashable, Sendable, Identifiable {
    var provider: ModelProvider
    var models: [ModelEntry]
    var id: String { provider.id }
}

enum ModelCatalog {
    static func provider(_ id: String, in state: ModelsState) -> ModelProvider? {
        state.providers.first { $0.id == id }
    }

    static func model(_ id: String?, in state: ModelsState) -> ModelEntry? {
        guard let id else { return nil }
        return state.models.first { $0.id == id }
    }

    /// A model the assistant can chat with: purpose chat, tools on, and its provider has a key.
    static func isUsableChat(_ model: ModelEntry, in state: ModelsState) -> Bool {
        guard model.purpose == .chat, model.tools else { return false }
        return provider(model.providerId, in: state)?.key.set == true
    }

    /// Default model, a channel's model, Switch model: the usable chat models.
    static func usableChatModels(_ state: ModelsState) -> [ModelEntry] {
        state.models.filter { isUsableChat($0, in: state) }
    }

    /// The background model: any chat model (tools aren't needed for titles and summaries).
    static func chatModels(_ state: ModelsState) -> [ModelEntry] {
        state.models.filter { $0.purpose == .chat }
    }

    /// Realtime voice models (M13), never a chat model. M27: the Models pages don't list them (the
    /// Voice page has them, from GET /api/voice-settings).
    static func voiceModels(_ state: ModelsState) -> [ModelEntry] {
        state.models.filter { $0.purpose == .realtime }
    }

    /// M27: a provider's chat models (its page on Models; realtime ones are on the Voice page).
    static func chatModels(of providerId: String, in state: ModelsState) -> [ModelEntry] {
        state.models.filter { $0.providerId == providerId && $0.purpose == .chat }
    }

    /// The models list: one group per provider with chat models (providers in server order).
    static func groups(_ models: [ModelEntry], in state: ModelsState) -> [ModelGroup] {
        state.providers.compactMap { provider in
            let mine = models.filter { $0.providerId == provider.id }
            return mine.isEmpty ? nil : ModelGroup(provider: provider, models: mine)
        }
    }

    /// The default model when it's still usable.
    static func defaultModel(_ state: ModelsState) -> ModelEntry? {
        guard let model = model(state.defaults.defaultModelId, in: state), isUsableChat(model, in: state) else { return nil }
        return model
    }

    /// The model a channel runs on: its own while still usable, else the default.
    static func effectiveModel(channelModelId: String?, in state: ModelsState) -> ModelEntry? {
        if let own = model(channelModelId, in: state), isUsableChat(own, in: state) { return own }
        return defaultModel(state)
    }

    /// A model's levels in ladder order ([] = it doesn't think).
    static func levels(of model: ModelEntry?) -> [ThinkingLevel] {
        ThinkingLevel.ladder(model?.thinkingLevels ?? [])
    }

    /// "200K", "1M", "1.5M", "8K".
    static func tokens(_ count: Int) -> String {
        if count >= 1_000_000 {
            let millions = (Double(count) / 100_000).rounded() / 10
            return millions == millions.rounded() ? "\(Int(millions))M" : String(format: "%.1fM", millions)
        }
        if count >= 1_000 { return "\(Int((Double(count) / 1_000).rounded()))K" }
        return "\(max(count, 0))"
    }
}

/// The small capsules on a model row.
enum ModelBadge: Hashable, Sendable {
    case context(String)
    /// levels besides off: 1 reads "Thinking", more "4 levels"
    case thinking(levels: Int)
    case tools
    case vision
    case voice

    static func badges(contextWindow: Int, levels: [ThinkingLevel], tools: Bool, vision: Bool, realtime: Bool) -> [ModelBadge] {
        var badges: [ModelBadge] = [.context(ModelCatalog.tokens(contextWindow))]
        let thinking = Set(levels).subtracting([.off]).count
        if thinking > 0 { badges.append(.thinking(levels: thinking)) }
        if tools { badges.append(.tools) }
        if vision { badges.append(.vision) }
        if realtime { badges.append(.voice) }
        return badges
    }

    static func badges(_ model: RemoteModel) -> [ModelBadge] {
        badges(contextWindow: model.contextWindow, levels: model.thinkingLevels, tools: model.tools, vision: model.vision, realtime: model.realtime)
    }

    static func badges(_ model: ModelEntry) -> [ModelBadge] {
        badges(contextWindow: model.contextWindow, levels: model.thinkingLevels, tools: model.tools, vision: model.vision, realtime: model.purpose == .realtime)
    }

    var label: LocalizedStringResource {
        switch self {
        case .context(let size): "\(size) context"
        case .thinking(let count): count == 1 ? "Thinking" : "\(count) levels"
        case .tools: "Tools"
        case .vision: "Images"
        case .voice: "Voice"
        }
    }
}

/// The Defaults card's pickers.
enum DefaultsRules {
    /// Default model: only usable chat models.
    static func modelOptions(_ state: ModelsState) -> [ModelEntry] { ModelCatalog.usableChatModels(state) }

    /// Default thinking: "Automatic" (nil) plus the default model's levels.
    static func thinkingOptions(_ state: ModelsState) -> [ThinkingLevel] {
        ModelCatalog.levels(of: ModelCatalog.defaultModel(state))
    }

    /// Background model: "Same as default" (nil) plus any chat model.
    static func backgroundOptions(_ state: ModelsState) -> [ModelEntry] { ModelCatalog.chatModels(state) }
}

/// A provider row's grey line.
enum ProviderCopy {
    /// "Key ····9xQa" (or "No key").
    static func keyLine(_ info: SecretInfo) -> LocalizedStringResource {
        guard info.set else { return "No key" }
        if let last4 = info.last4, !last4.isEmpty { return "Key ····\(last4)" }
        return "Key saved"
    }

    static func modelCount(_ count: Int) -> LocalizedStringResource {
        switch count {
        case 0: "No models yet"
        case 1: "1 model"
        default: "\(count) models"
        }
    }

    /// The failure's words, nil while it connects.
    static func failure(_ provider: ModelProvider) -> String? {
        guard provider.status == .failed else { return nil }
        let reason = (provider.error ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return reason.isEmpty ? String(localized: "Can't connect") : String(localized: "Can't connect: \(reason)")
    }

    /// "https://api.anthropic.com" reads as "api.anthropic.com".
    static func address(_ url: String) -> String {
        var text = url.trimmingCharacters(in: .whitespacesAndNewlines)
        for scheme in ["https://", "http://"] where text.lowercased().hasPrefix(scheme) {
            text.removeFirst(scheme.count)
        }
        if text.hasSuffix("/") { text.removeLast() }
        return text
    }
}
