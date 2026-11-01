// M27 contract B (backend/src/contract/m27voice.ts): voice settings apart from models, StepFun's
// region, optional cloud dictation. The fields M27 adds to older models sit next to them
// (ModelProvider.region and the provider requests, RemoteModel.transcription in M12Models.swift;
// VoiceSettings.providers / presets / dictation and UpdateVoiceSettingsRequest.dictation in
// M13Models.swift); their tolerant decoding is here or next to them. Tolerant like the rest: a value
// this build doesn't know reads nil (or the default), and an older server's answer decodes.
import Foundation

/// A provider's site (StepFun): mainland China or international. The address follows from it.
enum ProviderRegion: String, Codable, Hashable, Sendable, CaseIterable {
    case cn, intl
}

/// The composer microphone's recognizer.
enum DictationEngine: String, Codable, Hashable, Sendable, CaseIterable {
    /// Apple's recognizer (SFSpeechRecognizer), the default
    case device
    /// POST /api/transcriptions with the saved Gemini / StepFun model
    case cloud
}

/// VoiceSettings.dictation.
struct DictationSettings: Decodable, Hashable, Sendable {
    var engine: DictationEngine
    /// device engine only: Apple's recognizer must not send audio off the iPhone
    var onDeviceOnly: Bool
    /// cloud engine: a Gemini or StepFun provider and the model id sent to it
    var providerId: ID?
    var modelId: String?
    /// the provider exists, isn't failed, has a key, and a model is set (whatever the engine is)
    var cloudReady: Bool

    /// What a server before M27 means: Apple's recognizer, as before.
    static let standard = DictationSettings(engine: .device, onDeviceOnly: false, providerId: nil, modelId: nil, cloudReady: false)

    init(engine: DictationEngine, onDeviceOnly: Bool, providerId: ID?, modelId: String?, cloudReady: Bool) {
        self.engine = engine
        self.onDeviceOnly = onDeviceOnly
        self.providerId = providerId
        self.modelId = modelId
        self.cloudReady = cloudReady
    }

    private enum CodingKeys: String, CodingKey { case engine, onDeviceOnly, providerId, modelId, cloudReady }

    /// An engine this build doesn't know reads device; missing fields read the defaults.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        engine = (try? c.decodeIfPresent(DictationEngine.self, forKey: .engine)) ?? .device
        onDeviceOnly = (try? c.decodeIfPresent(Bool.self, forKey: .onDeviceOnly)) ?? false
        providerId = try? c.decodeIfPresent(ID.self, forKey: .providerId)
        modelId = try? c.decodeIfPresent(String.self, forKey: .modelId)
        cloudReady = (try? c.decodeIfPresent(Bool.self, forKey: .cloudReady)) ?? false
    }
}

/// UpdateVoiceSettingsRequest.dictation: only the fields that change. providerId / modelId: nil =
/// unchanged, .clear = none (a new provider without a model clears the model on the server).
struct UpdateDictationSettingsRequest: Hashable, Sendable {
    var engine: DictationEngine? = nil
    var onDeviceOnly: Bool? = nil
    var providerId: Patch<ID>? = nil
    var modelId: Patch<String>? = nil
}

extension UpdateDictationSettingsRequest: Codable {
    private enum CodingKeys: String, CodingKey { case engine, onDeviceOnly, providerId, modelId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        engine = try c.decodeIfPresent(DictationEngine.self, forKey: .engine)
        onDeviceOnly = try c.decodeIfPresent(Bool.self, forKey: .onDeviceOnly)
        providerId = try c.decodePatch(ID.self, forKey: .providerId)
        modelId = try c.decodePatch(String.self, forKey: .modelId)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(engine, forKey: .engine)
        try c.encodeIfPresent(onDeviceOnly, forKey: .onDeviceOnly)
        try c.encodePatch(providerId, forKey: .providerId)
        try c.encodePatch(modelId, forKey: .modelId)
    }
}
// MARK: - The Voice page's providers

/// A realtime ModelEntry of a voice provider (the Voice page's model row).
struct VoiceModelRow: Decodable, Hashable, Sendable, Identifiable {
    var id: ID
    var modelId: String
    var label: String
}

/// One of the user's Gemini / StepFun providers: the same row the Models page shows (one key for
/// its chat and voice models). No address: it follows the kind and the region.
struct VoiceProvider: Decodable, Hashable, Sendable, Identifiable {
    var id: ID
    var kind: VoiceEngineKind
    var name: String
    /// stepfun: cn / intl; gemini (or a value this build doesn't know): nil
    var region: ProviderRegion?
    /// never the key itself: whether it's set and its last 4 characters
    var key: SecretInfo
    var status: ModelProvider.Status
    var error: String?
    /// its realtime voices in its region, first = the default
    var voices: [String]
    /// its realtime models, oldest first
    var realtimeModels: [VoiceModelRow]
}

extension VoiceProvider {
    private enum CodingKeys: String, CodingKey { case id, kind, name, region, key, status, error, voices, realtimeModels }

