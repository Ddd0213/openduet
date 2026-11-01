// Gemini Live (BidiGenerateContentConstrained, a one-use token in ?access_token=): `setup` →
// `setupComplete`; the microphone as `realtimeInput.audio` (16 kHz PCM16); the voice in
// `serverContent.modelTurn` (24 kHz), both sides' transcription, `turnComplete`, `interrupted`;
// `toolCall.functionCalls` answered by `toolResponse.functionResponses`; `sessionResumptionUpdate`
// and `goAway` for a resumed session. Close 1007 / 1008 = the session was refused. Pure.
import Foundation

struct GeminiCodec: VoiceCodec {
    var engine: VoiceEngineKind { .gemini }
    var inputRate: Int { 16000 }
    var outputRate: Int { 24000 }

    func request(url: String, credential: VoiceCredential) -> URLRequest? {
        guard var components = URLComponents(string: url) else { return nil }
        var query = components.queryItems ?? []
        query.removeAll { $0.name == "access_token" }
        query.append(URLQueryItem(name: "access_token", value: credential.secret))
        components.queryItems = query
        // "+" is literal in a query to URLComponents but a space to Google's parser.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let target = components.url else { return nil }
        return URLRequest(url: target)
    }

    func setup(_ config: VoiceSessionConfig) -> [String] {
        let model = config.model.hasPrefix("models/") ? config.model : "models/\(config.model)"
        let voice: JSONValue = ["voiceConfig": ["prebuiltVoiceConfig": ["voiceName": .string(config.voice)]]]
        let generation: JSONValue = ["responseModalities": ["AUDIO"], "speechConfig": voice]
        let resumption: JSONValue = config.resumeHandle.map { ["handle": .string($0)] } ?? [:]
        var setup: [String: JSONValue] = [
            "model": .string(model),
            "generationConfig": generation,
            "systemInstruction": ["parts": [["text": .string(config.instructions)]]],
            // What both sides say, for the transcript and the captions.
            "inputAudioTranscription": [:],
            "outputAudioTranscription": [:],
            // Audio sessions are otherwise capped at 15 minutes.
            "contextWindowCompression": ["slidingWindow": [:]],
            "sessionResumption": resumption,
        ]
        if !config.tools.isEmpty {
            setup["tools"] = [["functionDeclarations": .array(config.tools.map(Self.declaration))]]
        }
        return [JSONValue.object(["setup": .object(setup)]).frame]
    }

    func decode(_ frame: String) -> [EngineEvent] {
        guard let message = JSONValue.parse(frame), message.object != nil else { return [] }
        var events: [EngineEvent] = []
        if message["setupComplete"] != nil { events.append(.ready) }
        if let content = message["serverContent"] {
            if let text = content["inputTranscription"]?["text"]?.string, !text.isEmpty {
                events.append(.inputText(text, final: false))
            }
            for part in content["modelTurn"]?["parts"]?.array ?? [] {
                guard let inline = part["inlineData"], let base64 = inline["data"]?.string,
                      let pcm = Data(base64Encoded: base64), !pcm.isEmpty else { continue }
                events.append(.audio(pcm, rate: Self.rate(of: inline["mimeType"]?.string) ?? outputRate))
            }
            if let text = content["outputTranscription"]?["text"]?.string, !text.isEmpty {
                events.append(.outputText(text, final: false))
            }
            if content["interrupted"]?.bool == true { events.append(.interrupted) }
            if content["turnComplete"]?.bool == true { events.append(.turnComplete) }
        }
        for call in message["toolCall"]?["functionCalls"]?.array ?? [] {
            guard let id = call["id"]?.string, let name = call["name"]?.string else { continue }
            let arguments = call["args"].flatMap { $0.object == nil ? nil : $0 } ?? [:]
            events.append(.toolCall(id: id, name: name, argumentsJSON: arguments.text))
        }
        if let update = message["sessionResumptionUpdate"], update["resumable"]?.bool != false,
           let handle = update["newHandle"]?.string, !handle.isEmpty {
            events.append(.resumeHandle(handle))
        }
        if message["goAway"] != nil { events.append(.goAway) }
        return events
    }

    func audio(_ pcm: Data) -> String {
        // Base64 needs no JSON escaping; built by hand, it's sent 50 times a second.
        "{\"realtimeInput\":{\"audio\":{\"data\":\"\(pcm.base64EncodedString())\",\"mimeType\":\"audio/pcm;rate=\(inputRate)\"}}}"
    }

    func toolResult(id: String, name: String, result: String) -> [String] {
        let response: JSONValue = ["id": .string(id), "name": .string(name), "response": ["result": .string(result)]]
        return [JSONValue.object(["toolResponse": ["functionResponses": [response]]]).frame]
    }

    func say(_ text: String) -> [String] {
        let turn: JSONValue = ["role": "user", "parts": [["text": .string(text)]]]
        return [JSONValue.object(["clientContent": ["turns": [turn], "turnComplete": true]]).frame]
    }

    /// A toolResponse or a clientContent turn is answered without being asked.
    func respond() -> [String] { [] }

    /// Gemini stops the voice itself when it hears the user (`interrupted`).
    func cancelResponse() -> [String] { [] }

    /// Gemini has no way to take a turn back (and no StepFun-style VAD that hears the echo).
    func forget(item: String) -> [String] { [] }

    func isFatal(closeCode: Int) -> Bool { closeCode == 1007 || closeCode == 1008 }

    // MARK: - Helpers

    /// "audio/pcm;rate=24000" → 24000.
    static func rate(of mimeType: String?) -> Int? {
        guard let mimeType, let range = mimeType.range(of: "rate=") else { return nil }
        return Int(mimeType[range.upperBound...].prefix { $0.isNumber })
    }

    /// A tool as Gemini declares functions: the schema's types upper-case (OBJECT, STRING) and
    /// no `parameters` for a tool without arguments (Gemini refuses an empty object schema).
    static func declaration(_ tool: VoiceTool) -> JSONValue {
        var out: [String: JSONValue] = ["name": .string(tool.name), "description": .string(tool.description)]
        if let properties = tool.parameters["properties"]?.object, !properties.isEmpty {
            out["parameters"] = schema(tool.parameters)
        }
        return .object(out)
    }

    static func schema(_ value: JSONValue) -> JSONValue {
        guard case .object(let object) = value else { return value }
        var out: [String: JSONValue] = [:]
        for (key, item) in object {
            switch (key, item) {
            case ("type", .string(let type)): out[key] = .string(type.uppercased())
            case ("properties", .object(let properties)): out[key] = .object(properties.mapValues(schema))
            case ("items", _): out[key] = schema(item)
            default: out[key] = item
            }
        }
        return .object(out)
    }
}
