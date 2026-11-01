// Voice call data: the m13 shapes (requests re-encode exactly, nil left out), the call message
// and the `call` event, Features.voice with older servers, the hidden call messages in the thread
// reducer (and their deltas), PCM and the codecs' smaller rules.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private func json(_ value: some Encodable) throws -> [String: Any] {
    let data = try JSONCoding.encoder().encode(value)
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

@Suite("Voice call models")
struct DataM13ModelTests {
    @Test("Requests: nil is left out, Patch.clear is null, defaults decode")
    func requests() throws {
        #expect(try json(StartCallRequest(channelId: "ch_1")).keys.sorted() == ["channelId"])
        let resume = try json(StartCallRequest(channelId: "ch_1", callId: "call_1", language: "zh-Hans"))
        #expect(resume["callId"] as? String == "call_1")
        #expect(resume["language"] as? String == "zh-Hans")
        #expect(resume["modelId"] == nil)

        let voiceOnly = try json(UpdateVoiceSettingsRequest(voice: .clear))
        #expect(voiceOnly.keys.sorted() == ["voice"])
        #expect(voiceOnly["voice"] is NSNull)
        let both = try json(UpdateVoiceSettingsRequest(modelId: .set("mdl_1"), voice: .set("Puck")))
        #expect(both["modelId"] as? String == "mdl_1")

        let tool = Fx.decode(CallToolRequest.self, ["name": "assistant_status"])
        #expect(tool.arguments.isEmpty && tool.lines.isEmpty)
        let encoded = try json(tool)
        #expect(encoded["arguments"] as? [String: Any] != nil)
        #expect((encoded["lines"] as? [Any])?.isEmpty == true)
        let end = try json(EndCallRequest(seconds: 8))
        #expect(end["seconds"] as? Int == 8)
    }

    @Test("JSON values round-trip unchanged (a tool's schema, a call's arguments)")
    func jsonValues() throws {
        let text = #"{"a":[1,2.5,true,null,"x"],"b":{"c":{}},"d":-3}"#
        let value = try #require(JSONValue.parse(text))
        #expect(value.text == text)
        #expect(value["a"]?.array?.first == .number(1))
        #expect(value["a"]?.array?[2] == .bool(true))
        #expect(value["d"]?.int == -3)
        #expect(JSONValue.parse("not json") == nil)
    }

