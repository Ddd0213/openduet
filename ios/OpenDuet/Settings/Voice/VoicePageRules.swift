// M27 the Voice page's rules, without SwiftUI for the host tests (data: GET /api/voice-settings
// only). Realtime voice in Codync's order: Provider (the user's Gemini / StepFun providers, plus
// "Add <kind>" for a kind with none), StepFun's Region, the key in three states (none / saved /
// failed), Model (added realtime models first, then the provider's remote realtime rows not added
// yet) and Voice (Default + the provider's voices); without a key Model and Voice are grey. An
// older server (no providers, no presets) gets M13's page.
import Foundation

enum VoicePageLayout: Hashable, Sendable {
    /// a server before M27: model + voice from GET /api/models, "Open Models"
    case legacy
    case current
}

/// The Provider row's options: one of the user's providers, or adding one of a kind they lack.
enum VoiceProviderChoice: Hashable, Sendable {
    case existing(ID)
    case add(VoiceEngineKind)
}

/// The key area's three states (Codync's).
enum VoiceKeyState: Hashable, Sendable {
    /// a secure field "API key" and Save (the server checks it first)
    case none
    /// "Key saved ··last4", Test key, Replace key, "Key works"
    case saved(last4: String?)
    /// saved, but the last check failed: its reason in red
    case failed(last4: String?, reason: String)

    var hasKey: Bool { self != .none }
}

/// The realtime section's rows, in order.
enum VoiceRealtimeRow: Hashable, Sendable {
    case provider, region, key, model, voice
}

struct VoiceRealtimeLayout: Hashable, Sendable {
    var rows: [VoiceRealtimeRow]
    var key: VoiceKeyState
    /// Model and Voice can be opened (a key is saved); else grey, with `keyFootnote`
    var choicesEnabled: Bool
    var showsKeyFootnote: Bool
    /// StepFun has no short-lived keys (the phone holds the key during a call)
    var showsStepNote: Bool
}

/// The Model row's options.
enum VoiceModelChoice: Hashable, Sendable, Identifiable {
    /// an added realtime ModelEntry
    case added(VoiceModelRow)
    /// a realtime row the provider offers, not added yet: picking it adds it first
    case remote(RemoteModel)

    var id: String {
        switch self {
        case .added(let row): "added:" + row.id
        case .remote(let model): "remote:" + model.modelId
        }
    }

    var label: String {
        switch self {
        case .added(let row): row.label
        case .remote(let model): model.label
        }
    }

    var modelId: String {
        switch self {
        case .added(let row): row.modelId
        case .remote(let model): model.modelId
        }
    }
}

enum VoicePageRules {
    /// An older server's answer has neither providers nor presets: today's page.
    static func layout(_ settings: VoiceSettings) -> VoicePageLayout {
        settings.providers.isEmpty && settings.presets.isEmpty ? .legacy : .current
    }

    /// The user's providers, then "Add <kind>" for each preset kind they have none of.
    static func providerChoices(_ settings: VoiceSettings) -> [VoiceProviderChoice] {
        let have = Set(settings.providers.map(\.kind))
        return settings.providers.map { .existing($0.id) }
            + settings.presets.map(\.kind).filter { !have.contains($0) }.map { .add($0) }
    }

    /// The provider the page opens on: the one calls use, else one with a key, else the first;
    /// with none, adding the first preset kind.
    static func defaultChoice(_ settings: VoiceSettings) -> VoiceProviderChoice? {
        if let current = VoiceModelRules.current(settings) { return .existing(current.provider.id) }
        if let owner = settings.providers.first(where: { $0.realtimeModels.contains { $0.id == settings.modelId } }) {
            return .existing(owner.id)
        }
        if let keyed = settings.providers.first(where: { $0.key.set }) { return .existing(keyed.id) }
        if let first = settings.providers.first { return .existing(first.id) }
        return providerChoices(settings).first
    }

    /// The choice the page shows: the user's pick while it still exists (an added provider takes
    /// the place of "Add <its kind>"), else the default.
    static func choice(_ picked: VoiceProviderChoice?, in settings: VoiceSettings) -> VoiceProviderChoice? {
        let choices = providerChoices(settings)
        if let picked, choices.contains(picked) { return picked }
        if case .add(let kind)? = picked, let added = settings.providers.first(where: { $0.kind == kind }) {
            return .existing(added.id)
        }
        return defaultChoice(settings)
    }

