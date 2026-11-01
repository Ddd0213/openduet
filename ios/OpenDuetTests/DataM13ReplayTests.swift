// Voice call replay tests: each provider's event stream, as its docs describe it (there are no
// real recordings), fed through a ScriptedSocket into CallCore, checking what the phone sent and
// did. Fake server, fake clock, fake speaker: no network, no audio.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private enum Gemini {
    static var setupComplete: [String: Any] { ["setupComplete": [String: Any]()] }
    static func heard(_ text: String) -> [String: Any] { ["serverContent": ["inputTranscription": ["text": text]]] }
    static func said(_ text: String) -> [String: Any] { ["serverContent": ["outputTranscription": ["text": text]]] }
    static func audio(_ bytes: Int = 960) -> [String: Any] {
        let part: [String: Any] = ["inlineData": ["mimeType": "audio/pcm;rate=24000", "data": Data(count: bytes).base64EncodedString()]]
        return ["serverContent": ["modelTurn": ["parts": [part]]]]
    }
    static var turnComplete: [String: Any] { ["serverContent": ["turnComplete": true]] }
    static var interrupted: [String: Any] { ["serverContent": ["interrupted": true]] }
    static func toolCall(_ id: String, _ name: String, _ args: [String: Any]) -> [String: Any] {
        ["toolCall": ["functionCalls": [["id": id, "name": name, "args": args]]]]
    }
}

private enum Step {
    static func event(_ type: String, _ extra: [String: Any] = [:]) -> [String: Any] {
        extra.merging(["type": type, "event_id": "evt_\(type)"]) { first, _ in first }
    }
    static func audio(_ bytes: Int = 960) -> [String: Any] {
        event("response.audio.delta", ["delta": Data(count: bytes).base64EncodedString(), "response_id": "resp_1"])
    }
}

private func object(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }
private func list(_ value: Any?) -> [[String: Any]] { value as? [[String: Any]] ?? [] }

@MainActor
@Suite("Voice calls: Gemini Live replay")
struct UIM13GeminiReplayTests {
    @Test("The setup message: model, audio out with the voice, instructions, tools, both transcriptions")
    func setup() async {
        let rig = CallRig(GeminiCodec())
        rig.begin(M13Fx.started(.gemini, secret: "auth_tokens/one"))
        let query = rig.socket.request.url?.query ?? ""
        #expect(query.contains("access_token=auth_tokens/one"))
        #expect(rig.socket.request.value(forHTTPHeaderField: "Authorization") == nil)

        let setup = object(rig.socket.sentJSON.first?["setup"])
        #expect(setup["model"] as? String == "models/gemini-live-2.5-flash-preview")
        let generation = object(setup["generationConfig"])
        #expect(generation["responseModalities"] as? [String] == ["AUDIO"])
        let voice = object(object(object(generation["speechConfig"])["voiceConfig"])["prebuiltVoiceConfig"])
        #expect(voice["voiceName"] as? String == "Puck")
        #expect(list(object(setup["systemInstruction"])["parts"]).first?["text"] as? String == "You relay for Claude.")
        #expect(setup["inputAudioTranscription"] != nil)
        #expect(setup["outputAudioTranscription"] != nil)
        #expect(object(setup["sessionResumption"]).isEmpty)
        let declarations = list(list(setup["tools"]).first?["functionDeclarations"])
        #expect(declarations.map { $0["name"] as? String } == ["send_to_assistant", "assistant_status"])
        let send = object(declarations.first?["parameters"])
        #expect(send["type"] as? String == "OBJECT")
        #expect(object(object(send["properties"])["text"])["type"] as? String == "STRING")
        #expect(declarations.last?["parameters"] == nil)

        rig.socket.push(Gemini.setupComplete)
        await rig.settle()
        #expect(rig.readyCount == 1)
        #expect(rig.core.phase == .listening)
        await rig.core.end()
    }

