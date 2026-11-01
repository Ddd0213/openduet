// M27 the Voice page's Speech recognition section (the composer microphone), without SwiftUI for
// the host tests: Recognizer iPhone (Apple's, default) / Cloud; iPhone has "Only on this iPhone";
// Cloud has Provider (the Gemini / StepFun providers with a key; none: a line pointing up to the
// realtime section's key), Model (the provider's transcription rows first, then the rest, plus a
// typed id), "Try it" and, while it can't be used, why. Writes: PUT {dictation}, shown at once.
import Foundation

extension DictationEngine {
    /// The Recognizer row's names.
    var label: LocalizedStringResource {
        switch self {
        case .device: "iPhone"
        case .cloud: "Cloud"
        }
    }
}

/// The Speech recognition section's rows, in order.
enum VoiceDictationRow: Hashable, Sendable {
    case recognizer
    /// iPhone: the "Only on this iPhone" switch
    case onDeviceOnly
    /// Cloud without a Gemini / StepFun key: a line pointing up to the realtime section
    case needsKey
    case provider, model
    /// Cloud and ready: record 3 s, show the text
    case tryIt
    /// Cloud, not ready: why, in one line
    case notReady
}

/// One Model option of the cloud recognizer.
struct DictationModelChoice: Hashable, Sendable, Identifiable {
    var modelId: String
    var label: String
    /// models.dev (or the id) says it's a recognizer: listed first
    var transcription: Bool
    var id: String { modelId }
}

enum VoiceDictationRules {
    /// The cloud recognizer's providers: the user's Gemini / StepFun ones with a key.
    static func providers(_ settings: VoiceSettings) -> [VoiceProvider] {
        settings.providers.filter { $0.key.set }
    }

    static func rows(_ settings: VoiceSettings) -> [VoiceDictationRow] {
        let dictation = settings.dictation
        switch dictation.engine {
        case .device:
            return [.recognizer, .onDeviceOnly]
        case .cloud:
            if providers(settings).isEmpty && dictation.providerId == nil { return [.recognizer, .needsKey] }
            return [.recognizer, .provider, .model, dictation.cloudReady ? .tryIt : .notReady]
        }
    }

    /// Model: the transcription rows first, then the rest (never a realtime row), each once; the
    /// saved id stays listed when the provider's list doesn't have it.
    static func modelChoices(_ remote: [RemoteModel], saved: String?) -> [DictationModelChoice] {
        let rows = remote.filter { !$0.realtime }
        let ordered = rows.filter(\.transcription) + rows.filter { !$0.transcription }
        var seen = Set<String>()
        var choices = ordered.compactMap { model -> DictationModelChoice? in
            guard seen.insert(model.modelId).inserted else { return nil }
            return DictationModelChoice(modelId: model.modelId, label: model.label, transcription: model.transcription)
        }
        if let saved, !saved.isEmpty, !seen.contains(saved) {
            choices.insert(DictationModelChoice(modelId: saved, label: saved, transcription: false), at: 0)
        }
        return choices
    }

    /// Switching to Cloud with no provider chosen: the only provider with a key comes with it
    /// (with two or more the user picks).
    static func providerOnCloud(_ settings: VoiceSettings) -> VoiceProvider? {
        guard settings.dictation.providerId == nil else { return nil }
        let keyed = providers(settings)
        return keyed.count == 1 ? keyed[0] : nil
    }

    /// The model suggested when a provider is chosen: StepFun's first transcription row (Gemini's
    /// chat models all take audio: the user picks).
    static func suggestedModel(_ kind: VoiceEngineKind, remote: [RemoteModel]) -> String? {
        guard kind == .stepfun else { return nil }
        return remote.first { $0.transcription && !$0.realtime }?.modelId
    }

    /// Why the cloud recognizer can't be used yet (nil when it can, or the iPhone's is chosen).
    static func notReadyLine(_ settings: VoiceSettings) -> String? {
        let dictation = settings.dictation
        guard dictation.engine == .cloud, !dictation.cloudReady else { return nil }
        guard let id = dictation.providerId, let provider = settings.providers.first(where: { $0.id == id }) else {
            return String(localized: "Choose a provider to dictate with.")
        }
        if !provider.key.set { return String(localized: "\(provider.name) has no key. Add it above.") }
        if provider.status == .failed { return String(localized: "\(provider.name)'s key was refused. Replace it above.") }
        if (dictation.modelId ?? "").isEmpty { return String(localized: "Choose the model that transcribes.") }
        return String(localized: "Cloud dictation isn't set up.")
    }

    /// The model id as typed ("Type a model id…"): trimmed, 1-200 characters.
    static func typedModel(_ text: String) -> String? {
        let id = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return id.isEmpty || id.count > 200 ? nil : id
    }

    /// What the page shows at once for a dictation write (rolled back if the server refuses): a
    /// new provider clears the model unless one comes with it; cloudReady as the server computes it.
    static func optimistic(_ dictation: DictationSettings, _ patch: UpdateDictationSettingsRequest, providers: [VoiceProvider]) -> DictationSettings {
        var next = dictation
        if let engine = patch.engine { next.engine = engine }
        if let onDevice = patch.onDeviceOnly { next.onDeviceOnly = onDevice }
        if let provider = patch.providerId {
            next.providerId = provider.value
            next.modelId = nil
        }
        if let model = patch.modelId { next.modelId = model.value }
        if patch.providerId != nil || patch.modelId != nil { next.cloudReady = isReady(next, providers: providers) }
        return next
    }

    /// The server's cloudReady: the provider is the user's, has a key, isn't failed, and a model is set.
    static func isReady(_ dictation: DictationSettings, providers: [VoiceProvider]) -> Bool {
        guard let id = dictation.providerId, let provider = providers.first(where: { $0.id == id }),
              provider.key.set, provider.status != .failed, !(dictation.modelId ?? "").isEmpty else { return false }
        return true
    }
}
