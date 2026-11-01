// M15: the voice service's errors that didn't end a call, kept on this phone per call (the
// user's choice: no server field) and recorded by the session when the call ends.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@MainActor
@Suite("Voice calls: provider errors kept on the phone (M15)")
struct DataCallProblemsTests {
    private func store(_ name: String = #function) -> (CallProblems, UserDefaults) {
        let suite = "duet.tests.callProblems.\(name)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return (CallProblems(defaults: defaults, key: "k"), defaults)
    }

    @Test("one per call, the newest wins, kept across launches")
    func keeps() {
        let (problems, defaults) = store()
        problems.record(callId: "call_1", message: "rate limited")
        problems.record(callId: "call_1", message: "server error")
        problems.record(callId: "call_2", message: "timeout")
        #expect(problems.message(for: "call_1") == "server error")
        #expect(problems.message(for: "call_2") == "timeout")
        #expect(problems.message(for: "call_3") == nil)
        let again = CallProblems(defaults: defaults, key: "k")
        #expect(again.message(for: "call_1") == "server error")
    }

    @Test("one line, cut at the limit, empty ones skipped")
    func shortens() {
        let (problems, _) = store()
        problems.record(callId: "call_1", message: "first\nsecond")
        #expect(problems.message(for: "call_1") == "first second")
        let long = String(repeating: "x", count: 400)
        #expect(CallProblems.shorten(long).count == CallProblems.maxLength)
        #expect(CallProblems.shorten(long).hasSuffix("…"))
        problems.record(callId: "call_2", message: "  \n ")
        problems.record(callId: "", message: "lost")
        #expect(problems.message(for: "call_2") == nil)
    }

    @Test("only the newest calls stay; sign-out clears them")
    func bounded() {
        let (problems, defaults) = store()
        for index in 0..<(CallProblems.capacity + 5) { problems.record(callId: "call_\(index)", message: "e\(index)") }
        #expect(problems.message(for: "call_0") == nil)
        #expect(problems.message(for: "call_\(CallProblems.capacity + 4)") != nil)
        problems.removeAll()
        #expect(problems.message(for: "call_\(CallProblems.capacity + 4)") == nil)
        #expect(CallProblems(defaults: defaults, key: "k").message(for: "call_\(CallProblems.capacity + 4)") == nil)
    }

    @Test("the session keeps the engine's last provider error under the ended call's id")
    func session() async {
        let (problems, _) = store()
        let backend = FakeCallBackend()
        backend.startAnswers = [M13Fx.started(.stepfun, secret: "sk")]
        var engine: ScriptedVoiceEngine?
        let session = CallSession(backend: backend, language: "zh-Hans", permission: { .granted }, problems: problems) { _ in
            let made = ScriptedVoiceEngine()
            engine = made
            return made
        }
        session.voiceReady = true
        session.start(channelId: "ch_shop")
        for _ in 0..<20 { await Task.yield() }
        guard let live = engine else {
            Issue.record("the call didn't start an engine")
            return
        }
        live.lastProviderError = "rate limited"
        live.endAnswer = M13Fx.callMessage(callId: "call_1", seconds: 30, lineCount: 2)
        session.end()
        for _ in 0..<20 { await Task.yield() }
        #expect(problems.message(for: "call_1") == "rate limited")
    }
}
