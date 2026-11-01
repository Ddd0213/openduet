// Voice calls (after M15): the loudspeaker's echo taken for the user (StepFun's VAD and ASR hear
// the voice and the phone cut its own reply), one long piece of the voice taken for a stuck
// speaker, and a network drop cutting the reply. Fake server, fake clock, fake speaker.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private enum EchoStep {
    static func event(_ type: String, _ extra: [String: Any] = [:]) -> [String: Any] {
        extra.merging(["type": type, "event_id": "evt_\(type)"]) { first, _ in first }
    }
    static func audio(_ bytes: Int = 960) -> [String: Any] {
        event("response.audio.delta", ["delta": Data(count: bytes).base64EncodedString(), "response_id": "resp_1"])
    }
    static func said(_ text: String) -> [String: Any] {
        event("response.audio_transcript.delta", ["delta": text])
    }
    static func heard(_ text: String, item: String? = nil) -> [String: Any] {
        var extra: [String: Any] = ["transcript": text]
        if let item { extra["item_id"] = item }
        return event("conversation.item.input_audio_transcription.completed", extra)
    }
}

private enum EchoGemini {
    static var setupComplete: [String: Any] { ["setupComplete": [String: Any]()] }
    static func audio(_ bytes: Int = 960) -> [String: Any] {
        let part: [String: Any] = ["inlineData": ["mimeType": "audio/pcm;rate=24000", "data": Data(count: bytes).base64EncodedString()]]
        return ["serverContent": ["modelTurn": ["parts": [part]]]]
    }
    static var turnComplete: [String: Any] { ["serverContent": ["turnComplete": true]] }
}

/// What the phone put to the StepFun voice as a user turn (cues and notices), in order.
@MainActor
private func told(_ socket: ScriptedSocket) -> [String] {
    socket.sentJSON.compactMap { frame in
        guard frame["type"] as? String == "conversation.item.create",
              let item = frame["item"] as? [String: Any], item["type"] as? String == "message",
              let content = (item["content"] as? [[String: Any]])?.first else { return nil }
        return content["text"] as? String
    }
}

/// Waits in real time without settling the core (a tool answer is held back).
@MainActor
private func spin(_ condition: () -> Bool) async {
    var tries = 0
    while !condition(), tries < 500 {
        tries += 1
        await Task.yield()
        try? await Task.sleep(for: .milliseconds(2))
    }
}

/// Holds a fake /tool answer until released.
@MainActor
private final class Gate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var open = false

    func wait() async {
        guard !open else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        open = true
        let all = waiters
        waiters = []
        all.forEach { $0.resume() }
    }
}

@Suite("Voice calls: the voice's own echo")
struct DataCallEchoCheckTests {
    @Test("EchoCheck: the voice's words come back as an echo; fillers and backchannels; the user's own words")
    func verdicts() {
        let voice = ["让我先看看 Claude 现在在做什么。"]
        #expect(EchoCheck.verdict("先看看", voice: voice) == .unsure)
        // What the phone heard on the device (the stored lines of calls 6ztxld and cl7wr6).
        #expect(EchoCheck.verdict("那我先看看", voice: voice) == .echo)
        #expect(EchoCheck.verdict("看看 Cloud 现", voice: ["让我看看 Claude 现在进展如何。"]) == .echo)
        #expect(EchoCheck.verdict("Hello, owner.", voice: ["Hello, Owner! I'm here. What can I do for you?"]) == .echo)
        // An older line counts too (the echo lags behind the text).
        #expect(EchoCheck.verdict("我先看看", voice: ["Claude 现在没有在干活。", "让我先看看 Claude 现在在做什么。"]) == .echo)

        for heard in ["嗯", "嗯嗯", "好的", "哦", "对对对", "Mm-hmm.", "OK", "uh huh", "", "。"] {
            #expect(EchoCheck.verdict(heard, voice: voice) == .filler, "\(heard)")
        }
        for heard in ["等一下", "停", "你说什么？", "Wait, stop.", "不对，我要的是蓝色的"] {
            #expect(EchoCheck.verdict(heard, voice: voice) == .words, "\(heard)")
        }
        // One character is never an echo (a 好 answering 好吗？ is a backchannel at most).
        #expect(EchoCheck.verdict("好", voice: ["要我转给 Claude 吗，好吗？"]) == .filler)
        #expect(EchoCheck.verdict("停", voice: ["停一下再说"]) == .words)
        // Two or three characters found in the voice's words: its echo or their answer, unsure
        // (nothing thrown away).
        #expect(EchoCheck.verdict("不要", voice: ["要不要我转给 Claude？"]) == .unsure)
        #expect(EchoCheck.verdict("No.", voice: ["I know the shop."]) == .unsure)
        #expect(EchoCheck.verdict("No.", voice: ["Here's the shop."]) == .words)
    }