    @Test("Transcription pieces become two CallLines with stable ids")
    func transcription() async {
        let rig = CallRig(GeminiCodec())
        rig.begin(M13Fx.started(.gemini, secret: "t"))
        rig.socket.push(Gemini.setupComplete)
        for frame in [Gemini.heard("Can you ask"), Gemini.heard(" Claude to reorder"), Gemini.heard(" the pads?"),
                      Gemini.audio(), Gemini.said("Sure, I'll"), Gemini.said(" pass that on."), Gemini.turnComplete] {
            rig.socket.push(frame)
        }
        await rig.settle()
        let lines = rig.core.transcript.lines
        #expect(lines.map(\.from) == [.user, .voice])
        #expect(lines.map(\.text) == ["Can you ask Claude to reorder the pads?", "Sure, I'll pass that on."])
        #expect(lines.map(\.id) == ["line-1", "line-2"])
        #expect(rig.core.phase == .speaking)
        rig.playback.drain()
        #expect(rig.core.phase == .listening)

        // Batched: nothing goes before 3 s, then both lines in one request.
        rig.core.tick()
        await rig.settle()
        #expect(rig.backend.lineBatches.isEmpty)
        rig.clock.advance(3)
        rig.core.tick()
        await rig.settle()
        #expect(rig.backend.lineBatches.map { $0.map(\.id) } == [["line-1", "line-2"]])
        await rig.core.end()
    }

    @Test("A tool call goes to /tool and its answer comes back as toolResponse with the same id")
    func toolCall() async {
        let rig = CallRig(GeminiCodec())
        rig.begin(M13Fx.started(.gemini, secret: "t"))
        rig.socket.push(Gemini.setupComplete)
        rig.socket.push(Gemini.heard("Reorder the brake pads."))
        rig.socket.push(Gemini.toolCall("fc_1", "send_to_assistant", ["text": "Reorder the brake pads."]))
        await rig.settle()

        #expect(rig.backend.tools.count == 1)
        let tool = rig.backend.tools[0]
        #expect(tool.name == "send_to_assistant")
        #expect(tool.arguments == ["text": .string("Reorder the brake pads.")])
        #expect(tool.lines.map(\.text) == ["Reorder the brake pads."])
        let response = rig.socket.sentJSON.last.map { object($0["toolResponse"]) } ?? [:]
        let answer = list(response["functionResponses"]).first ?? [:]
        #expect(answer["id"] as? String == "fc_1")
        #expect(answer["name"] as? String == "send_to_assistant")
        #expect(object(answer["response"])["result"] as? String == "Sent to Claude.")
        await rig.core.end()
    }

    @Test("A failed /tool is answered with a short failure, and its lines are kept")
    func toolFailure() async {
        let rig = CallRig(GeminiCodec())
        rig.backend.toolAnswer = .failure(.unreachable)
        rig.begin(M13Fx.started(.gemini, secret: "t"))
        rig.socket.push(Gemini.setupComplete)
        rig.socket.push(Gemini.heard("What's Claude doing?"))
        rig.socket.push(Gemini.toolCall("fc_2", "assistant_status", [:]))
        await rig.settle()
        let answer = list(object(rig.socket.sentJSON.last?["toolResponse"])["functionResponses"]).first ?? [:]
        #expect(answer["id"] as? String == "fc_2")
        let result = object(answer["response"])["result"] as? String ?? ""
        #expect(result.hasPrefix("That didn't go through"))
        #expect(rig.core.transcript.unsent.map(\.text) == ["What's Claude doing?"])
        await rig.core.end()
        #expect(rig.backend.ends.first?.lines.map(\.text) == ["What's Claude doing?"])
    }

    @Test("interrupted flushes what's queued to play")
    func interrupted() async {
        let rig = CallRig(GeminiCodec())
        rig.begin(M13Fx.started(.gemini, secret: "t"))
        rig.socket.push(Gemini.setupComplete)
        rig.socket.push(Gemini.audio())
        rig.socket.push(Gemini.audio())
        await rig.settle()
        #expect(rig.playback.queued == 2)
        #expect(rig.core.phase == .speaking)
        rig.socket.push(Gemini.interrupted)
        await rig.settle()
        #expect(rig.playback.flushes == 1)
        #expect(rig.playback.queued == 0)
        #expect(rig.core.phase == .listening)
        await rig.core.end()
    }

