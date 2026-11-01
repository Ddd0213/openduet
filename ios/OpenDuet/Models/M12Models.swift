// M12: model configuration on the phone (backend/src/contract/m12.ts): providers (OpenAI,
// Anthropic, Gemini, StepFun or a custom OpenAI / Anthropic compatible URL) whose key stays in the
// server's vault, the models picked from a provider's own list, the defaults and the
// `model_error` card. Tri-state fields (leave / set / clear) use Patch: the key is left out for
// "unchanged" and sent as an explicit null for "clear".
import Foundation

// MARK: - Tri-state

/// A field of a PATCH / PUT body that can also be cleared. `nil` (the Optional) = unchanged.
enum Patch<Value: Codable & Hashable & Sendable>: Hashable, Sendable {
    case set(Value)
    /// sent as null (back to the default)
    case clear

    /// The value after the change (nil for .clear).
    var value: Value? {
        if case .set(let value) = self { value } else { nil }
    }

    /// .set for a value, .clear for nil.
    init(_ value: Value?) {
        self = value.map { .set($0) } ?? .clear
    }
}

extension KeyedEncodingContainer {
    mutating func encodePatch<Value>(_ patch: Patch<Value>?, forKey key: Key) throws {
        switch patch {
        case .set(let value)?: try encode(value, forKey: key)
        case .clear?: try encodeNil(forKey: key)
        case nil: break
        }
    }
}

extension KeyedDecodingContainer {
    /// Missing key = nil (unchanged); null = .clear; a value = .set.
    func decodePatch<Value>(_ type: Value.Type, forKey key: Key) throws -> Patch<Value>? {
        guard contains(key) else { return nil }
        if try decodeNil(forKey: key) { return .clear }
        return .set(try decode(Value.self, forKey: key))
    }
}

// MARK: - Thinking

/// PI-Desktop's ladder, in order. A model publishes the subset it supports; off = no thinking.
enum ThinkingLevel: String, Codable, CaseIterable, Sendable, Comparable {
    case off, minimal, low, medium, high, xhigh, max

    /// The position on the ladder (off = 0).
    var rank: Int { Self.allCases.firstIndex(of: self) ?? 0 }

    static func < (lhs: ThinkingLevel, rhs: ThinkingLevel) -> Bool { lhs.rank < rhs.rank }
}

/// How a level goes on the wire (the server's adapters): effort, a token budget, or nothing.
enum ThinkingFormat: String, Codable, CaseIterable, Sendable {
    case effort, budget
    /// "none": the model doesn't think (thinkingLevels is [])
    case noThinking = "none"
}

// MARK: - Providers

/// The preset a provider was added from; custom is any OpenAI or Anthropic compatible URL.
enum ProviderKind: String, Codable, CaseIterable, Sendable {
    case openai, anthropic, gemini, stepfun, custom
}

/// The wire protocol for chat: anthropic = Messages API, openai = Chat Completions.
enum ProviderProtocol: String, Codable, CaseIterable, Sendable {
    case openai, anthropic
}

/// Anthropic protocol only: how the key is sent.
enum ProviderAuth: String, Codable, CaseIterable, Sendable {
    case xApiKey = "x-api-key"
    case bearer
}

/// An extra non-secret request header (credentials go in the key).
struct ProviderHeader: Codable, Hashable, Sendable {
    var name: String
    var value: String
}

struct ModelProvider: Decodable, Hashable, Sendable, Identifiable {
    enum Status: String, Decodable, Sendable { case active, failed }
    var id: ID
    var kind: ProviderKind
    var wireProtocol: ProviderProtocol
    var name: String
    var baseUrl: String
    var auth: ProviderAuth?
    /// never the key itself: whether it's set and its last 4 characters
    var key: SecretInfo
    var headers: [ProviderHeader]
    var status: Status
    var error: String?
    var imported: Bool
    var modelCount: Int
    var createdAt: Date
    /// M27: StepFun's site (cn / intl); nil for kinds without regions, an older server, or a value
    /// this build doesn't know (M27VoiceModels.swift).
    var region: ProviderRegion? = nil

    private enum CodingKeys: String, CodingKey {
        case id, kind, wireProtocol = "protocol", name, baseUrl, auth, key, headers, status, error, imported, modelCount, createdAt
        case region
    }
}

extension ModelProvider {
    /// As synthesized, plus a tolerant `region` (missing, null or unknown reads nil).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ID.self, forKey: .id)
        kind = try c.decode(ProviderKind.self, forKey: .kind)
        wireProtocol = try c.decode(ProviderProtocol.self, forKey: .wireProtocol)
        name = try c.decode(String.self, forKey: .name)
        baseUrl = try c.decode(String.self, forKey: .baseUrl)
        auth = try c.decodeIfPresent(ProviderAuth.self, forKey: .auth)
        key = try c.decode(SecretInfo.self, forKey: .key)
        headers = try c.decode([ProviderHeader].self, forKey: .headers)
        status = try c.decode(Status.self, forKey: .status)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        imported = try c.decode(Bool.self, forKey: .imported)
        modelCount = try c.decode(Int.self, forKey: .modelCount)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        region = (try? c.decodeIfPresent(ProviderRegion.self, forKey: .region)) ?? nil
    }
}