    @Test("EchoCheck.similarity: approximate substring, per character of the heard text")
    func similarity() {
        let n = EchoCheck.normalized
        #expect(EchoCheck.similarity(n("abc"), within: n("xx abc xx")) == 1)
        #expect(EchoCheck.similarity(n("abcd"), within: n("xxabxdxx")) == 0.75)
        #expect(EchoCheck.similarity(n("ABC!"), within: n("abc")) == 1)
        #expect(EchoCheck.similarity([], within: n("abc")) == 0)
        #expect(EchoCheck.similarity(n("abc"), within: []) == 0)
    }
}

@MainActor
@Suite("Voice calls: speech over the voice (StepFun)")
struct DataCallBargeInTests {
    /// The voice says `text`, all of it here: `pieces` of `bytes` (2 s each by default, so speech
    /// over it isn't over its last moment).
    private func speaking(_ rig: CallRig, _ text: String, pieces: Int = 3, bytes: Int = 96_000) async {
        rig.begin(M13Fx.started(.stepfun, secret: "k"))
        rig.socket.push(EchoStep.event("session.created"))
        rig.socket.push(EchoStep.event("response.created"))
        rig.socket.push(EchoStep.said(text))
        for _ in 0..<pieces { rig.socket.push(EchoStep.audio(bytes)) }
        rig.socket.push(EchoStep.event("response.audio_transcript.done", ["transcript": text]))
        rig.socket.push(EchoStep.event("response.done"))
        await rig.settle()
    }

    /// Speech over the voice (well before its end), then the provider's own answer to it, held.
    private func heldAnswer(_ rig: CallRig) async {
        rig.socket.push(EchoStep.event("input_audio_buffer.speech_started"))
        await rig.settle()
        #expect(rig.playback.ducks == [true])
        rig.clock.advance(1.2)
        rig.core.tick()
        rig.socket.push(EchoStep.event("input_audio_buffer.speech_stopped"))
        // The provider answers the "user" before the words come back: held.
        rig.socket.push(EchoStep.event("response.created"))
        rig.socket.push(EchoStep.said("好的，我看看。"))
        rig.socket.push(EchoStep.audio())
        await rig.settle()
        #expect(rig.playback.played.count == 3)
    }

    @Test("The voice's echo, answered by the provider in full: the voice plays on; the answer is never played or shown, the echo deleted")
    func echoHeld() async {
        let rig = CallRig(StepCodec())
        await speaking(rig, "让我先看看 Claude 现在在做什么。")
        await heldAnswer(rig)
        rig.socket.push(EchoStep.event("response.audio_transcript.done", ["transcript": "好的，我看看。"]))
        rig.socket.push(EchoStep.event("response.done"))
        await rig.settle()
        // Its words are held with it: not a line, not the voice's words the echo is judged by.
        #expect(rig.core.transcript.lines.map(\.text) == ["让我先看看 Claude 现在在做什么。"])

        rig.socket.push(EchoStep.heard("那我先看看", item: "item_echo"))
        await rig.settle()
        #expect(rig.playback.flushes == 0)
        #expect(rig.playback.queued == 3)
        #expect(rig.playback.played.count == 3)
        #expect(rig.playback.ducks == [true, false])
        // Done already: nothing to cancel; the echo is taken out of the provider's conversation.
        #expect(!rig.socket.sentTypes.contains("response.cancel"))
        #expect(rig.socket.sentTypes.last == "conversation.item.delete")
        #expect(rig.socket.sentJSON.last?["item_id"] as? String == "item_echo")
        #expect(rig.core.phase == .speaking)
        // Neither the echo nor the answer to it is a line of the call.
        #expect(rig.core.transcript.lines.map(\.text) == ["让我先看看 Claude 现在在做什么。"])
        rig.playback.drain()
        #expect(rig.core.phase == .listening)
        await rig.core.end()
    }