    @Test("The call message, the call event and Features.voice")
    func messageAndEvent() throws {
        let message = M13Fx.callMessage(callId: "call_1", seconds: 192, lineCount: 3, title: "Reorder brake pads")
        guard case .call(let payload) = message.content else { Issue.record("not a call message"); return }
        #expect(payload == CallPayload(callId: "call_1", seconds: 192, title: "Reorder brake pads", lineCount: 3))
        #expect(message.callId == nil)

        var hidden = Fx.messageJSON("msg_h", at: 1)
        hidden["callId"] = "call_1"
        #expect(Fx.decode(Message.self, hidden).callId == "call_1")
        #expect(Fx.message("msg_old", at: 1).callId == nil)

        let event = Fx.event(401, "call", ["callId": "call_1", "kind": "notice", "text": "Needs approval", "seq": 1_762_106_560_000])
        guard case .call(let cue) = event.body else { Issue.record("not a call event"); return }
        #expect(cue.kind == .notice)
        #expect(cue.seq == 1_762_106_560_000)

        let older = try JSONCoding.decoder().decode(Features.self, from: Data(#"{"connectors":true,"webSearch":false,"computer":true}"#.utf8))
        #expect(older.voice == false)
        let newer = try JSONCoding.decoder().decode(Features.self, from: Data(#"{"connectors":true,"webSearch":false,"computer":true,"voice":true}"#.utf8))
        #expect(newer.voice)
    }

    @Test("Voice settings: the voices of each engine")
    func settings() throws {
        let settings = Fx.decode(VoiceSettings.self, [
            "modelId": NSNull(), "voice": NSNull(), "configured": false,
            "voices": ["gemini": ["Puck", "Kore"], "stepfun": ["qingchunshaonv"]],
        ])
        #expect(settings.voices[.gemini] == ["Puck", "Kore"])
        #expect(settings.voices[.stepfun] == ["qingchunshaonv"])
        #expect(settings.modelId == nil)
    }
}

@Suite("Voice calls: a call's messages in the thread (M15: shown)")
struct DataM13ThreadTests {
    private func fromCall(_ id: String, at t: Int, text: String = "hi", role: String = "assistant", updated: Int? = nil) -> [String: Any] {
        var message = Fx.messageJSON(id, at: t, text: text, role: role, updated: updated)
        message["callId"] = "call_1"
        return message
    }

    @Test("A call's hand-off and OpenDuet's reply show, a later delta updates the reply in place")
    func showsCallMessages() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(Fx.messageEvent(1, Fx.messageJSON("m1", at: 1)))
        reducer.apply(Fx.messageEvent(2, fromCall("h1", at: 2, text: "Reorder the pads", role: "user")))
        reducer.apply(Fx.messageEvent(3, fromCall("h2", at: 3, text: "On")))
        reducer.apply(Fx.messageEvent(4, fromCall("h2", at: 3, text: "On it", updated: 4)))
        #expect(reducer.thread.messages.map(\.id) == ["m1", "h1", "h2"])
        #expect(reducer.thread.messages.last?.text == "On it")
        #expect(reducer.thread.messages[1].callId == "call_1")

        // The call's one line shows after them.
        let line = M13Fx.callMessage(callId: "call_1", seconds: 60, lineCount: 2)
        var lineJSON = Fx.messageJSON(line.id, at: 5)
        lineJSON["kind"] = "call"
        lineJSON["role"] = "system"
        lineJSON["payload"] = ["callId": "call_1", "seconds": 60, "title": "", "lineCount": 2]
        reducer.apply(Fx.messageEvent(5, lineJSON))
        #expect(reducer.thread.messages.map(\.id) == ["m1", "h1", "h2", line.id])
    }

    @Test("A reply still streaming at hang-up comes again with callId null: the same bubble, its text so far")
    func releasedAtHangUp() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(Fx.messageEvent(1, fromCall("h1", at: 1, text: "Checking the")))
        #expect(reducer.thread.messages.map(\.id) == ["h1"])
        var released = Fx.messageJSON("h1", at: 1, text: "Checking the stock now.", updated: 2)
        released["callId"] = NSNull()
        reducer.apply(Fx.messageEvent(2, released))
        #expect(reducer.thread.messages.map(\.id) == ["h1"])
        #expect(reducer.thread.messages.first?.text == "Checking the stock now.")
        #expect(reducer.thread.messages.first?.callId == nil)
    }

    @Test("Pages and a card action's answer keep them")
    func pagesKeepThem() {
        var reducer = ThreadReducer(channelId: Fx.main)
        let page = Fx.page([Fx.message("a", at: 1), Fx.decode(Message.self, fromCall("b", at: 2)), Fx.message("c", at: 3)])
        reducer.applyFirstPage(page)
        #expect(reducer.thread.messages.map(\.id) == ["a", "b", "c"])
        let accepted = reducer.accept(Fx.decode(Message.self, fromCall("d", at: 4)))
        #expect(accepted)
        #expect(reducer.thread.messages.map(\.id) == ["a", "b", "c", "d"])
    }

    @Test("The task thread shows them as well")
    func taskThread() {
        var reducer = ThreadReducer(taskId: "task_1")
        reducer.apply(Fx.messageEvent(1, Fx.messageJSON("t1", at: 1, taskId: "task_1")))
        var reply = Fx.messageJSON("t2", at: 2, taskId: "task_1")
        reply["callId"] = "call_1"
        reducer.apply(Fx.messageEvent(2, reply))
        #expect(reducer.thread.messages.map(\.id) == ["t1", "t2"])
    }
}

@Suite("Voice calls: PCM and codecs")
struct DataM13PCMTests {
    @Test("Int16 round trip, little-endian, clipped")
    func int16RoundTrip() {
        let samples: [Float] = [0, 0.5, -0.5, 0.999, -1, 1.7, -2]
        let data = PCM.int16(samples)
        #expect(data.count == samples.count * 2)
        #expect(Array(data.prefix(4)) == [0x00, 0x00, 0xFF, 0x3F])
        let back = PCM.floats(data)
        for (index, value) in samples.enumerated() {
            #expect(abs(back[index] - max(-1, min(1, value))) < 0.0001)
        }
        #expect(PCM.floats(Data([0x01])).isEmpty)
    }

    @Test("Resampled lengths: 48 kHz → 16 kHz and 24 kHz, in one go or in pieces")
    func resampleLengths() {
        let tone = (0..<4800).map { Float(sin(Double($0) * 2 * .pi * 440 / 48000)) * 0.5 }
        #expect(abs(PCM.resample(tone, from: 48000, to: 16000).count - 1600) <= 1)
        #expect(abs(PCM.resample(tone, from: 48000, to: 24000).count - 2400) <= 1)
        #expect(abs(PCM.resample(Array(tone.prefix(1600)), from: 16000, to: 24000).count - 2400) <= 2)
        #expect(PCM.resample(tone, from: 24000, to: 24000).count == 4800)

        // Streamed in microphone-sized buffers: the same length, no seam.
        var resampler = Resampler(from: 48000, to: 16000)
        var streamed: [Float] = []
        for start in stride(from: 0, to: tone.count, by: 1024) {
            streamed += resampler.process(Array(tone[start..<min(tone.count, start + 1024)]))
        }
        #expect(abs(streamed.count - 1600) <= 2)
        var steady = Resampler(from: 48000, to: 24000)
        let flat = (0..<5).flatMap { _ in steady.process([Float](repeating: 0.25, count: 999)) }
        #expect(flat.dropFirst(2).allSatisfy { abs($0 - 0.25) < 0.0001 })
    }

    @Test("Chunks of 20 ms")
    func chunks() {
        #expect(PCM.chunkBytes(rate: 16000) == 640)
        #expect(PCM.chunkBytes(rate: 24000) == 960)
        var chunker = PCMChunker(rate: 16000)
        let first = chunker.push(Data(count: 500))
        #expect(first.isEmpty)
        let out = chunker.push(Data(count: 1000))
        #expect(out.map(\.count) == [640, 640])
        // 220 bytes wait from before: 419 more is one short of a chunk.
        let short = chunker.push(Data(count: 419))
        #expect(short.isEmpty)
        let last = chunker.push(Data(count: 1))
        #expect(last.map(\.count) == [640])
    }

    @Test("Loudness: silence 0, full scale 1")
    func level() {
        #expect(PCM.level([Float](repeating: 0, count: 100)) == 0)
        #expect(PCM.level([Float](repeating: 1, count: 100)) == 1)
        #expect(PCM.level([]) == 0)
    }

    @Test("Codec details: Gemini's rate and refusal codes; StepFun's events")
    func codecs() {
        #expect(GeminiCodec.rate(of: "audio/pcm;rate=24000") == 24000)
        #expect(GeminiCodec.rate(of: "audio/pcm") == nil)
        #expect(GeminiCodec().isFatal(closeCode: 1007) && GeminiCodec().isFatal(closeCode: 1008))
        #expect(!GeminiCodec().isFatal(closeCode: 1006) && !GeminiCodec().isFatal(closeCode: 1011))
        #expect(GeminiCodec().decode("{}").isEmpty)
        #expect(GeminiCodec().decode("garbage").isEmpty)

        let step = StepCodec()
        #expect(step.decode(#"{"type":"error","error":{"type":"invalid_request_error","message":"bad voice"}}"#)
            == [.error("bad voice", fatal: false)])
        #expect(step.decode(#"{"type":"response.audio_transcript.done","transcript":"Hi there."}"#)
            == [.outputText("Hi there.", final: true)])
        #expect(step.decode(#"{"type":"response.done"}"#) == [.turnComplete])
        #expect(step.decode(#"{"type":"response.cancelled","response_id":"resp_1"}"#) == [.turnComplete])
        #expect(step.decode(#"{"type":"response.created","response":{"id":"resp_2"}}"#) == [.responseStarted])
        #expect(step.decode(#"{"type":"input_audio_buffer.speech_stopped","audio_end_ms":900}"#) == [.speechStopped])
        // Adding a tool answer or a cue and asking for the answer are separate frames.
        #expect(step.toolResult(id: "c1", name: "assistant_status", result: "ok").count == 1)
        #expect(step.say("[Notice] Hi").count == 1)
        #expect(step.respond() == [#"{"type":"response.create"}"#])
        #expect(GeminiCodec().respond().isEmpty)
        #expect(step.decode(#"{"type":"rate_limits.updated"}"#).isEmpty)
        #expect(step.request(url: "https://api.stepfun.com/v1/realtime", credential: .key("k")) == nil)
        #expect(step.cancelResponse() == [#"{"type":"response.cancel"}"#])
        #expect(GeminiCodec().cancelResponse().isEmpty)
    }
}
