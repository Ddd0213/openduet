// The call in the app: the chat's call line, the bar's phase words and timer, the composer's
// circle during a call and its notes before one, Everything → Voice's usable realtime models and
// voices, and CallSession over a scripted engine (setup, microphone, 409, start, captions, mute,
// cues, hang-up while connecting, failure kept until closed, the stream hold).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

/// A VoiceEngine that does what the test says.
@MainActor
final class ScriptedVoiceEngine: VoiceEngine {
    var phase: CallPhase = .connecting
    var level: Float = 0
    var muted = false { didSet { onChange?() } }
    var captions: [CallLine] = []
    var seconds = 0
    var onChange: (() -> Void)?
    var onEnded: ((Message?) -> Void)?
    var lastProviderError: String?
    /// Only the ids: the answer's credential is the engine's business (the live one gives it to
    /// CallCore, which puts it in the socket's request), not the test's.
    private(set) var started: [(callId: String, channelId: String, language: String?)] = []
    private(set) var heard: [CallCue] = []
    private(set) var interrupts = 0
    private(set) var ends = 0
    var endAnswer: Message?

    func start(_ started: StartCallResponse, channelId: String, language: String?) {
        self.started.append((started.call.id, channelId, language))
    }

    func interrupt() { interrupts += 1 }
    func hear(_ cue: CallCue) { heard.append(cue) }

    func end() async -> Message? {
        ends += 1
        phase = .ended
        onChange?()
        onEnded?(endAnswer)
        return endAnswer
    }

    /// The engine moves on (as CallCore would) and tells the session.
    func move(_ phase: CallPhase, captions: [CallLine]? = nil, seconds: Int? = nil, level: Float? = nil) {
        self.phase = phase
        if let captions { self.captions = captions }
        if let seconds { self.seconds = seconds }
        if let level { self.level = level }
        onChange?()
    }

    /// CallCore failed and posted /end.
    func fail(_ reason: String, _ kind: CallFailure, message: Message?) {
        phase = .failed(reason: reason, kind: kind)
        onChange?()
        onEnded?(message)
    }
}

/// A session over the fake backend and a scripted engine.
@MainActor
final class SessionRig {
    let backend = FakeCallBackend()
    var permission: MicPermission = .granted
    private(set) var engines: [ScriptedVoiceEngine] = []
    private(set) var kinds: [VoiceEngineKind] = []
    private(set) var messages: [Message] = []
    private(set) var holds: [Bool] = []
    var session: CallSession!

    init(ready: Bool = true) {
        session = CallSession(backend: backend, language: "zh-Hans", permission: { [unowned self] in self.permission }) { [unowned self] kind in
            let engine = ScriptedVoiceEngine()
            self.engines.append(engine)
            self.kinds.append(kind)
            return engine
        }
        session.voiceReady = ready
        session.onCallMessage = { [unowned self] in self.messages.append($0) }
        session.onActiveChanged = { [unowned self] in self.holds.append($0) }
    }

    var engine: ScriptedVoiceEngine { engines[engines.count - 1] }

    /// Lets the start task run.
    func settle() async {
        for _ in 0..<20 { await Task.yield() }
    }
}

private func line(_ id: String, _ from: CallLine.From, _ text: String) -> CallLine {
    CallLine(id: id, from: from, text: text, at: Date(timeIntervalSince1970: 1_793_000_000))
}

@Suite("M13 app: call copy, composer, voice settings")
struct UIM13RulesTests {
    private let en = Locale(identifier: "en_US")

    @Test("the call line and the timer")
    func copy() {
        #expect(CallCopy.line(seconds: 192, locale: en) == "Voice call · 3 min")
        #expect(CallCopy.line(seconds: 45, locale: en) == "Voice call · 45 sec")
        #expect(CallCopy.line(seconds: -4, locale: en) == "Voice call · 0 sec")
        #expect(CallCopy.timer(7) == "0:07")
        #expect(CallCopy.timer(185) == "3:05")
        #expect(CallCopy.timer(3723) == "1:02:03")
    }