    @Test("sessionResumptionUpdate then goAway: a new session at once, with the handle and a fresh token")
    func goAway() async {
        let rig = CallRig(GeminiCodec())
        rig.backend.startAnswers = [M13Fx.started(.gemini, secret: "auth_tokens/two")]
        rig.begin(M13Fx.started(.gemini, secret: "auth_tokens/one"))
        let first = rig.socket
        first.push(Gemini.setupComplete)
        first.push(["sessionResumptionUpdate": ["newHandle": "handle-7", "resumable": true]])
        first.push(["goAway": ["timeLeft": "10s"]])
        await rig.until { rig.sockets.sockets.count == 2 }

        #expect(first.closedByPhone)
        #expect(rig.backend.starts.count == 1)
        #expect(rig.backend.starts.first?.callId == "call_1")
        #expect(rig.backend.starts.first?.channelId == "ch_shop")
        #expect(rig.clock.sleeps.isEmpty)
        let second = rig.socket
        #expect(second.request.url?.query?.contains("access_token=auth_tokens/two") == true)
        let setup = object(second.sentJSON.first?["setup"])
        #expect(object(setup["sessionResumption"])["handle"] as? String == "handle-7")
        #expect(rig.core.phase == .reconnecting)
        second.push(Gemini.setupComplete)
        await rig.settle()
        #expect(rig.core.phase == .listening)
        #expect(rig.readyCount == 1)
        await rig.core.end()
    }

    @Test("Close 1008: failed, no retry, ended through /end")
    func policyClose() async {
        let rig = CallRig(GeminiCodec())
        rig.backend.startAnswers = [M13Fx.started(.gemini, secret: "t2")]
        rig.begin(M13Fx.started(.gemini, secret: "t"))
        rig.socket.push(Gemini.setupComplete)
        await rig.settle()
        rig.socket.drop(code: 1008, reason: "API key not valid.")
        await rig.until { rig.backend.ends.count == 1 }
        #expect(rig.core.phase == .failed(reason: "API key not valid.", kind: .provider))
        #expect(rig.backend.starts.isEmpty)
        #expect(rig.sockets.sockets.count == 1)
        #expect(rig.backend.ends.count == 1)
        #expect(rig.ended.count == 1)
    }

    @Test("Muted: the microphone isn't sent")
    func muted() async {
        let rig = CallRig(GeminiCodec())
        rig.begin(M13Fx.started(.gemini, secret: "t"))
        rig.socket.push(Gemini.setupComplete)
        await rig.settle()
        rig.core.sendAudio(Data(count: 640))
        rig.core.muted = true
        rig.core.sendAudio(Data(count: 640))
        let audio = rig.socket.sentJSON.filter { $0["realtimeInput"] != nil }
        #expect(audio.count == 1)
        let input = object(object(audio.first?["realtimeInput"])["audio"])
        #expect(input["mimeType"] as? String == "audio/pcm;rate=16000")
        #expect(input["data"] as? String == Data(count: 640).base64EncodedString())
        await rig.core.end()
    }
}