    @Test("The voice's echo while the provider's answer to it still arrives: cancelled, its late audio not played")
    func echoHeldArriving() async {
        let rig = CallRig(StepCodec())
        await speaking(rig, "让我先看看 Claude 现在在做什么。")
        await heldAnswer(rig)
        rig.socket.push(EchoStep.heard("那我先看看", item: "item_echo"))
        await rig.settle()
        #expect(rig.socket.sentTypes.suffix(2) == ["response.cancel", "conversation.item.delete"])
        #expect(rig.playback.ducks == [true, false])
        rig.socket.push(EchoStep.audio())
        rig.socket.push(EchoStep.said("我看看"))
        rig.socket.push(EchoStep.event("response.done"))
        await rig.settle()
        #expect(rig.playback.played.count == 3)
        #expect(rig.core.transcript.lines.map(\.text) == ["让我先看看 Claude 现在在做什么。"])
        rig.playback.drain()
        #expect(rig.core.phase == .listening)
        await rig.core.end()
    }

    @Test("A tool call in the held answer: not run if it answered an echo; run with the user's words if they cut in")
    func heldToolCall() async {
        let echo = CallRig(StepCodec())
        await speaking(echo, "我这就转给 Claude 去办，做好了告诉你。")
        await heldAnswer(echo)
        echo.socket.push(EchoStep.event("response.function_call_arguments.done",
                                        ["call_id": "call_9", "name": "send_to_assistant", "arguments": #"{"text":"做个页面"}"#]))
        echo.socket.push(EchoStep.event("response.done"))
        await echo.settle()
        #expect(echo.backend.tools.isEmpty)
        echo.socket.push(EchoStep.heard("我这就转给 Claude"))
        await echo.settle()
        #expect(echo.backend.tools.isEmpty)
        let answer = echo.socket.sentJSON.last { $0["type"] as? String == "conversation.item.create" }
        #expect((answer?["item"] as? [String: Any])?["output"] as? String == CallCore.notRun)
        await echo.core.end()

        let user = CallRig(StepCodec())
        await speaking(user, "我这就转给 Claude 去办，做好了告诉你。")
        await heldAnswer(user)
        user.socket.push(EchoStep.event("response.function_call_arguments.done",
                                        ["call_id": "call_9", "name": "send_to_assistant", "arguments": #"{"text":"查订单"}"#]))
        user.socket.push(EchoStep.event("response.done"))
        await user.settle()
        #expect(user.backend.tools.isEmpty)
        user.socket.push(EchoStep.heard("等等，先帮我查订单"))
        await user.settle()
        #expect(user.playback.flushes == 1)
        #expect(user.backend.tools.map(\.name) == ["send_to_assistant"])
        #expect(user.backend.tools.first?.lines.map(\.text).contains("等等，先帮我查订单") == true)
        await user.core.end()
    }

    @Test("Speech that starts as the voice ends is the user's turn, not over it")
    func answerAtTheEnd() async {
        let rig = CallRig(StepCodec())
        // 0.04 s of voice left: they answer its question.
        await speaking(rig, "要我转给 Claude 吗？", pieces: 1, bytes: 1920)
        rig.socket.push(EchoStep.event("input_audio_buffer.speech_started"))
        rig.socket.push(EchoStep.event("input_audio_buffer.speech_stopped"))
        rig.socket.push(EchoStep.event("response.created"))
        rig.socket.push(EchoStep.audio())
        rig.socket.push(EchoStep.heard("转给 Claude 吧"))
        await rig.settle()
        #expect(rig.playback.ducks.isEmpty)
        #expect(rig.playback.played.count == 2)
        #expect(!rig.socket.sentTypes.contains("response.cancel"))
        #expect(rig.core.transcript.lines.last?.text == "转给 Claude 吧")
        await rig.core.end()
    }

    @Test("The echo's words before the provider's answer: that answer is cancelled when it starts; the user's next turn isn't")
    func echoBeforeAnswer() async {
        let rig = CallRig(StepCodec())
        await speaking(rig, "Here are five books for you.")
        rig.socket.push(EchoStep.event("input_audio_buffer.speech_started"))
        rig.socket.push(EchoStep.event("input_audio_buffer.speech_stopped"))
        rig.socket.push(EchoStep.heard("five books for you"))
        await rig.settle()
        #expect(rig.playback.ducks == [true, false])
        #expect(!rig.socket.sentTypes.contains("response.cancel"))

        rig.socket.push(EchoStep.event("response.created"))
        rig.socket.push(EchoStep.audio())
        await rig.settle()
        #expect(rig.socket.sentTypes.filter { $0 == "response.cancel" }.count == 1)
        #expect(rig.playback.played.count == 3)
        rig.socket.push(EchoStep.event("response.cancelled"))
        await rig.settle()
        rig.playback.drain()
        #expect(rig.core.phase == .listening)

        // The voice is quiet: the user's own turn is answered as usual.
        rig.socket.push(EchoStep.event("input_audio_buffer.speech_started"))
        rig.socket.push(EchoStep.event("input_audio_buffer.speech_stopped"))
        rig.socket.push(EchoStep.heard("Read me the first one."))
        rig.socket.push(EchoStep.event("response.created"))
        rig.socket.push(EchoStep.audio())
        await rig.settle()
        #expect(rig.playback.played.count == 4)
        #expect(rig.socket.sentTypes.filter { $0 == "response.cancel" }.count == 1)
        #expect(rig.core.transcript.lines.map(\.text) == ["Here are five books for you.", "Read me the first one."])
        await rig.core.end()
    }

    @Test("A backchannel over the voice: it plays on, the provider's answer after it")
    func backchannel() async {
        let rig = CallRig(StepCodec())
        await speaking(rig, "我这就转给 Claude 去办，做好了告诉你。")
        rig.socket.push(EchoStep.event("input_audio_buffer.speech_started"))
        rig.socket.push(EchoStep.event("input_audio_buffer.speech_stopped"))
        rig.socket.push(EchoStep.event("response.created"))
        rig.socket.push(EchoStep.said("好的。"))
        rig.socket.push(EchoStep.audio(480))
        await rig.settle()
        #expect(rig.playback.played.count == 3)

        rig.socket.push(EchoStep.heard("嗯嗯"))
        await rig.settle()
        #expect(rig.playback.flushes == 0)
        #expect(rig.playback.ducks == [true, false])
        #expect(rig.playback.played.count == 4)
        #expect(rig.playback.played.last?.count == 480)
        #expect(!rig.socket.sentTypes.contains("response.cancel"))
        #expect(rig.core.transcript.lines.map(\.text) == ["我这就转给 Claude 去办，做好了告诉你。", "嗯嗯", "好的。"])
        await rig.core.end()
    }

    @Test("Speech over the voice that never stops: let go after 6 s, nothing cut")
    func endlessSpeech() async {
        let rig = CallRig(StepCodec())
        // Two pieces of 2 s each: still playing when the speech is let go.
        await speaking(rig, "A long answer.", pieces: 2, bytes: 96_000)
        rig.socket.push(EchoStep.event("input_audio_buffer.speech_started"))
        await rig.settle()
        rig.clock.advance(5)
        rig.core.tick()
        #expect(rig.playback.ducks == [true])
        rig.clock.advance(1.5)
        rig.core.tick()
        #expect(rig.playback.ducks == [true, false])
        #expect(rig.playback.flushes == 0)
        #expect(rig.playback.queued == 2)
        await rig.core.end()
    }

    @Test("One long piece of the voice isn't a stuck speaker: flushed only 4 s after it should have played out")
    func longPiece() async {
        let rig = CallRig(StepCodec())
        // 6 s of 24 kHz PCM16 in one piece, its response done at once.
        await speaking(rig, "Six seconds of voice.", pieces: 1, bytes: 288_000)
        #expect(rig.core.phase == .speaking)
        rig.clock.advance(9)
        rig.core.tick()
        #expect(rig.playback.flushes == 0)
        #expect(rig.core.phase == .speaking)
        rig.clock.advance(1.5)
        rig.core.tick()
        #expect(rig.playback.flushes == 1)
        #expect(rig.core.phase == .listening)
        await rig.core.end()
    }
}

@MainActor
@Suite("Voice calls: a network drop doesn't cut the voice")
struct DataCallDropTests {
    @Test("A drop mid-reply: what arrived plays on; the new session is told where the reply was cut")
    func dropMidReply() async {
        let rig = CallRig(StepCodec())
        rig.backend.startAnswers = [M13Fx.started(.stepfun, secret: "k2")]
        rig.begin(M13Fx.started(.stepfun, secret: "k"))
        let first = rig.socket
        first.push(EchoStep.event("session.created"))
        first.push(EchoStep.event("response.created"))
        first.push(EchoStep.said("Claude finished the page and"))
        first.push(EchoStep.audio())
        first.push(EchoStep.audio())
        await rig.settle()
        #expect(rig.playback.queued == 2)

        first.drop(code: 1006)
        await rig.until { rig.sockets.sockets.count == 2 }
        #expect(rig.playback.flushes == 0)
        #expect(rig.playback.queued == 2)
        #expect(rig.core.phase == .reconnecting)

        let second = rig.socket
        second.push(EchoStep.event("session.created"))
        await rig.settle()
        // Still playing what arrived before the drop; the notice waits for it.
        #expect(rig.core.phase == .speaking)
        #expect(told(second).isEmpty)
        rig.playback.drain()
        #expect(rig.core.phase == .listening)
        let notice = told(second).first ?? ""
        #expect(notice.hasPrefix("[Notice] The connection dropped while you were speaking"))
        #expect(notice.contains("\"Claude finished the page and\""))
        #expect(second.sentTypes.last == "response.create")
        #expect(rig.core.transcript.lines.map(\.text) == ["Claude finished the page and"])
        await rig.core.end()
    }

    @Test("A tool answer that comes after its session dropped is told to the new one")
    func lostToolAnswer() async {
        let rig = CallRig(StepCodec())
        let gate = Gate()
        rig.backend.toolWait = { await gate.wait() }
        rig.backend.toolAnswer = .success("Claude is working: checking suppliers.")
        rig.backend.startAnswers = [M13Fx.started(.stepfun, secret: "k2")]
        rig.begin(M13Fx.started(.stepfun, secret: "k"))
        let first = rig.socket
        first.push(EchoStep.event("session.created"))
        first.push(EchoStep.event("response.created"))
        first.push(EchoStep.event("response.function_call_arguments.done",
                                  ["call_id": "call_1", "name": "assistant_status", "arguments": "{}"]))
        await spin { rig.backend.tools.count == 1 }

        first.drop(code: 1006)
        await spin { rig.sockets.sockets.count == 2 }
        let second = rig.socket
        second.push(EchoStep.event("session.created"))
        await spin { rig.core.phase == .listening }
        // Nothing to say yet: the tool still runs (asked again, the voice could call it twice).
        #expect(told(second).isEmpty)

        gate.release()
        await spin { !told(second).isEmpty }
        let notice = told(second).first ?? ""
        #expect(notice.hasPrefix("[Notice] The connection dropped before you told the user the answer to assistant_status"))
        #expect(notice.contains("don't call it again"))
        #expect(notice.contains("Claude is working: checking suppliers."))
        #expect(second.sentTypes.last == "response.create")
        #expect(!first.sentTypes.contains("conversation.item.create"))
        await rig.core.end()
    }

    @Test("A tool answer given but not spoken when the session drops is told again; one that was spoken isn't")
    func unspokenAnswer() async {
        let rig = CallRig(StepCodec())
        rig.backend.toolAnswer = .success("Claude is working: checking suppliers.")
        rig.backend.startAnswers = [M13Fx.started(.stepfun, secret: "k2")]
        rig.begin(M13Fx.started(.stepfun, secret: "k"))
        let first = rig.socket
        first.push(EchoStep.event("session.created"))
        first.push(EchoStep.event("response.created"))
        first.push(EchoStep.event("response.function_call_arguments.done",
                                  ["call_id": "call_1", "name": "assistant_status", "arguments": "{}"]))
        first.push(EchoStep.event("response.done"))
        await rig.settle()
        #expect(first.sentTypes.suffix(2) == ["conversation.item.create", "response.create"])

        // Dropped before the voice said it.
        first.drop(code: 1006)
        await rig.until { rig.sockets.sockets.count == 2 }
        let second = rig.socket
        second.push(EchoStep.event("session.created"))
        await rig.settle()
        let notice = told(second).first ?? ""
        #expect(notice.contains("the answer to assistant_status"))
        #expect(notice.contains("Claude is working: checking suppliers."))

        // This time it's said in full; a later drop has nothing to tell.
        second.push(EchoStep.event("response.created"))
        second.push(EchoStep.audio())
        second.push(EchoStep.event("response.done"))
        await rig.settle()
        rig.playback.drain()
        second.drop(code: 1006)
        await rig.until { rig.sockets.sockets.count == 3 }
        let third = rig.socket
        third.push(EchoStep.event("session.created"))
        await rig.settle()
        #expect(told(third).isEmpty)
        await rig.core.end()
    }

    @Test("A socket that answered pings and goes silent mid-reply is replaced; the voice already here plays on")
    func deadSocket() async {
        let rig = CallRig(StepCodec())
        rig.backend.startAnswers = [M13Fx.started(.stepfun, secret: "k2")]
        rig.begin(M13Fx.started(.stepfun, secret: "k"))
        let first = rig.socket
        first.push(EchoStep.event("session.created"))
        await rig.settle()
        // Pinged once it's ready, then after 15 s quiet; both answered.
        #expect(first.pings == 1)
        rig.clock.advance(16)
        rig.core.tick()
        #expect(first.pings == 2)

        first.push(EchoStep.event("response.created"))
        first.push(EchoStep.said("Your order is"))
        first.push(EchoStep.audio(96_000))
        first.push(EchoStep.audio(96_000))
        await rig.settle()
        // The network goes: nothing comes, pings aren't answered.
        first.answersPings = false
        rig.clock.advance(5)
        rig.core.tick()
        #expect(first.pings == 3)
        #expect(!first.closedByPhone)
        rig.clock.advance(6)
        rig.core.tick()
        #expect(first.closedByPhone)
        await rig.until { rig.sockets.sockets.count == 2 }
        #expect(rig.playback.flushes == 0)
        #expect(rig.playback.queued == 2)

        let second = rig.socket
        second.push(EchoStep.event("session.created"))
        await rig.settle()
        rig.playback.drain()
        #expect(told(second).first?.contains("\"Your order is\"") == true)
        await rig.core.end()
    }

    @Test("A frame while a ping waits proves the socket alive (its pong can sit behind audio)")
    func frameBeatsPong() async {
        let rig = CallRig(StepCodec())
        rig.begin(M13Fx.started(.stepfun, secret: "k"))
        let socket = rig.socket
        socket.push(EchoStep.event("session.created"))
        await rig.settle()
        socket.answersPings = false
        rig.clock.advance(16)
        rig.core.tick()
        #expect(socket.pings == 2)
        rig.clock.advance(3)
        socket.push(EchoStep.event("response.created"))
        await rig.settle()
        rig.clock.advance(4)
        rig.core.tick()
        #expect(!socket.closedByPhone)
        await rig.core.end()
    }

    @Test("Gemini's goAway mid-reply: the session is replaced once the reply is done, nothing cut")
    func goAwayWaits() async {
        let rig = CallRig(GeminiCodec())
        rig.backend.startAnswers = [M13Fx.started(.gemini, secret: "auth_tokens/two")]
        rig.begin(M13Fx.started(.gemini, secret: "auth_tokens/one"))
        let first = rig.socket
        first.push(EchoGemini.setupComplete)
        first.push(EchoGemini.audio())
        first.push(["goAway": ["timeLeft": "10s"]])
        await rig.settle()
        #expect(!first.closedByPhone)
        #expect(rig.sockets.sockets.count == 1)

        first.push(EchoGemini.audio())
        first.push(EchoGemini.turnComplete)
        await rig.until { rig.sockets.sockets.count == 2 }
        #expect(first.closedByPhone)
        #expect(rig.playback.played.count == 2)
        #expect(rig.playback.flushes == 0)
        #expect(rig.clock.sleeps.isEmpty)
        await rig.core.end()
    }
}