    /// A kind this build doesn't know fails (the list skips the row); the rest is tolerant.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ID.self, forKey: .id)
        kind = try c.decode(VoiceEngineKind.self, forKey: .kind)
        name = try c.decode(String.self, forKey: .name)
        region = (try? c.decodeIfPresent(ProviderRegion.self, forKey: .region)) ?? nil
        key = try c.decode(SecretInfo.self, forKey: .key)
        status = (try? c.decode(ModelProvider.Status.self, forKey: .status)) ?? .active
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        voices = (try? c.decodeIfPresent([String].self, forKey: .voices)) ?? []
        realtimeModels = LossyElement.list(c, .realtimeModels)
    }
}

/// A region a kind offers and the host it talks to (shown next to the region's name).
struct VoiceRegionOption: Decodable, Hashable, Sendable {
    var region: ProviderRegion
    var host: String
}

/// What adding a provider of a kind needs: the regions to pick from (none: no region row) and the
/// default (from the iPhone's region).
struct VoiceProviderPreset: Decodable, Hashable, Sendable {
    var kind: VoiceEngineKind
    var regions: [VoiceRegionOption]
    var defaultRegion: ProviderRegion?
}

extension VoiceProviderPreset {
    private enum CodingKeys: String, CodingKey { case kind, regions, defaultRegion }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(VoiceEngineKind.self, forKey: .kind)
        regions = LossyElement.list(c, .regions)
        defaultRegion = (try? c.decodeIfPresent(ProviderRegion.self, forKey: .defaultRegion)) ?? nil
    }
}

// MARK: - Tolerant decoding of the fields M27 adds to older models

extension VoiceSettings {
    private enum CodingKeys: String, CodingKey { case modelId, voice, voices, configured, providers, presets, dictation }

    /// M13's fields as before; the M27 ones default (an older server) and skip rows they can't read.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        modelId = try c.decodeIfPresent(ID.self, forKey: .modelId)
        voice = try c.decodeIfPresent(String.self, forKey: .voice)
        voices = try c.decode(Voices.self, forKey: .voices)
        configured = try c.decode(Bool.self, forKey: .configured)
        providers = LossyElement.list(c, .providers)
        presets = LossyElement.list(c, .presets)
        dictation = (try? c.decodeIfPresent(DictationSettings.self, forKey: .dictation)) ?? .standard
    }
}

extension RemoteModel {
    private enum CodingKeys: String, CodingKey {
        case modelId, label, contextWindow, maxOutputTokens, thinkingLevels, thinkingFormat, tools, vision, realtime, source, addedAs
        case transcription
    }

    /// As synthesized, plus `transcription` (missing or not a Bool: false).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        modelId = try c.decode(String.self, forKey: .modelId)
        label = try c.decode(String.self, forKey: .label)
        contextWindow = try c.decode(Int.self, forKey: .contextWindow)
        maxOutputTokens = try c.decode(Int.self, forKey: .maxOutputTokens)
        thinkingLevels = try c.decode([ThinkingLevel].self, forKey: .thinkingLevels)
        thinkingFormat = try c.decode(ThinkingFormat.self, forKey: .thinkingFormat)
        tools = try c.decode(Bool.self, forKey: .tools)
        vision = try c.decode(Bool.self, forKey: .vision)
        realtime = try c.decode(Bool.self, forKey: .realtime)
        source = try c.decode(Source.self, forKey: .source)
        addedAs = try c.decodeIfPresent(ID.self, forKey: .addedAs)
        transcription = (try? c.decodeIfPresent(Bool.self, forKey: .transcription)) ?? false
    }
}

/// Decodes an array element by element, keeping the ones that decode (a row from a newer server
/// with a kind this build doesn't know is left out instead of failing the whole answer).
private struct LossyElement<Element: Decodable>: Decodable {
    var value: Element?

    init(from decoder: Decoder) throws {
        value = try? Element(from: decoder)
    }

    static func list<Key: CodingKey>(_ c: KeyedDecodingContainer<Key>, _ key: Key) -> [Element] {
        let rows = (try? c.decodeIfPresent([LossyElement<Element>].self, forKey: key)) ?? nil
        return rows?.compactMap(\.value) ?? []
    }
}

// MARK: - POST /api/transcriptions

/// 200: the recognized text, trimmed; "" when nothing was said. Never stored on the server.
struct TranscriptionResponse: Decodable, Hashable, Sendable {
    var text: String
}

/// The ApiError code POST /api/transcriptions answers besides the shared ones (validation_failed
/// fields "file" / "language", too_large, unsupported_type, not_configured). APIError reads it as
/// `.server(status: 502, code:)`.
enum TranscriptionRefusal: String, Sendable, CaseIterable {
    /// 502: the provider refused or failed (key, rate limit, timeout, unreachable, no text)
    case transcriptionFailed = "transcription_failed"
}

/// The upload's limits (contract TRANSCRIPTION_*) and the format the app records.
enum TranscriptionLimits {
    static let maxBytes = 8 * 1024 * 1024
    static let maxSeconds: Double = 120
    /// the server refuses shorter clips; the app doesn't send under `minSendSeconds`
    static let minSeconds: Double = 0.3
    static let minSendSeconds: Double = 0.5
    /// WAV, linear PCM 16-bit mono at 16 kHz (≈ 3.8 MB for 120 s)
    static let sampleRate: Double = 16_000
    static let channels = 1
    static let bitDepth = 16
}
