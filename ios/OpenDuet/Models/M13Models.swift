// Realtime voice calls (backend/src/contract/m13.ts). The phone talks to Gemini Live or StepFun
// Realtime directly; the server owns the call: the voice's instructions and tools, the hand-offs
// to the assistant, the transcript and the call's one line in the chat (.pi/handoff/m13-contract.md).
import Foundation

// MARK: - Any JSON

/// A JSON value kept as it came (a tool's JSON Schema, a tool call's arguments), so it can go back
/// to the provider unchanged.
enum JSONValue: Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    subscript(key: String) -> JSONValue? {
        if case .object(let object) = self { object[key] } else { nil }
    }

    var string: String? { if case .string(let value) = self { value } else { nil } }
    var bool: Bool? { if case .bool(let value) = self { value } else { nil } }
    var number: Double? { if case .number(let value) = self { value } else { nil } }
    var int: Int? { number.flatMap { $0.isFinite ? Int(exactly: $0.rounded()) : nil } }
    var array: [JSONValue]? { if case .array(let value) = self { value } else { nil } }
    var object: [String: JSONValue]? { if case .object(let value) = self { value } else { nil } }

    /// Parses JSON text; nil when it isn't JSON.
    static func parse(_ text: String) -> JSONValue? {
        try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    /// Compact JSON text with sorted keys (stable for tests and for the wire).
    var text: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(self) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }
}

extension JSONValue: Codable {
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let value = try? c.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? c.decode(Double.self) {
            self = .number(value)
        } else if let value = try? c.decode(String.self) {
            self = .string(value)
        } else if let value = try? c.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let value): try c.encode(value)
        case .number(let value):
            // Whole numbers go out as integers (1, not 1.0).
            if value.isFinite, value == value.rounded(), abs(value) < 9.0e15 {
                try c.encode(Int64(value))
            } else {
                try c.encode(value)
            }
        case .string(let value): try c.encode(value)
        case .array(let value): try c.encode(value)
        case .object(let value): try c.encode(value)
        }
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
    init(stringLiteral value: String) { self = .string(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(integerLiteral value: Int) { self = .number(Double(value)) }
    init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
    }
    init(nilLiteral: ()) { self = .null }
}

// MARK: - Calls

enum VoiceEngineKind: String, Codable, CaseIterable, Sendable {
    case gemini, stepfun
}

/// A transcript line, as the phone heard it. `id` is the phone's (a line is kept once per id).
struct CallLine: Codable, Hashable, Sendable, Identifiable {
    enum From: String, Codable, Sendable { case user, voice }
    var id: String
    var from: From
    var text: String
    var at: Date
}

struct Call: Decodable, Hashable, Sendable, Identifiable {
    enum Status: String, Decodable, Sendable { case open, ended }
    var id: ID
    var channelId: ID
    var engine: VoiceEngineKind
    /// the ModelEntry (purpose realtime) and the id sent to the provider
    var modelEntryId: ID
    var modelId: String
    var voice: String
    var status: Status
    var startedAt: Date
    var endedAt: Date?
    var seconds: Int
    /// a few words from the background model; "" until the call ends
    var title: String
}

/// One function the voice model can call; the phone declares it to the provider as it is.
struct VoiceTool: Decodable, Hashable, Sendable {
    /// send_to_assistant, assistant_status, stop_assistant, search_memory (M29; servers before it sent
    /// send_to_claude, claude_status, stop_claude). Kept as a string so any server's tool decodes; the
    /// phone passes the name through and the server answers an unknown one itself.
    var name: String
    var description: String
    /// JSON Schema of the arguments, sent back to the provider unchanged
    var parameters: JSONValue
}

/// How the phone connects. Gemini: a one-use token. StepFun: the key itself. Either lives only in
/// the engine's memory for the call; its description never shows the value.
enum VoiceCredential: Decodable, Hashable, Sendable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable {
    case token(String, expiresAt: Date)
    case key(String)

    /// The secret, for the socket's URL or header only.
    var secret: String {
        switch self {
        case .token(let value, _), .key(let value): value
        }
    }

    var description: String { "<credential>" }
    var debugDescription: String { "<credential>" }
    var customMirror: Mirror { Mirror(self, children: [], displayStyle: .enum) }

    private enum CodingKeys: String, CodingKey { case kind, value, expiresAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let value = try c.decode(String.self, forKey: .value)
        switch try c.decode(String.self, forKey: .kind) {
        case "token": self = .token(value, expiresAt: try c.decode(Date.self, forKey: .expiresAt))
        case "key": self = .key(value)
        case let kind:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown credential kind \(kind)")
        }
    }
}

/// POST /api/calls (start, or again with callId to resume / reconnect the same call).
struct StartCallRequest: Codable, Hashable, Sendable {
    var channelId: ID
    /// resume: the open call (a fresh credential, and "this call so far" in the instructions)
    var callId: ID?
    /// a realtime ModelEntry; default: the voice settings' model
    var modelId: ID?
    var voice: String?
    /// the phone's language, for speaking before the user has
    var language: String?
}