    @Test("the bar's phase words")
    func phases() {
        #expect(CallCopy.phase(.connecting, muted: false) == "Connecting…")
        #expect(CallCopy.phase(.ready, muted: false) == "Connecting…")
        #expect(CallCopy.phase(.listening, muted: false) == "Listening")
        #expect(CallCopy.phase(.listening, muted: true) == "Muted")
        #expect(CallCopy.phase(.speaking, muted: true) == "Speaking")
        #expect(CallCopy.phase(.reconnecting, muted: false) == "Reconnecting…")
        #expect(CallCopy.phase(.failed(reason: "Lost the connection.", kind: .connection), muted: false) == "Lost the connection.")
        #expect(CallCopy.phase(.ended, muted: false) == nil)
    }

    @Test("the composer's circle: ↑ and ■ still win over the call")
    func circle() {
        #expect(ComposerAction.make(hasContent: false, replying: false, inCall: true) == .endCall)
        #expect(ComposerAction.make(hasContent: true, replying: false, inCall: true) == .send)
        #expect(ComposerAction.make(hasContent: false, replying: true, inCall: true) == .stop)
        #expect(ComposerAction.make(hasContent: false, replying: false, inCall: false) == .voice)
        #expect(ComposerAction.make(hasContent: false, replying: false) == .voice)
    }

    @Test("start notes from the server's answers")
    func notes() {
        #expect(CallNote.from(APIError.notConfigured) == .setup)
        #expect(CallNote.from(APIError.server(status: 409, code: "conflict")) == .busy)
        #expect(CallNote.from(APIError.staleVersion) == .busy)
        #expect(CallNote.from(APIError.validationFailed(field: "channelId", message: "That channel is archived.")) == .failed("That channel is archived."))
        #expect(CallNote.from(APIError.unreachable) == .failed(APIError.unreachable.localizedReason))
        #expect(CallNote.busy.text == "You're already on a call in another channel.")
        #expect(CallNote.setup.text == "Set up a voice model in Voice")
    }
}

@Suite("M13 app: usable realtime models")
struct UIM13VoiceModelTests {
    private static let date = Date(timeIntervalSince1970: 1_760_000_000)

    private static func provider(_ id: String, _ kind: ProviderKind, key: Bool = true) -> ModelProvider {
        ModelProvider(
            id: id, kind: kind, wireProtocol: .openai, name: id, baseUrl: "https://api.example.com", auth: nil,
            key: SecretInfo(set: key, last4: key ? "9xQa" : nil), headers: [], status: .active, error: nil,
            imported: false, modelCount: 1, createdAt: date
        )
    }

    private static func model(_ id: String, _ provider: String, _ purpose: ModelPurpose = .realtime) -> ModelEntry {
        ModelEntry(
            id: id, providerId: provider, purpose: purpose, modelId: id, label: "Model \(id)", contextWindow: 32_000,
            maxOutputTokens: 8_000, thinkingLevels: [], thinkingFormat: .noThinking, defaultThinking: nil, tools: true,
            vision: false, serverWebTools: false, promptCaching: false, source: .modelsDev, edited: [], createdAt: date
        )
    }

    private static var state: ModelsState {
        ModelsState(
            providers: [provider("g", .gemini), provider("s", .stepfun), provider("o", .openai), provider("gk", .gemini, key: false)],
            models: [
                model("chat", "g", .chat), model("live", "g"), model("step", "s"),
                model("oai", "o"), model("nokey", "gk"),
            ],
            defaults: ModelDefaults(defaultModelId: "chat", defaultThinking: nil, utilityModelId: nil),
            configured: true
        )
    }

    private static func settings(model: String?, voice: String?) -> VoiceSettings {
        VoiceSettings(modelId: model, voice: voice, voices: .init(gemini: ["Puck", "Kore"], stepfun: ["qingchunshaonv"]), configured: model != nil)
    }