@MainActor
@Suite("Voice calls: StepFun Realtime replay")
struct UIM13StepReplayTests {
    @Test("session.update with the tools, the key only in the Authorization header")
    func setup() async {
        let rig = CallRig(StepCodec())
        rig.begin(M13Fx.started(.stepfun, secret: "step-secret"))
        #expect(rig.socket.request.value(forHTTPHeaderField: "Authorization") == "Bearer step-secret")
        #expect(rig.socket.request.url?.absoluteString == "wss://api.stepfun.com/v1/realtime?model=step-audio-2")

        let update = rig.socket.sentJSON.first ?? [:]
        #expect(update["type"] as? String == "session.update")
        let session = object(update["session"])
        #expect(session["modalities"] as? [String] == ["text", "audio"])
        #expect(session["instructions"] as? String == "You relay for Claude.")
        #expect(session["voice"] as? String == "qingchunshaonv")
        #expect(session["input_audio_format"] as? String == "pcm16")
        #expect(session["output_audio_format"] as? String == "pcm16")
        let vad = object(session["turn_detection"])
        #expect(vad["type"] as? String == "server_vad")
        // Less eager than StepFun's defaults (2500 / 100 ms / 500 ms): the echo cut the voice short.
        #expect(vad["energy_awakeness_threshold"] as? Int == 3500)
        #expect(vad["silence_duration_ms"] as? Int == 600)
        #expect(vad["prefix_padding_ms"] as? Int == 300)
        #expect(session["input_audio_transcription"] != nil)
        let tools = list(session["tools"])
        #expect(tools.count == 2)
        #expect(tools.allSatisfy { $0["type"] as? String == "function" })
        let first = object(tools.first?["function"])
        #expect(first["name"] as? String == "send_to_assistant")
        // The parameters go as the server sent them (lower-case JSON Schema).
        let parameters = object(first["parameters"])
        #expect(parameters["type"] as? String == "object")
        #expect(parameters["required"] as? [String] == ["text"])

        rig.socket.push(Step.event("session.created", ["session": ["id": "sess_1"]]))
        await rig.settle()
        #expect(rig.core.phase == .listening)
        rig.core.sendAudio(Data(count: 1920))
        let append = rig.socket.sentJSON.last ?? [:]
        #expect(append["type"] as? String == "input_audio_buffer.append")
        #expect(append["audio"] as? String == Data(count: 1920).base64EncodedString())
        await rig.core.end()
    }

    @Test("speech_started while the reply arrives: the voice is lowered; their words cut it (flushed, response.cancel)")
    func bargeIn() async {
        let rig = CallRig(StepCodec())
        rig.begin(M13Fx.started(.stepfun, secret: "k"))
        rig.socket.push(Step.event("session.created"))
        rig.socket.push(Step.event("response.created"))
        rig.socket.push(Step.audio())
        rig.socket.push(Step.event("response.audio_transcript.delta", ["delta": "Sure, I"]))
        rig.socket.push(Step.audio())
        await rig.settle()
        #expect(rig.playback.queued == 2)
        #expect(rig.core.phase == .speaking)

        // Not yet, however long they talk: it may be the voice's own echo. It's only lowered.
        rig.socket.push(Step.event("input_audio_buffer.speech_started", ["audio_start_ms": 1200]))
        await rig.settle()
        rig.clock.advance(1.5)
        rig.core.tick()
        #expect(rig.playback.flushes == 0)
        #expect(rig.playback.queued == 2)
        #expect(rig.playback.ducks == [true])
        #expect(!rig.socket.sentTypes.contains("response.cancel"))

        // Their words, not the voice's: cut.
        rig.socket.push(Step.event("input_audio_buffer.speech_stopped"))
        rig.socket.push(Step.event("conversation.item.input_audio_transcription.completed", ["transcript": "Wait, stop."]))
        await rig.settle()
        #expect(rig.playback.flushes == 1)
        #expect(rig.playback.queued == 0)
        #expect(rig.playback.ducks == [true, false])
        #expect(rig.socket.sentTypes.last == "response.cancel")
        #expect(rig.core.phase == .listening)
        #expect(Set(rig.core.transcript.unsent.map(\.text)) == ["Sure, I", "Wait, stop."])

        // The cancelled response's late audio isn't played; the next response's is.
        rig.socket.push(Step.audio())
        await rig.settle()
        #expect(rig.playback.played.count == 2)
        rig.socket.push(Step.event("response.cancelled", ["response_id": "resp_1"]))
        rig.socket.push(Step.event("response.created"))
        rig.socket.push(Step.audio())
        await rig.settle()
        #expect(rig.playback.played.count == 3)
        await rig.core.end()
    }

