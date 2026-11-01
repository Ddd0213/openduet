// The app's one voice call (plan 2.7): what the call bar, the composer's circle and the chat
// read, and the taps they make. start(channelId:) checks the setup and the microphone, posts
// /api/calls, and hands the answer to a VoiceEngine (Gemini Live or StepFun Realtime, picked by
// the answer's engine); the engine's changes come back through sync(). The credential in the
// answer goes straight into the engine and is never kept here. end() hangs up (the call's line
// comes back from /end and goes into the chat); a failed call keeps its reason in the bar until
// it's closed. The SSE `call` cues come in through hear(_:).
// Pure Foundation + Observation (host-tested); the live engines and the microphone are in
// CallSession+Live.swift.
import Foundation
import Observation

/// One call's engine (socket + codec + CallCore + audio). Tests use a scripted one.
@MainActor
protocol VoiceEngine: AnyObject {
    var phase: CallPhase { get }
    /// The microphone's (or, while the voice speaks, the speaker's) loudness, 0…1.
    var level: Float { get }
    var muted: Bool { get set }
    var captions: [CallLine] { get }
    var seconds: Int { get }
    /// Anything above changed.
    var onChange: (() -> Void)? { get set }
    /// /end answered (nil when it couldn't be reached).
    var onEnded: ((Message?) -> Void)? { get set }
    /// M15: the provider's last error that didn't end the call (shown on the call line).
    var lastProviderError: String? { get }
    func start(_ started: StartCallResponse, channelId: String, language: String?)
    func interrupt()
    func hear(_ cue: CallCue)
    @discardableResult func end() async -> Message?
}

/// The microphone permission, as the call needs it.
enum MicPermission: Sendable { case granted, denied }

@MainActor @Observable
final class CallSession {
    /// The call's channel and id (nil before POST /api/calls answered).
    private(set) var channelId: String?
    private(set) var callId: String?
    /// nil: no call. `.connecting` from the tap until the session is set up.
    private(set) var phase: CallPhase?
    /// The captions: the newest voice line and the newest user line.
    private(set) var lines: [CallLine] = []
    private(set) var seconds = 0
    private(set) var muted = false
    private(set) var level: Float = 0
    /// Why the last tap didn't start a call (shown by the composer until the next tap).
    private(set) var note: CallNote?
    /// Me.features.voice: a usable realtime model is set up (the session follows Me).
    var voiceReady = false

    /// The call's line from /end (or after a failure), for the chat.
    @ObservationIgnored var onCallMessage: ((Message) -> Void)?
    /// A call is under way or still ending: the event stream stays open in the background.
    @ObservationIgnored var onActiveChanged: ((Bool) -> Void)?
    /// The setup note's "Set up": Everything → Voice.
    @ObservationIgnored var onOpenVoiceSettings: (() -> Void)?

    typealias EngineFactory = @MainActor (VoiceEngineKind) -> any VoiceEngine
    @ObservationIgnored private let backend: any CallBackend
    /// M15: provider errors kept per call on this phone (the call line shows them).
    @ObservationIgnored private let problems: CallProblems
    @ObservationIgnored private let makeEngine: EngineFactory
    @ObservationIgnored private let permission: @MainActor () async -> MicPermission
    @ObservationIgnored private let language: String?
    @ObservationIgnored private var engine: (any VoiceEngine)?
    @ObservationIgnored private var engineToken = 0
    @ObservationIgnored private var attempt = 0
    @ObservationIgnored private var startTask: Task<Void, Never>?
    @ObservationIgnored private var reportedActive = false

    init(backend: any CallBackend, language: String?, permission: @escaping @MainActor () async -> MicPermission,
         problems: CallProblems = .shared, makeEngine: @escaping EngineFactory) {
        self.backend = backend
        self.problems = problems
        self.language = language
        self.permission = permission
        self.makeEngine = makeEngine
    }

    /// A call is on screen (connecting, live, reconnecting or failed and not yet closed).
    var isActive: Bool {
        guard let phase else { return false }
        return phase != .ended
    }

    /// A call is open and not failed: the composer's circle ends it.
    var isLive: Bool {
        guard let phase else { return false }
        return !phase.isOver
    }

    // MARK: - Taps