    @Test("only realtime entries of a keyed Gemini or StepFun provider")
    func usable() {
        let state = Self.state
        #expect(VoiceModelRules.usableModels(state).map(\.id) == ["live", "step"])
        #expect(VoiceModelRules.showsStepNote(state))
        var geminiOnly = state
        geminiOnly.models.removeAll { $0.id == "step" }
        #expect(!VoiceModelRules.showsStepNote(geminiOnly))
        var none = state
        none.models.removeAll { $0.id == "live" || $0.id == "step" }
        #expect(VoiceModelRules.usableModels(none).isEmpty)
    }

    @Test("the current model and its engine's voices")
    func voices() {
        let state = Self.state
        let step = Self.settings(model: "step", voice: "qingchunshaonv")
        let current = VoiceModelRules.current(step, in: state)
        #expect(current?.id == "step")
        #expect(VoiceModelRules.voices(step, model: current, in: state) == ["qingchunshaonv"])
        #expect(VoiceModelRules.voice(step, model: current, in: state) == "qingchunshaonv")
        // A Gemini voice left over from before shows as Default under a StepFun model.
        let stale = Self.settings(model: "step", voice: "Puck")
        #expect(VoiceModelRules.voice(stale, model: current, in: state) == nil)
        // No (or an unusable) choice: the first usable model, as the server falls back.
        let unset = Self.settings(model: "nokey", voice: nil)
        #expect(VoiceModelRules.current(unset, in: state)?.id == "live")
        #expect(VoiceModelRules.voices(unset, model: nil, in: state).isEmpty)
    }
}

@MainActor
@Suite("M13 app: the call session")
struct UIM13SessionTests {
    @Test("no voice model: the setup note, no request")
    func setup() async {
        let rig = SessionRig(ready: false)
        rig.session.start(channelId: "ch_shop")
        await rig.settle()
        #expect(rig.session.note == .setup)
        #expect(rig.session.phase == nil)
        #expect(rig.backend.starts.isEmpty)
    }

    @Test("microphone denied: its note, no request")
    func microphone() async {
        let rig = SessionRig()
        rig.permission = .denied
        rig.session.start(channelId: "ch_shop")
        #expect(rig.session.phase == .connecting)
        await rig.settle()
        #expect(rig.session.note == .microphone)
        #expect(rig.session.phase == nil)
        #expect(rig.backend.starts.isEmpty)
        #expect(rig.holds == [true, false])
    }

    @Test("a call open elsewhere: the busy note; other failures: the reason")
    func busy() async {
        let rig = SessionRig()
        rig.backend.startError = APIError.server(status: 409, code: "conflict")
        rig.session.start(channelId: "ch_shop")
        await rig.settle()
        #expect(rig.session.note == .busy)
        #expect(rig.session.phase == nil)
        #expect(rig.engines.isEmpty)
        rig.backend.startError = APIError.notConfigured
        rig.session.start(channelId: "ch_shop")
        await rig.settle()
        #expect(rig.session.note == .setup)
        rig.backend.startError = nil
        // No scripted answer: unreachable, its reason inline.
        rig.session.start(channelId: "ch_shop")
        await rig.settle()
        #expect(rig.session.note == .failed(APIError.unreachable.localizedReason))
        #expect(rig.holds == [true, false, true, false, true, false])
    }