/// POST /api/providers: checked by the server (GET /models with the key) before it's saved.
struct CreateModelProviderRequest: Codable, Hashable, Sendable {
    var kind: ProviderKind
    /// custom only
    var wireProtocol: ProviderProtocol? = nil
    var name: String? = nil
    /// presets: optional; custom: required
    var baseUrl: String? = nil
    var auth: ProviderAuth? = nil
    /// sent once; never kept in the app
    var key: String
    var headers: [ProviderHeader]? = nil
    /// M27: StepFun only (the server's default comes from the iPhone's region; others 400 `region`)
    var region: ProviderRegion? = nil

    private enum CodingKeys: String, CodingKey {
        case kind, wireProtocol = "protocol", name, baseUrl, auth, key, headers, region
    }
}

/// PATCH /api/providers/:id: only the fields that change (a new key / URL / auth / headers is checked again).
struct UpdateModelProviderRequest: Codable, Hashable, Sendable {
    var name: String? = nil
    var baseUrl: String? = nil
    var auth: ProviderAuth? = nil
    var key: String? = nil
    var headers: [ProviderHeader]? = nil
    /// M27: StepFun's new site; the stored key is checked against its host (400 `region` = the other site's key)
    var region: ProviderRegion? = nil
}

struct ModelProviderResponse: Decodable, Hashable, Sendable {
    var provider: ModelProvider
}

/// One row of GET /api/providers/:id/remote-models (the provider's own list, enriched by models.dev).
struct RemoteModel: Decodable, Hashable, Sendable, Identifiable {
    enum Source: String, Codable, Sendable {
        case modelsDev = "models.dev"
        case defaults = "default"
    }
    var modelId: String
    var label: String
    var contextWindow: Int
    var maxOutputTokens: Int
    var thinkingLevels: [ThinkingLevel]
    var thinkingFormat: ThinkingFormat
    var tools: Bool
    var vision: Bool
    /// a realtime voice model (M13); never a chat model
    var realtime: Bool
    var source: Source
    /// already in the list: its ModelEntry.id
    var addedAs: ID?
    /// M27: a hint that it can serve cloud dictation (false from an older server); M27VoiceModels.swift
    var transcription: Bool = false

    var id: String { modelId }
}

struct RemoteModelList: Decodable, Hashable, Sendable {
    var models: [RemoteModel]
}

// MARK: - Models

enum ModelPurpose: String, Codable, CaseIterable, Sendable { case chat, realtime }

/// A model in the user's list. Every field can be changed by hand; `edited` lists which were.
struct ModelEntry: Decodable, Hashable, Sendable, Identifiable {
    enum Source: String, Codable, Sendable {
        case modelsDev = "models.dev"
        case defaults = "default"
        case imported, manual
    }
    var id: ID
    var providerId: ID
    var purpose: ModelPurpose
    /// the id sent to the provider
    var modelId: String
    var label: String
    var contextWindow: Int
    var maxOutputTokens: Int
    var thinkingLevels: [ThinkingLevel]
    var thinkingFormat: ThinkingFormat
    /// nil = the highest supported
    var defaultThinking: ThinkingLevel?
    var tools: Bool
    var vision: Bool
    var serverWebTools: Bool
    var promptCaching: Bool
    var source: Source
    var edited: [String]
    var createdAt: Date
}

/// POST /api/models: add one by id (missing numbers come from the remote list / models.dev).
struct CreateModelEntryRequest: Codable, Hashable, Sendable {
    var providerId: ID
    var modelId: String
    var label: String? = nil
    var purpose: ModelPurpose? = nil
}

/// POST /api/models/batch ("Add 3 models") -> ModelsState.
struct CreateModelEntriesRequest: Codable, Hashable, Sendable {
    var providerId: ID
    var modelIds: [String]
}

/// PATCH /api/models/:id: only the changed fields. defaultThinking .clear = back to automatic.
struct UpdateModelEntryRequest: Hashable, Sendable {
    var label: String? = nil
    var contextWindow: Int? = nil
    var maxOutputTokens: Int? = nil
    var thinkingLevels: [ThinkingLevel]? = nil
    var thinkingFormat: ThinkingFormat? = nil
    var defaultThinking: Patch<ThinkingLevel>? = nil
    var tools: Bool? = nil
    var vision: Bool? = nil
    var serverWebTools: Bool? = nil
    var promptCaching: Bool? = nil
}