    static func provider(_ choice: VoiceProviderChoice?, in settings: VoiceSettings) -> VoiceProvider? {
        guard case .existing(let id)? = choice else { return nil }
        return settings.providers.first { $0.id == id }
    }

    static func kind(_ choice: VoiceProviderChoice, in settings: VoiceSettings) -> VoiceEngineKind? {
        switch choice {
        case .add(let kind): kind
        case .existing: provider(choice, in: settings)?.kind
        }
    }

    /// The key area's state (a provider being added has none).
    static func keyState(_ provider: VoiceProvider?) -> VoiceKeyState {
        guard let provider, provider.key.set else { return .none }
        let last4 = provider.key.last4.flatMap { $0.isEmpty ? nil : $0 }
        if provider.status == .failed {
            let reason = (provider.error ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return .failed(last4: last4, reason: reason.isEmpty ? String(localized: "Can't connect") : reason)
        }
        return .saved(last4: last4)
    }

    static func layout(_ choice: VoiceProviderChoice, in settings: VoiceSettings) -> VoiceRealtimeLayout {
        let provider = provider(choice, in: settings)
        let kind = kind(choice, in: settings)
        let key = keyState(provider)
        var rows: [VoiceRealtimeRow] = [.provider]
        if let kind, !ProviderRegionRules.options(for: kind.providerKind, presets: settings.presets).isEmpty {
            rows.append(.region)
        }
        rows += [.key, .model, .voice]
        return VoiceRealtimeLayout(
            rows: rows, key: key, choicesEnabled: key.hasKey, showsKeyFootnote: !key.hasKey,
            showsStepNote: kind == .stepfun
        )
    }

    /// Model: the provider's realtime models, then its remote realtime rows not added yet.
    static func modelChoices(_ provider: VoiceProvider?, remote: [RemoteModel]) -> [VoiceModelChoice] {
        guard let provider else { return [] }
        let added = Set(provider.realtimeModels.map(\.modelId))
        let more = remote.filter { $0.realtime && $0.addedAs == nil && !added.contains($0.modelId) }
        return provider.realtimeModels.map { .added($0) } + more.map { .remote($0) }
    }

    /// The provider's model calls use, or the one chosen for it; nil when it's another provider's.
    static func chosenModel(_ provider: VoiceProvider?, in settings: VoiceSettings) -> VoiceModelRow? {
        guard let provider else { return nil }
        if let chosen = provider.realtimeModels.first(where: { $0.id == settings.modelId }) { return chosen }
        guard let current = VoiceModelRules.current(settings), current.provider.id == provider.id else { return nil }
        return current.model
    }

    /// Voice: the provider's own voices once one of its models is the one calls use; else none.
    static func voices(_ provider: VoiceProvider?, in settings: VoiceSettings) -> [String] {
        guard let provider, chosenModel(provider, in: settings) != nil else { return [] }
        return provider.voices
    }

    /// The chosen voice when the provider has it (else Default: nil).
    static func voice(_ provider: VoiceProvider?, in settings: VoiceSettings) -> String? {
        guard let voice = settings.voice, voices(provider, in: settings).contains(voice) else { return nil }
        return voice
    }

    /// Picking a provider that can take calls switches calls to its first model (Codync's
    /// engine); nil: nothing to send (no key, a failed key, no model yet, or it's already used).
    static func modelOnPick(_ provider: VoiceProvider?, in settings: VoiceSettings) -> ID? {
        guard let provider, VoiceModelRules.isUsable(provider), let first = provider.realtimeModels.first else { return nil }
        if VoiceModelRules.current(settings)?.provider.id == provider.id { return nil }
        return first.id
    }

    /// The footnote under the page: whose key pays.
    static func billingLine(_ kind: VoiceEngineKind) -> String {
        let name = String(localized: kind.title)
        return String(localized: "Your own \(name) key, billed by \(name).")
    }

    /// Model and Voice are grey without a key.
    static func keyFootnote(_ kind: VoiceEngineKind) -> String {
        String(localized: "Add a key to choose from \(String(localized: kind.title))'s models.")
    }
}
