// StepFun Realtime (wss://api.stepfun.com/v1/realtime?model=…, `Authorization: Bearer <key>`;
// there's no short-lived credential). OpenAI-realtime-like: `session.update` (text + audio, PCM16
// 24 kHz both ways, server VAD, input transcription), `input_audio_buffer.append`, and the server's
// `session.*`, `input_audio_buffer.speech_started / speech_stopped`, `response.created`,
// `response.audio.delta`, `response.audio_transcript.delta / done`,
// `conversation.item.input_audio_transcription.completed`, `response.function_call_arguments.done`,
// `response.done`, `response.cancelled`, `error`. A tool's answer is a `function_call_output`
// item; `response.create` asks for the voice's answer (one response at a time: CallCore waits for
// the last one's `response.done`); barge-in is `response.cancel`; the voice's own echo, heard as
// the user, is taken out with `conversation.item.delete`. Pure.
import Foundation

struct StepCodec: VoiceCodec {
    var engine: VoiceEngineKind { .stepfun }
    var inputRate: Int { 24000 }
    var outputRate: Int { 24000 }

    func request(url: String, credential: VoiceCredential) -> URLRequest? {
        guard let target = URL(string: url), target.scheme == "wss" || target.scheme == "ws" else { return nil }
        var request = URLRequest(url: target)
        request.setValue("Bearer \(credential.secret)", forHTTPHeaderField: "Authorization")
        return request
    }

    func setup(_ config: VoiceSessionConfig) -> [String] {
        var session: [String: JSONValue] = [
            "modalities": ["text", "audio"],
            "instructions": .string(config.instructions),
            "voice": .string(config.voice),
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm16",
            "turn_detection": Self.turnDetection,
            "input_audio_transcription": ["model": "step-asr"],
        ]
        if !config.tools.isEmpty {
            session["tools"] = .array(config.tools.map(Self.declaration))
        }
        return [JSONValue.object(["type": "session.update", "session": .object(session)]).frame]
    }

    func decode(_ frame: String) -> [EngineEvent] {
        guard let message = JSONValue.parse(frame), let type = message["type"]?.string else { return [] }
        switch type {
        case "session.created", "session.updated":
            return [.ready]
        case "input_audio_buffer.speech_started":
            return [.speechStarted]
        case "input_audio_buffer.speech_stopped":
            return [.speechStopped]
        case "response.created":
            return [.responseStarted]
        case "response.audio.delta", "response.output_audio.delta":
            guard let base64 = message["delta"]?.string, let pcm = Data(base64Encoded: base64), !pcm.isEmpty else { return [] }
            return [.audio(pcm, rate: outputRate)]
        case "response.audio_transcript.delta", "response.output_audio_transcript.delta":
            guard let text = message["delta"]?.string, !text.isEmpty else { return [] }
            return [.outputText(text, final: false)]
        case "response.audio_transcript.done", "response.output_audio_transcript.done":
            guard let text = message["transcript"]?.string else { return [] }
            return [.outputText(text, final: true)]
        case "conversation.item.input_audio_transcription.completed":
            guard let text = message["transcript"]?.string else { return [] }
            let item = message["item_id"]?.string.map { [EngineEvent.inputItem($0)] } ?? []
            return item + [.inputText(text, final: true)]
        case "response.function_call_arguments.done":
            guard let id = message["call_id"]?.string, let name = message["name"]?.string else { return [] }
            let arguments = message["arguments"]?.string ?? "{}"
            return [.toolCall(id: id, name: name, argumentsJSON: arguments.isEmpty ? "{}" : arguments)]
        case "response.done", "response.cancelled":
            return [.turnComplete]
        case "error":
            let error = message["error"]
            let text = error?["message"]?.string ?? error?["type"]?.string ?? "StepFun reported an error."
            return [.error(text, fatal: false)]
        default:
            return []
        }
    }

    func audio(_ pcm: Data) -> String {
        // Base64 needs no JSON escaping; built by hand, it's sent 50 times a second.
        "{\"audio\":\"\(pcm.base64EncodedString())\",\"type\":\"input_audio_buffer.append\"}"
    }

    func toolResult(id: String, name: String, result: String) -> [String] {
        let item: JSONValue = ["type": "function_call_output", "call_id": .string(id), "output": .string(result)]
        return [JSONValue.object(["type": "conversation.item.create", "item": item]).frame]
    }

    func say(_ text: String) -> [String] {
        let item: JSONValue = [
            "type": "message", "role": "user",
            "content": [["type": "input_text", "text": .string(text)]],
        ]
        return [JSONValue.object(["type": "conversation.item.create", "item": item]).frame]
    }

    func respond() -> [String] { [JSONValue.object(["type": "response.create"]).frame] }

    func cancelResponse() -> [String] { [JSONValue.object(["type": "response.cancel"]).frame] }

    func forget(item: String) -> [String] {
        [JSONValue.object(["type": "conversation.item.delete", "item_id": .string(item)]).frame]
    }

    /// The server VAD, less eager than StepFun's defaults (energy 2500, 100 ms of silence, 500 ms
    /// before): the loudspeaker's echo and room noise tripped it and cut the voice short, and a
    /// pause for breath ended the user's turn.
    static let turnDetection: JSONValue = [
        "type": "server_vad",
        "energy_awakeness_threshold": 3500,
        "silence_duration_ms": 600,
        "prefix_padding_ms": 300,
    ]

    /// 1008 (policy: a refused key) and 1007 (a refused session) won't go better on a retry.
    func isFatal(closeCode: Int) -> Bool { closeCode == 1007 || closeCode == 1008 }

    /// The layout of the provider facts (`{type: function, function: {name, description,
    /// parameters}}`); the parameters go as the server sent them.
    static func declaration(_ tool: VoiceTool) -> JSONValue {
        [
            "type": "function",
            "function": [
                "name": .string(tool.name),
                "description": .string(tool.description),
                "parameters": tool.parameters,
            ],
        ]
    }
}