    @Test("start: the engine of the answer, captions, mute, cues, hang-up")
    func call() async {
        let rig = SessionRig()
        rig.backend.startAnswers = [M13Fx.started(.stepfun, secret: "step-key-1")]
        rig.session.start(channelId: "ch_shop")
        await rig.settle()
        #expect(rig.backend.starts == [StartCallRequest(channelId: "ch_shop", language: "zh-Hans")])
        #expect(rig.kinds == [.stepfun])
        #expect(rig.engine.started.count == 1)
        #expect(rig.engine.started.first?.channelId == "ch_shop")
        #expect(rig.engine.started.first?.language == "zh-Hans")
        #expect(rig.session.callId == "call_1")
        #expect(rig.session.channelId == "ch_shop")
        #expect(rig.session.isLive)
        // The session (its private fields included) never holds the credential.
        let session: CallSession = rig.session
        #expect(!M13Fx.holds("step-key-1", in: session))

        let lines = [line("u1", .user, "Reorder the pads"), line("v1", .voice, "Asking Claude now.")]
        rig.engine.move(.speaking, captions: lines, seconds: 12, level: 0.6)
        #expect(rig.session.phase == .speaking)
        #expect(rig.session.lines == lines)
        #expect(rig.session.seconds == 12)
        #expect(rig.session.level == 0.6)

        rig.session.toggleMute()
        #expect(rig.engine.muted)
        #expect(rig.session.muted)

        rig.session.hear(M13Fx.cue("reply", "Done.", seq: 2, callId: "other"))
        rig.session.hear(M13Fx.cue("reply", "Done.", seq: 3))
        #expect(rig.engine.heard.map(\.seq) == [3])

        rig.engine.endAnswer = M13Fx.callMessage(callId: "call_1", seconds: 12, lineCount: 2)
        rig.session.end()
        #expect(!rig.session.isActive, "the bar goes at the tap")
        await rig.settle()
        #expect(rig.engine.ends == 1)
        #expect(rig.messages.count == 1)
        #expect(rig.session.phase == nil)
        #expect(rig.session.callId == nil)
        #expect(rig.holds == [true, false])
    }

    @Test("a failure stays in the bar until Close; it doesn't hold the stream")
    func failure() async {
        let rig = SessionRig()
        rig.backend.startAnswers = [M13Fx.started(.gemini, secret: "auth_tokens/one")]
        rig.session.start(channelId: "ch_shop")
        await rig.settle()
        rig.engine.move(.listening, captions: [line("u1", .user, "Hi")])
        let message = M13Fx.callMessage(callId: "call_1", seconds: 30, lineCount: 1)
        rig.engine.fail("Lost the connection to the voice service.", .connection, message: message)
        #expect(rig.session.phase == .failed(reason: "Lost the connection to the voice service.", kind: .connection))
        #expect(rig.session.isActive)
        #expect(!rig.session.isLive)
        #expect(rig.messages.map(\.id) == [message.id])
        #expect(rig.holds == [true, false])
        rig.session.dismiss()
        #expect(rig.session.phase == nil)
        #expect(!rig.session.isActive)
    }

    @Test("hung up while connecting: no call, or the call closed as it comes")
    func hangUpWhileConnecting() async {
        // Before POST /api/calls went out: nothing is made.
        let early = SessionRig()
        early.backend.startAnswers = [M13Fx.started(.gemini, secret: "auth_tokens/two")]
        early.session.start(channelId: "ch_shop")
        early.session.end()
        #expect(early.session.phase == nil)
        await early.settle()
        #expect(early.backend.starts.isEmpty)
        #expect(early.engines.isEmpty)

        // While it's out: the answer's call is ended at once, no engine starts.
        let rig = SessionRig()
        rig.backend.startAnswers = [M13Fx.started(.gemini, secret: "auth_tokens/three")]
        rig.backend.duringStart = { [unowned rig] in rig.session.end() }
        rig.session.start(channelId: "ch_shop")
        await rig.settle()
        #expect(rig.backend.starts.count == 1)
        #expect(rig.engines.isEmpty)
        #expect(rig.backend.ends.map(\.seconds) == [0])
        #expect(rig.messages.count == 1)
        #expect(rig.session.phase == nil)
        #expect(rig.holds == [true, false])
    }

    @Test("a second tap while a call is on does nothing; a new call after a failure")
    func again() async {
        let rig = SessionRig()
        rig.backend.startAnswers = [M13Fx.started(.gemini, secret: "auth_tokens/a")]
        rig.session.start(channelId: "ch_shop")
        await rig.settle()
        rig.session.start(channelId: "ch_other")
        await rig.settle()
        #expect(rig.backend.starts.count == 1)
        rig.engine.fail("The voice service ended the call.", .provider, message: nil)
        rig.session.start(channelId: "ch_other")
        await rig.settle()
        #expect(rig.backend.starts.map(\.channelId) == ["ch_shop", "ch_other"])
        #expect(rig.session.channelId == "ch_other")
        #expect(rig.engines.count == 2)
    }
}