    /// The composer's waveform with nothing typed and the assistant idle.
    func start(channelId: String) {
        // A failure still in the bar gives way to the new call.
        if phase?.isFailed == true { reset() }
        guard !isActive else { return }
        note = nil
        guard voiceReady else {
            note = .setup
            return
        }
        // A hang-up still posting /end finishes on its own (its line still comes to the chat);
        // its later changes no longer reach this call.
        engineToken += 1
        engine = nil
        attempt += 1
        let attempt = attempt
        self.channelId = channelId
        callId = nil
        lines = []
        seconds = 0
        muted = false
        level = 0
        phase = .connecting
        activeChanged()
        startTask = Task { [weak self] in await self?.open(channelId: channelId, attempt: attempt) }
    }

    /// The bar's end, or the circle during a call. Nothing to confirm: it's a call.
    func end() {
        if let engine {
            phase = .ended
            Task { await engine.end() }
        } else if phase != nil {
            // Still posting /api/calls: the answer is hung up as it comes (open()).
            attempt += 1
            reset()
        }
    }

    /// The failure's Close.
    func dismiss() {
        guard phase?.isFailed == true else { return }
        reset()
    }

    func toggleMute() {
        guard let engine, isLive else { return }
        engine.muted.toggle()
        sync(engineToken)
    }

    /// Cuts the voice short (VoiceOver's action on the captions).
    func interrupt() {
        engine?.interrupt()
    }

    /// The SSE `call` event.
    func hear(_ cue: CallCue) {
        guard let engine, cue.callId == callId else { return }
        engine.hear(cue)
    }

    /// The composer's note goes once something else happens there.
    func clearNote() {
        note = nil
    }

    func openVoiceSettings() {
        note = nil
        onOpenVoiceSettings?()
    }

    /// Sign-out or a new session: the call ends now.
    func shutDown() {
        end()
        onCallMessage = nil
    }

    // MARK: - The start

    private func open(channelId: String, attempt: Int) async {
        if await permission() == .denied {
            guard attempt == self.attempt else { return }
            note = .microphone
            reset()
            return
        }
        guard attempt == self.attempt else { return }
        let started: StartCallResponse
        do {
            started = try await backend.startCall(StartCallRequest(channelId: channelId, language: language))
        } catch {
            guard attempt == self.attempt else { return }
            note = CallNote.from(error)
            reset()
            return
        }
        guard attempt == self.attempt else {
            // Hung up while the call was being made: close it on the server at once.
            let message = try? await backend.endCall(callId: started.call.id, EndCallRequest(seconds: 0))
            if let message { onCallMessage?(message) }
            return
        }
        callId = started.call.id
        engineToken += 1
        let token = engineToken
        let engine = makeEngine(started.call.engine)
        engine.onChange = { [weak self] in self?.sync(token) }
        engine.onEnded = { [weak self, weak engine] message in
            self?.finished(message, token: token, providerError: engine?.lastProviderError)
        }
        self.engine = engine
        engine.start(started, channelId: channelId, language: language)
        sync(token)
    }

    // MARK: - The engine's side

    private func sync(_ token: Int) {
        guard token == engineToken, let engine else { return }
        let next = engine.phase
        // A hang-up in progress stays "ended" until /end answers.
        if phase != .ended || next.isOver, phase != next { phase = next }
        if lines != engine.captions { lines = engine.captions }
        if seconds != engine.seconds { seconds = engine.seconds }
        if muted != engine.muted { muted = engine.muted }
        let loud = engine.level
        if abs(loud - level) > 0.02 || (loud == 0) != (level == 0) { level = loud }
    }

    private func finished(_ message: Message?, token: Int, providerError: String?) {
        // M15: the call's last provider error, kept before its line reaches the chat so they
        // show together (the line's call id; this call's own id when /end didn't answer).
        if let providerError, let id = message.flatMap(Self.callId) ?? (token == engineToken ? callId : nil) {
            problems.record(callId: id, message: providerError)
        }
        if let message { onCallMessage?(message) }
        guard token == engineToken else { return }
        sync(token)
        engine = nil
        // A failure stays in the bar until it's closed; a hang-up goes now.
        if phase?.isFailed == true {
            level = 0
            lines = []
            activeChanged()
        } else {
            reset()
        }
    }

    /// The call id of /end's line (a `call` message).
    private static func callId(_ message: Message) -> String? {
        if case .call(let payload) = message.content { return payload.callId }
        return nil
    }

    private func reset() {
        startTask = nil
        engine = nil
        engineToken += 1
        phase = nil
        channelId = nil
        callId = nil
        lines = []
        seconds = 0
        muted = false
        level = 0
        activeChanged()
    }

    /// The event stream is held while a call is open or still posting /end (a failure shown in
    /// the bar doesn't hold it).
    private func activeChanged() {
        let active = isLive || engine != nil
        guard active != reportedActive else { return }
        reportedActive = active
        onActiveChanged?(active)
    }
}