    @Test("function_call_arguments.done → /tool → function_call_output + response.create")
    func toolCall() async {
        let rig = CallRig(StepCodec())
        rig.backend.toolAnswer = .success("Claude is working: checking suppliers.")
        rig.begin(M13Fx.started(.stepfun, secret: "k"))
        rig.socket.push(Step.event("session.created"))
        rig.socket.push(Step.event("conversation.item.input_audio_transcription.completed",
                                   ["item_id": "item_1", "transcript": "Is Claude still on it?"]))
        rig.socket.push(Step.event("response.created"))
        rig.socket.push(Step.event("response.function_call_arguments.done",
                                   ["call_id": "call_abc", "name": "assistant_status", "arguments": "{}"]))
        rig.socket.push(Step.event("response.done"))
        await rig.settle()

        #expect(rig.backend.tools.map(\.name) == ["assistant_status"])
        #expect(rig.backend.tools.first?.arguments == [:])
        #expect(rig.backend.tools.first?.lines.map(\.text) == ["Is Claude still on it?"])
        let sent = rig.socket.sentJSON.suffix(2)
        #expect(sent.map { $0["type"] as? String } == ["conversation.item.create", "response.create"])
        let item = object(sent.first?["item"])
        #expect(item["type"] as? String == "function_call_output")
        #expect(item["call_id"] as? String == "call_abc")
        #expect(item["output"] as? String == "Claude is working: checking suppliers.")
        await rig.core.end()
    }

    @Test("A cough after the reply is all here: the voice plays on, nothing is cancelled")
    func falseStart() async {
        let rig = CallRig(StepCodec())
        rig.begin(M13Fx.started(.stepfun, secret: "k"))
        rig.socket.push(Step.event("session.created"))
        rig.socket.push(Step.event("response.created"))
        // 2 s pieces: the cough comes well before the voice's last moment.
        for _ in 0..<3 { rig.socket.push(Step.audio(96_000)) }
        rig.socket.push(Step.event("response.audio_transcript.done", ["transcript": "Here are five books."]))
        rig.socket.push(Step.event("response.done"))
        await rig.settle()
        #expect(rig.playback.queued == 3)

        rig.socket.push(Step.event("input_audio_buffer.speech_started"))
        await rig.settle()
        rig.clock.advance(0.2)
        rig.socket.push(Step.event("input_audio_buffer.speech_stopped"))
        await rig.settle()
        rig.clock.advance(2.1)
        rig.core.tick()
        #expect(rig.playback.ducks == [true, false])
        #expect(rig.playback.flushes == 0)
        #expect(rig.playback.queued == 3)
        #expect(!rig.socket.sentTypes.contains("response.cancel"))
        #expect(rig.core.phase == .speaking)
        rig.playback.drain()
        #expect(rig.core.phase == .listening)

        // Speech while nothing plays isn't a barge-in at all.
        rig.socket.push(Step.event("input_audio_buffer.speech_started"))
        await rig.settle()
        rig.clock.advance(1)
        rig.core.tick()
        #expect(rig.playback.flushes == 0)
        await rig.core.end()
    }

    @Test("Talking over the end of a reply: the provider's answer to it is held, then plays instead of the rest")
    func heldAnswer() async {
        let rig = CallRig(StepCodec())
        rig.begin(M13Fx.started(.stepfun, secret: "k"))
        rig.socket.push(Step.event("session.created"))
        rig.socket.push(Step.event("response.created"))
        rig.socket.push(Step.audio(96_000))
        rig.socket.push(Step.audio(96_000))
        rig.socket.push(Step.event("response.done"))
        await rig.settle()

        rig.socket.push(Step.event("input_audio_buffer.speech_started"))
        await rig.settle()
        rig.clock.advance(0.3)
        rig.socket.push(Step.event("input_audio_buffer.speech_stopped"))
        // The provider answers them before their words come back.
        rig.socket.push(Step.event("response.created"))
        rig.socket.push(Step.audio(480))
        await rig.settle()
        #expect(rig.playback.played.count == 2)
        #expect(rig.playback.queued == 2)
        #expect(rig.playback.flushes == 0)

        rig.socket.push(Step.event("conversation.item.input_audio_transcription.completed", ["transcript": "Wait, stop."]))
        await rig.settle()
        #expect(rig.playback.flushes == 1)
        #expect(rig.playback.played.count == 3)
        #expect(rig.playback.played.last?.count == 480)
        #expect(rig.playback.queued == 1)
        #expect(rig.core.phase == .speaking)
        // Its response was already done: nothing to cancel.
        #expect(!rig.socket.sentTypes.contains("response.cancel"))
        rig.socket.push(Step.event("response.done"))
        await rig.settle()
        rig.playback.drain()
        #expect(rig.core.phase == .listening)
        await rig.core.end()
    }