struct StartCallResponse: Decodable, Hashable, Sendable, CustomStringConvertible {
    var call: Call
    /// the provider's model id and the WebSocket URL to open (StepFun: with ?model=)
    var model: String
    var url: String
    var credential: VoiceCredential
    var instructions: String
    var tools: [VoiceTool]

    var description: String { "StartCallResponse(call: \(call.id), engine: \(call.engine.rawValue), credential: <credential>)" }
}

/// POST /api/calls/:id/lines -> 204.
struct CallLinesRequest: Codable, Hashable, Sendable {
    var lines: [CallLine]
}

/// POST /api/calls/:id/tool: one of the voice's tool calls; lines not sent yet go with it.
struct CallToolRequest: Codable, Hashable, Sendable {
    var name: String
    var arguments: [String: JSONValue] = [:]
    var lines: [CallLine] = []
}

extension CallToolRequest {
    private enum CodingKeys: String, CodingKey { case name, arguments, lines }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        arguments = try c.decodeIfPresent([String: JSONValue].self, forKey: .arguments) ?? [:]
        lines = try c.decodeIfPresent([CallLine].self, forKey: .lines) ?? []
    }
}

/// The tool's answer, for the voice model (a failure is an answer too).
struct CallToolResponse: Codable, Hashable, Sendable {
    var result: String
}

/// POST /api/calls/:id/end -> MessageActionResponse (the `call` message). Ending twice is fine.
struct EndCallRequest: Codable, Hashable, Sendable {
    var seconds: Int
    var lines: [CallLine] = []
}

extension EndCallRequest {
    private enum CodingKeys: String, CodingKey { case seconds, lines }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seconds = try c.decode(Int.self, forKey: .seconds)
        lines = try c.decodeIfPresent([CallLine].self, forKey: .lines) ?? []
    }
}

/// GET /api/calls/:id: the whole conversation (opened from the call's line).
struct CallDetail: Decodable, Hashable, Sendable {
    var call: Call
    var lines: [CallLine]
    /// what the call handed to the assistant and the assistant's replies in those turns, oldest first
    var messages: [Message]
}

// MARK: - Voice settings

/// Everything → Voice.
struct VoiceSettings: Decodable, Hashable, Sendable {
    struct Voices: Decodable, Hashable, Sendable {
        var gemini: [String]
        var stepfun: [String]

        subscript(engine: VoiceEngineKind) -> [String] {
            switch engine {
            case .gemini: gemini
            case .stepfun: stepfun
            }
        }
    }

    /// a realtime ModelEntry (Gemini or StepFun provider), or null
    var modelId: ID?
    var voice: String?
    /// M27: stepfun is the mainland list; a provider's own (its region's) is VoiceProvider.voices
    var voices: Voices
    /// a realtime model whose provider has a key (also Me.features.voice)
    var configured: Bool
    /// M27 (M27VoiceModels.swift, tolerant decoding): the user's Gemini / StepFun providers, oldest first
    var providers: [VoiceProvider] = []
    /// M27: what adding a Gemini / StepFun provider needs (its regions)
    var presets: [VoiceProviderPreset] = []
    /// M27: the composer microphone's recognizer (an older server: Apple's, the default)
    var dictation: DictationSettings = .standard
}

/// PUT /api/voice-settings -> VoiceSettings. nil = unchanged, .clear = back to the default.
struct UpdateVoiceSettingsRequest: Hashable, Sendable {
    var modelId: Patch<ID>?
    var voice: Patch<String>?
    /// M27: the recognizer's fields that change
    var dictation: UpdateDictationSettingsRequest? = nil
}

extension UpdateVoiceSettingsRequest: Codable {
    private enum CodingKeys: String, CodingKey { case modelId, voice, dictation }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        modelId = try c.decodePatch(ID.self, forKey: .modelId)
        voice = try c.decodePatch(String.self, forKey: .voice)
        dictation = try c.decodeIfPresent(UpdateDictationSettingsRequest.self, forKey: .dictation)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodePatch(modelId, forKey: .modelId)
        try c.encodePatch(voice, forKey: .voice)
        try c.encodeIfPresent(dictation, forKey: .dictation)
    }
}

// MARK: - Cues and the chat line

/// SSE `call` event: what the voice should say. reply = the assistant's final reply (shortened for speech),
/// notice = a card waiting for the user or a failure, progress = the assistant's activity. `seq` rises
/// through the call; repeats are skipped.
struct CallCue: Decodable, Hashable, Sendable {
    enum Kind: String, Decodable, Sendable { case reply, notice, progress }
    var callId: ID
    var kind: Kind
    var text: String
    var seq: Int64
}

/// A voice call's one line in the chat ("Voice call · 3 min"); tapping opens GET /api/calls/:id.
struct CallPayload: Decodable, Hashable, Sendable {
    var callId: ID
    var seconds: Int
    /// a few words in the user's language; "" when there was nothing to name
    var title: String
    var lineCount: Int
}
