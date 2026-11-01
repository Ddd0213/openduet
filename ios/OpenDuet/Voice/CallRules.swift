// The voice call's app rules, apart from the views: the chat's call line ("Voice call · 3 min"),
// the call bar's phase words and timer, the composer's notes before a call starts (set up a
// voice model, the microphone, another call open, the server's reason), and the settings' Voice
// page (which realtime models can be picked, which voices go with them; M27: from the page's own
// answer, VoiceSettings.providers).
// Pure Foundation (host-tested).
import Foundation

enum CallCopy {
    /// The chat's quiet row: "Voice call · 3 min" (under a minute: "Voice call · 45 sec").
    static func line(seconds: Int, locale: Locale) -> String {
        let length = PhraseFormatter.duration(Double(max(seconds, 0)), locale: locale)
        return String(localized: "Voice call · \(length)", locale: locale)
    }

    /// The call bar's timer: "0:07", "3:05", "1:02:03".
    static func timer(_ seconds: Int) -> String {
        MakeCopy.elapsed(TimeInterval(max(seconds, 0)))
    }

    /// The call bar's phase word (nil once the call is over and the bar goes away).
    static func phase(_ phase: CallPhase, muted: Bool) -> String? {
        switch phase {
        case .connecting, .ready: String(localized: "Connecting…")
        case .listening: muted ? String(localized: "Muted") : String(localized: "Listening")
        case .speaking: String(localized: "Speaking")
        case .reconnecting: String(localized: "Reconnecting…")
        case .failed(let reason, _): reason
        case .ended: nil
        }
    }
}

/// What the composer says when a call can't start (inline, never an alert).
enum CallNote: Hashable, Sendable {
    /// No usable realtime model: "Set up a voice model in Voice" + Set up (the settings' Voice page).
    case setup
    /// The microphone is off for the app: + Settings.
    case microphone
    /// A call is open in another channel (409).
    case busy
    /// Anything else: the server's (or the connection's) reason.
    case failed(String)
    /// The task thread: calls are per channel.
    case channelOnly

    var text: String {
        switch self {
        case .setup: String(localized: "Set up a voice model in Voice")
        case .microphone: String(localized: "OpenDuet can't use the microphone. Turn it on in Settings.")
        case .busy: String(localized: "You're already on a call in another channel.")
        case .failed(let reason): reason
        case .channelOnly: String(localized: "Voice calls start from a channel's chat.")
        }
    }

    /// The note for a failed POST /api/calls.
    static func from(_ error: any Error) -> CallNote {
        switch error as? APIError {
        case .notConfigured?: return .setup
        case .server(409, _)?, .staleVersion?: return .busy
        case .validationFailed(_, let message)? where !message.isEmpty: return .failed(message)
        case let api?:
            return .failed(api.localizedReason)
        case nil:
            return .failed(String(localized: "Couldn't start the call."))
        }
    }
}

/// The Voice page: the realtime models a call can use and the voices that go with them (M13's
/// rules read GET /api/models; an M27 server's answer has them itself, `current(_:)`).
enum VoiceModelRules {
    /// The engine a provider's realtime models run on (nil: no voice calls with this provider).
    static func engine(_ kind: ProviderKind) -> VoiceEngineKind? {
        switch kind {
        case .gemini: .gemini
        case .stepfun: .stepfun
        case .openai, .anthropic, .custom: nil
        }
    }

    /// The engine of a model entry (through its provider).
    static func engine(of model: ModelEntry, in state: ModelsState) -> VoiceEngineKind? {
        ModelCatalog.provider(model.providerId, in: state).flatMap { engine($0.kind) }
    }

    /// Realtime entries of a Gemini or StepFun provider that has a key, in server order.
    static func usableModels(_ state: ModelsState) -> [ModelEntry] {
        state.models.filter { model in
            guard model.purpose == .realtime, let provider = ModelCatalog.provider(model.providerId, in: state) else { return false }
            return engine(provider.kind) != nil && provider.key.set
        }
    }

    /// The model calls use: the chosen one while usable, else the first usable one (the server's
    /// own fallback), else none.
    static func current(_ settings: VoiceSettings, in state: ModelsState) -> ModelEntry? {
        let usable = usableModels(state)
        return usable.first { $0.id == settings.modelId } ?? usable.first
    }

    /// The voice picker's names for the model's engine ([] without a model).
    static func voices(_ settings: VoiceSettings, model: ModelEntry?, in state: ModelsState) -> [String] {
        guard let model, let engine = engine(of: model, in: state) else { return [] }
        return settings.voices[engine]
    }

    /// The chosen voice when the current engine has it (else the engine's default: nil).
    static func voice(_ settings: VoiceSettings, model: ModelEntry?, in state: ModelsState) -> String? {
        guard let voice = settings.voice, voices(settings, model: model, in: state).contains(voice) else { return nil }
        return voice
    }

    /// The StepFun note shows when a StepFun model can be picked.
    static func showsStepNote(_ state: ModelsState) -> Bool {
        usableModels(state).contains { engine(of: $0, in: state) == .stepfun }
    }

    // MARK: - M27: from GET /api/voice-settings alone (VoiceSettings.providers)

    /// A provider calls can use: it has a key and its last check didn't fail.
    static func isUsable(_ provider: VoiceProvider) -> Bool {
        provider.key.set && provider.status != .failed
    }

    /// The model calls use: the chosen one while its provider is usable, else the first realtime
    /// model of a usable provider (oldest first, as the server falls back), else none.
    static func current(_ settings: VoiceSettings) -> VoiceCurrent? {
        let usable = settings.providers.filter(isUsable)
        for provider in usable {
            if let model = provider.realtimeModels.first(where: { $0.id == settings.modelId }) {
                return VoiceCurrent(provider: provider, model: model)
            }
        }
        for provider in usable {
            if let model = provider.realtimeModels.first { return VoiceCurrent(provider: provider, model: model) }
        }
        return nil
    }
}

/// The realtime model calls use and its provider (M27).
struct VoiceCurrent: Hashable, Sendable {
    var provider: VoiceProvider
    var model: VoiceModelRow
}