    @Test("Two tools in one response: both answers added, one response.create once it's done")
    func toolsWaitForDone() async {
        let rig = CallRig(StepCodec())
        rig.begin(M13Fx.started(.stepfun, secret: "k"))
        rig.socket.push(Step.event("session.created"))
        rig.socket.push(Step.event("response.created"))
        rig.socket.push(Step.event("response.function_call_arguments.done",
                                   ["call_id": "c1", "name": "assistant_status", "arguments": "{}"]))
        rig.socket.push(Step.event("response.function_call_arguments.done",
                                   ["call_id": "c2", "name": "send_to_assistant", "arguments": #"{"text":"Order pads."}"#]))
        await rig.settle()
        #expect(rig.backend.tools.map(\.name) == ["assistant_status", "send_to_assistant"])
        #expect(rig.socket.sentTypes.filter { $0 == "conversation.item.create" }.count == 2)
        #expect(!rig.socket.sentTypes.contains("response.create"))

        rig.socket.push(Step.event("response.done"))
        await rig.settle()
        #expect(rig.socket.sentTypes.filter { $0 == "response.create" }.count == 1)
        #expect(rig.socket.sentTypes.last == "response.create")

        // A stray done before the asked-for response starts doesn't free the line for a cue.
        rig.socket.push(Step.event("response.done"))
        await rig.settle()
        rig.core.hear(M13Fx.cue("reply", "Pads ordered.", seq: 1))
        #expect(rig.socket.sentTypes.filter { $0 == "response.create" }.count == 1)
        rig.socket.push(Step.event("response.created"))
        rig.socket.push(Step.event("response.done"))
        await rig.settle()
        rig.clock.advance(11)
        rig.core.tick()
        #expect(rig.socket.sentTypes.filter { $0 == "response.create" }.count == 2)
        let cue = rig.socket.sentJSON.filter { $0["type"] as? String == "conversation.item.create" }.last
        let content = list(object(cue?["item"])["content"]).first
        #expect(content?["text"] as? String == "[OpenDuet replied] Pads ordered.")
        await rig.core.end()
    }

    @Test("A response whose done never comes is let go after 8 s")
    func lostDone() async {
        let rig = CallRig(StepCodec())
        rig.begin(M13Fx.started(.stepfun, secret: "k"))
        rig.socket.push(Step.event("session.created"))
        rig.socket.push(Step.event("response.created"))
        await rig.settle()
        rig.core.hear(M13Fx.cue("notice", "The page is ready.", seq: 1))
        #expect(!rig.socket.sentTypes.contains("response.create"))
        rig.clock.advance(8.5)
        rig.core.tick()
        #expect(rig.socket.sentTypes.last == "response.create")
        await rig.core.end()
    }

    @Test("A drop: 5 tries after 1 / 2 / 4 / 8 / 15 s, then failed and /end")
    func dropRetries() async {
        let rig = CallRig(StepCodec())
        rig.backend.startAnswers = [M13Fx.started(.stepfun, secret: "k2")]
        rig.begin(M13Fx.started(.stepfun, secret: "k"))
        rig.socket.push(Step.event("session.created"))
        await rig.settle()
        #expect(rig.core.phase == .listening)

        rig.sockets.dropAtOnce = 1006
        rig.socket.drop(code: 1006)
        await rig.until { rig.backend.ends.count == 1 }

        #expect(rig.clock.sleeps == [1, 2, 4, 8, 15])
        #expect(rig.backend.starts.count == 5)
        #expect(rig.backend.starts.allSatisfy { $0.callId == "call_1" && $0.channelId == "ch_shop" })
        #expect(rig.sockets.sockets.count == 6)
        #expect(rig.core.phase.isFailed)
        if case .failed(_, let kind) = rig.core.phase { #expect(kind == .connection) }
        #expect(rig.backend.ends.count == 1)
        // Ending again answers the same, without a second /end.
        let again = await rig.core.end()
        #expect(again?.id == "msg_call_1")
        #expect(rig.backend.ends.count == 1)
    }
}

@MainActor
@Suite("Voice calls: cues, lines and credentials")
struct UIM13CallCoreTests {
    private func readyGemini(_ secret: String = "t") async -> CallRig {
        let rig = CallRig(GeminiCodec())
        rig.begin(M13Fx.started(.gemini, secret: secret))
        rig.socket.push(Gemini.setupComplete)
        await rig.settle()
        return rig
    }

    private func spoken(_ rig: CallRig) -> [String] {
        rig.socket.sentJSON.compactMap { frame in
            let content = object(frame["clientContent"])
            let turn = list(content["turns"]).first
            return list(turn?["parts"]).first?["text"] as? String
        }
    }

    @Test("Cues: seq dedupe, the reply spoken, a notice once, progress dropped while speaking")
    func cues() async {
        let rig = await readyGemini()
        rig.core.hear(M13Fx.cue("reply", "The order is ready.", seq: 10))
        #expect(spoken(rig) == ["[OpenDuet replied] The order is ready."])
        rig.core.hear(M13Fx.cue("reply", "The order is ready.", seq: 10))
        rig.core.hear(M13Fx.cue("reply", "Older.", seq: 9))
        #expect(spoken(rig).count == 1)

        // The voice answers; progress while it speaks is dropped, not queued.
        rig.socket.push(Gemini.audio())
        await rig.settle()
        rig.core.hear(M13Fx.cue("progress", "Claude is still working", seq: 11))
        rig.socket.push(Gemini.turnComplete)
        await rig.settle()
        rig.playback.drain()
        #expect(spoken(rig).count == 1)

        rig.core.hear(M13Fx.cue("notice", "Brake pads need your approval on the card", seq: 12))
        #expect(spoken(rig).last == "[Notice] Brake pads need your approval on the card")
        rig.socket.push(Gemini.turnComplete)
        await rig.settle()
        rig.core.hear(M13Fx.cue("notice", "Brake pads need your approval on the card", seq: 13))
        #expect(spoken(rig).count == 2)

        // Idle: progress is mentioned.
        rig.core.hear(M13Fx.cue("progress", "Claude is checking suppliers", seq: 14))
        #expect(spoken(rig).last == "[Progress] Claude is checking suppliers")
        // Another call's cue is ignored.
        rig.socket.push(Gemini.turnComplete)
        await rig.settle()
        rig.core.hear(M13Fx.cue("reply", "Not this call.", seq: 15, callId: "call_other"))
        #expect(spoken(rig).count == 3)
        await rig.core.end()
    }

    @Test("A reply that comes while the user talks waits for the end of their turn")
    func replyWaits() async {
        let rig = await readyGemini()
        rig.socket.push(Gemini.heard("Also tell"))
        await rig.settle()
        rig.core.hear(M13Fx.cue("reply", "Done.", seq: 1))
        #expect(spoken(rig).isEmpty)
        rig.socket.push(Gemini.turnComplete)
        await rig.settle()
        #expect(spoken(rig) == ["[OpenDuet replied] Done."])
        await rig.core.end()
    }

    @Test("A speaker that stops finishing pieces: after 4 s flushed, back to listening, the reply spoken")
    func stalledSpeaker() async {
        let rig = await readyGemini()
        rig.socket.push(Gemini.audio())
        rig.socket.push(Gemini.audio())
        rig.socket.push(Gemini.turnComplete)
        await rig.settle()
        #expect(rig.core.phase == .speaking)
        rig.core.hear(M13Fx.cue("reply", "Deployed.", seq: 1))
        rig.clock.advance(3)
        rig.core.tick()
        #expect(rig.playback.flushes == 0)
        #expect(spoken(rig).isEmpty)
        rig.clock.advance(1.5)
        rig.core.tick()
        #expect(rig.playback.flushes == 1)
        #expect(rig.core.phase == .listening)
        #expect(spoken(rig) == ["[OpenDuet replied] Deployed."])
        await rig.core.end()
    }

    @Test("Lines: 20 at once go without waiting; unsent ones ride on /tool and /end; ids stable")
    func lines() async {
        let rig = await readyGemini()
        for index in 1...10 {
            rig.socket.push(Gemini.heard("question \(index)"))
            rig.socket.push(Gemini.said("answer \(index)"))
            rig.socket.push(Gemini.turnComplete)
        }
        await rig.settle()
        #expect(rig.core.transcript.unsent.count == 20)
        rig.core.tick()
        await rig.settle()
        #expect(rig.backend.lineBatches.map(\.count) == [20])

        rig.socket.push(Gemini.heard("send it"))
        rig.socket.push(Gemini.toolCall("fc_9", "send_to_assistant", ["text": "send it"]))
        await rig.settle()
        #expect(rig.backend.tools.first?.lines.map(\.text) == ["send it"])

        rig.socket.push(Gemini.said("Sent."))
        await rig.settle()
        rig.clock.advance(65)
        let message = await rig.core.end()
        #expect(message?.id == "msg_call_1")
        #expect(rig.backend.ends.count == 1)
        #expect(rig.backend.ends.first?.seconds == 65)
        #expect(rig.backend.ends.first?.lines.map(\.text) == ["Sent."])

        let all = rig.backend.allLines
        #expect(all.count == 22)
        #expect(Set(all.map(\.id)).count == 22)
        #expect(all.map(\.id) == (1...22).map { "line-\($0)" })
        // A second end is the same message, without a second request.
        #expect(await rig.core.end()?.id == "msg_call_1")
        #expect(rig.backend.ends.count == 1)
    }

    @Test("A failed /lines batch is kept and goes with /end")
    func linesRetry() async {
        let rig = await readyGemini()
        rig.backend.linesFail = true
        rig.socket.push(Gemini.heard("hello"))
        rig.socket.push(Gemini.turnComplete)
        await rig.settle()
        rig.clock.advance(4)
        rig.core.tick()
        await rig.settle()
        #expect(rig.core.transcript.unsent.map(\.text) == ["hello"])
        await rig.core.end()
        #expect(rig.backend.ends.first?.lines.map(\.text) == ["hello"])
    }

    @Test("Credentials: held while the call runs, none after end, after failed and on reconnect")
    func credentials() async {
        let rig = await readyGemini("auth_tokens/live-one")
        #expect(M13Fx.holds("auth_tokens/live-one", in: rig.core))
        await rig.core.end()
        #expect(!M13Fx.holds("auth_tokens/live-one", in: rig.core))

        let failed = await readyGemini("auth_tokens/live-two")
        failed.socket.drop(code: 1008)
        await failed.until { failed.core.phase.isOver }
        await failed.core.settle()
        #expect(failed.core.phase.isFailed)
        #expect(!M13Fx.holds("auth_tokens/live-two", in: failed.core))

        let moved = await readyGemini("auth_tokens/old")
        moved.backend.startAnswers = [M13Fx.started(.gemini, secret: "auth_tokens/new")]
        moved.socket.push(["goAway": [String: Any]()])
        await moved.until { moved.sockets.sockets.count == 2 }
        #expect(!M13Fx.holds("auth_tokens/old", in: moved.core))
        #expect(M13Fx.holds("auth_tokens/new", in: moved.core))
        await moved.core.end()
        #expect(!M13Fx.holds("auth_tokens/new", in: moved.core))

        let step = CallRig(StepCodec())
        step.begin(M13Fx.started(.stepfun, secret: "step-key-123"))
        #expect(M13Fx.holds("step-key-123", in: step.core))
        await step.core.end()
        #expect(!M13Fx.holds("step-key-123", in: step.core))
    }

    @Test("VoiceCredential and the start answer never print the secret")
    func redacted() {
        let started = M13Fx.started(.stepfun, secret: "step-key-xyz")
        let credential = started.credential
        #expect(credential.secret == "step-key-xyz")
        #expect("\(credential)" == "<credential>")
        #expect(String(reflecting: credential) == "<credential>")
        var dumped = ""
        dump(credential, to: &dumped)
        #expect(!dumped.contains("step-key-xyz"))
        #expect(!"\(started)".contains("step-key-xyz"))
        #expect(!String(reflecting: started).contains("step-key-xyz"))
        let token = M13Fx.started(.gemini, secret: "auth_tokens/abc").credential
        #expect("\(token)" == "<credential>")
    }
}