extension UpdateModelEntryRequest: Codable {
    private enum CodingKeys: String, CodingKey {
        case label, contextWindow, maxOutputTokens, thinkingLevels, thinkingFormat, defaultThinking
        case tools, vision, serverWebTools, promptCaching
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        contextWindow = try c.decodeIfPresent(Int.self, forKey: .contextWindow)
        maxOutputTokens = try c.decodeIfPresent(Int.self, forKey: .maxOutputTokens)
        thinkingLevels = try c.decodeIfPresent([ThinkingLevel].self, forKey: .thinkingLevels)
        thinkingFormat = try c.decodeIfPresent(ThinkingFormat.self, forKey: .thinkingFormat)
        defaultThinking = try c.decodePatch(ThinkingLevel.self, forKey: .defaultThinking)
        tools = try c.decodeIfPresent(Bool.self, forKey: .tools)
        vision = try c.decodeIfPresent(Bool.self, forKey: .vision)
        serverWebTools = try c.decodeIfPresent(Bool.self, forKey: .serverWebTools)
        promptCaching = try c.decodeIfPresent(Bool.self, forKey: .promptCaching)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(label, forKey: .label)
        try c.encodeIfPresent(contextWindow, forKey: .contextWindow)
        try c.encodeIfPresent(maxOutputTokens, forKey: .maxOutputTokens)
        try c.encodeIfPresent(thinkingLevels, forKey: .thinkingLevels)
        try c.encodeIfPresent(thinkingFormat, forKey: .thinkingFormat)
        try c.encodePatch(defaultThinking, forKey: .defaultThinking)
        try c.encodeIfPresent(tools, forKey: .tools)
        try c.encodeIfPresent(vision, forKey: .vision)
        try c.encodeIfPresent(serverWebTools, forKey: .serverWebTools)
        try c.encodeIfPresent(promptCaching, forKey: .promptCaching)
    }
}

struct ModelEntryResponse: Decodable, Hashable, Sendable {
    var model: ModelEntry
}

// MARK: - Defaults

struct ModelDefaults: Codable, Hashable, Sendable {
    /// chat, tasks and routines (a channel can override it); nil only when nothing usable exists
    var defaultModelId: ID?
    var defaultThinking: ThinkingLevel?
    /// memory curation, titles, summaries; nil = the default model
    var utilityModelId: ID?

    private enum CodingKeys: String, CodingKey { case defaultModelId, defaultThinking, utilityModelId }

    init(defaultModelId: ID?, defaultThinking: ThinkingLevel?, utilityModelId: ID?) {
        self.defaultModelId = defaultModelId
        self.defaultThinking = defaultThinking
        self.utilityModelId = utilityModelId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        defaultModelId = try c.decodeIfPresent(ID.self, forKey: .defaultModelId)
        defaultThinking = try c.decodeIfPresent(ThinkingLevel.self, forKey: .defaultThinking)
        utilityModelId = try c.decodeIfPresent(ID.self, forKey: .utilityModelId)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(defaultModelId, forKey: .defaultModelId)
        try c.encode(defaultThinking, forKey: .defaultThinking)
        try c.encode(utilityModelId, forKey: .utilityModelId)
    }
}

/// PUT /api/model-defaults: only the fields that change (.clear sends null) -> ModelsState.
struct UpdateModelDefaultsRequest: Hashable, Sendable {
    var defaultModelId: Patch<ID>? = nil
    var defaultThinking: Patch<ThinkingLevel>? = nil
    var utilityModelId: Patch<ID>? = nil
}

extension UpdateModelDefaultsRequest: Codable {
    private enum CodingKeys: String, CodingKey { case defaultModelId, defaultThinking, utilityModelId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        defaultModelId = try c.decodePatch(ID.self, forKey: .defaultModelId)
        defaultThinking = try c.decodePatch(ThinkingLevel.self, forKey: .defaultThinking)
        utilityModelId = try c.decodePatch(ID.self, forKey: .utilityModelId)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodePatch(defaultModelId, forKey: .defaultModelId)
        try c.encodePatch(defaultThinking, forKey: .defaultThinking)
        try c.encodePatch(utilityModelId, forKey: .utilityModelId)
    }
}

/// GET /api/models: the whole configuration page in one answer.
struct ModelsState: Decodable, Hashable, Sendable {
    var providers: [ModelProvider]
    var models: [ModelEntry]
    var defaults: ModelDefaults
    /// a usable default chat model is set up (also Me.features.models)
    var configured: Bool
}

// MARK: - model_error

/// A failed turn: the phrase, the model that failed, Retry (action "retry", optional modelId =
/// "Switch model"). retry false: nothing to retry with (system.no_model -> "Set up models").
struct ModelErrorPayload: Decodable, Hashable, Sendable {
    enum State: String, Decodable, Sendable { case open, retrying, dismissed }
    var phrase: Phrase
    /// the ModelEntry that failed (nil when none was usable)
    var modelId: ID?
    var modelLabel: String?
    var runId: ID
    var retry: Bool
    var state: State
}
