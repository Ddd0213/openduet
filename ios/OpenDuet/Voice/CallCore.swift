// One voice call's state machine, the same for both providers. Driven by the provider's events
// (through the codec) and by the app (microphone audio, cues, interrupt, mute, end); it has no
// audio and no networking of its own: the routes come in as a `CallBackend`, the socket from a
// factory, the time and waits from a `CallClock`, the speaker as a `CallPlayback`.
// - phases: connecting → ready → listening / speaking, reconnecting, ended, failed(reason, kind)
// - transcript: one CallLine per utterance, sent to /lines every 3 s or 20 lines; unsent lines
//   ride on /tool and /end
// - tool calls go to POST /tool; a failure is answered too, never left hanging
// - cues: seq dedupe; a reply is spoken, a notice once, progress only while idle
// - barge-in: Gemini's `interrupted` and a tap cut the voice at once; StepFun's speech_started only
//   lowers the voice: it's cut once their words come back and aren't the voice's own echo (the
//   loudspeaker leaking into the microphone), a filler or a backchannel (`EchoCheck`). Meanwhile
//   the provider's own answer to them is held back: played after the voice (a backchannel), instead
//   of its rest (words) or never (an echo, its response cancelled)
// - StepFun takes one response at a time: tool answers and cues are added at once, and the
//   response.create that asks for the voice's answer goes once the last response is done
// - a watchdog: a speaker still not done 4 s after its queued audio should have played out is
//   flushed (back to listening), a response that never says done is let go after 8 s
// - a non-fatal drop reconnects with POST /api/calls {callId} (a fresh credential, the Gemini
//   handle); 5 tries, 1 / 2 / 4 / 8 / 15 s; then failed, and the call is ended through /end. The
//   voice already here plays on meanwhile; a reply the drop cut and tool answers it lost are put to
//   the new session as a notice, so the voice carries on instead of stopping. Gemini's goAway
//   waits for the reply under way.
// The credential is never stored here: it goes from the start answer into the socket's request.
// Pure Foundation (host-tested).
import Foundation
import os

/// The server routes a call uses (the app's APIClient; a fake in tests).
@MainActor
protocol CallBackend {
    func startCall(_ body: StartCallRequest) async throws -> StartCallResponse
    func sendCallLines(callId: String, _ lines: [CallLine]) async throws
    func callTool(callId: String, _ body: CallToolRequest) async throws -> CallToolResponse
    func endCall(callId: String, _ body: EndCallRequest) async throws -> Message
}

/// The time and the reconnect waits (a fake clock in tests).
@MainActor
protocol CallClock {
    var now: Date { get }
    func sleep(seconds: Double) async throws
}

struct SystemCallClock: CallClock {
    var now: Date { Date() }
    func sleep(seconds: Double) async throws { try await Task.sleep(for: .seconds(seconds)) }
}

/// The speaker: plays the voice's PCM16 and drops what's queued.
@MainActor
protocol CallPlayback: AnyObject {
    /// `done` runs once the piece has played (or was dropped).
    func play(_ pcm: Data, rate: Int, done: @escaping @MainActor () -> Void)
    func flush()
    /// Lowers the voice (true) while it's unclear whether the user talks over it, or back.
    func duck(_ on: Bool)
}

enum CallFailure: String, Hashable, Sendable {
    case microphone, connection, provider, setup
}

enum CallPhase: Hashable, Sendable {
    case connecting
    /// The session is set up; the microphone is starting.
    case ready
    case listening
    case speaking
    case reconnecting
    case ended
    case failed(reason: String, kind: CallFailure)

    var isOver: Bool {
        switch self {
        case .ended, .failed: true
        default: false
        }
    }

    var isFailed: Bool { if case .failed = self { true } else { false } }
}

@MainActor
final class CallCore {
    let codec: any VoiceCodec
    private let backend: any CallBackend
    private let clock: any CallClock
    private let openSocket: LiveSocketFactory
    private let playback: any CallPlayback
    /// The waits before each reconnect try; the call fails after the last.
    let reconnectDelays: [Double]
    /// Transcript batches: every `flushInterval` seconds or `flushCount` lines.
    let flushInterval: TimeInterval = 3
    let flushCount = 20
    /// Speech over the voice whose words haven't come back this long after it stopped: let go.
    let falseStartWait: TimeInterval = 2
    /// Speech over the voice that hasn't stopped this long: let go (the voice back at full volume).
    let bargeInLimit: TimeInterval = 6
    /// The provider answers the user's turn by itself this soon after their speech stops, or not.
    let ownAnswerWait: TimeInterval = 3
    /// The queued voice should have played out this long ago and is still queued: the speaker is
    /// stuck. Measured from when the audio queued so far ends, not from the last piece that
    /// finished: StepFun sends a reply faster than it plays (and a piece can be seconds long), so
    /// "nothing finished for 4 s" cut every reply longer than that (fixed after M15).
    let stallTimeout: TimeInterval = 4
    /// A response open this long with nothing from it: its done was lost.
    let responseTimeout: TimeInterval = 8
    /// The socket quiet this long while a reply is due (or this long at all): it's pinged; a ping
    /// unanswered this long on a socket that answered one before means it's dead (a network switch
    /// leaves the old connection silent instead of closed): it's replaced.
    let quietPing: TimeInterval = 5
    let idlePing: TimeInterval = 15
    let pongTimeout: TimeInterval = 6
    /// Speech that starts with less than this of the voice left (all of it here) isn't over it:
    /// the user answers as it ends, a normal turn.
    let endOverlap: TimeInterval = 1.5

    nonisolated private static let log = Logger(subsystem: "dev.openduet.OpenDuet", category: "call")

    private(set) var phase: CallPhase = .connecting
    private(set) var call: Call?
    private(set) var channelId: String?
    private(set) var transcript: CallTranscript
    private(set) var startedAt: Date?
    private(set) var endedAt: Date?
    /// The provider's last non-fatal complaint (in the log; kept for diagnostics and tests).
    private(set) var lastProviderError: String?
    var muted = false { didSet { if muted != oldValue { changed() } } }

    /// Anything the UI shows changed (phase, captions, mute).
    var onChange: (() -> Void)?
    /// The session is set up for the first time: start the microphone, then call `micStarted()`.
    var onReady: (() -> Void)?
    /// The call is over (ended or failed): stop the audio.
    var onStop: (() -> Void)?
    /// /end answered (nil when it couldn't be reached): the call's line for the chat.
    var onEnded: ((Message?) -> Void)?

    // The connection
    private var config: VoiceSessionConfig?
    private var language: String?
    private var socket: (any LiveSocket)?
    private var generation = 0
    private var socketReady = false
    private var everReady = false
    private var micRunning = false
    private var replacing = false
    private var attempts = 0
    private var lastDropReason: String?
    private var resumeHandle: String?
    private var reconnectTask: Task<Void, Never>?
    private var tornDown = false

    // The turn
    private var responding = false
    private var dropping = false
    private var queued = 0
    private var playEpoch = 0
    private var toolsRunning = 0
    private var userSpeaking = false
    /// A cue or a tool answer was given; the voice's answer is due (no new cue meanwhile).
    private var answerDue: Date?
    /// StepFun: the provider has a response under way (created, not yet done); and whether one
    /// was asked for (response.create sent, its response.created not yet here).
    private var responseOpen = false
    private var requested = false
    /// The last sign of the open response (or of the request).
    private var responseActivity: Date?
    /// A tool answer was added and the voice hasn't been asked to answer it yet.
    private var answerWanted = false
    /// When StepFun heard the user start talking over the voice (not yet a barge-in).
    private var bargeInAt: Date?
    /// When their speech stopped (the provider may answer their turn by itself).
    private var speechStoppedAt: Date?
    /// The provider answers the user while a barge-in waits: its voice is held back until
    /// that's settled (played after the old reply, or instead of its rest).
    private var holding = false
    private var held: [(Data, Int)] = []
    /// The held answer's response is still arriving (cancelled if it answered an echo).
    private var heldOpen = false
    /// The voice is lowered while it's unclear whether the user talks over it.
    private var ducked = false
    /// An echo was heard while the voice speaks: it isn't lowered again until it's done (the
    /// echo would come and go with the volume).
    private var echoHeard = false
    /// The voice's echo was dropped before the provider answered it: an answer it starts by itself
    /// soon after (or soon after the response under way) answers the echo and is cancelled.
    private var echoAnswerAt: Date?
    /// Given to the voice (tool answers, cues) and not answered yet: a drop loses them.
    private var unanswered: [String] = []
    /// After a drop: the reply it cut (or the turn it was about to answer), told to the next
    /// session once it's quiet; dropped if the user moves on first (they talk, or tap).
    private var resumeCut: String?
    /// Gemini's goAway came while the voice answers: the session is replaced after it.
    private var replaceAfterTurn = false
    /// StepFun: the conversation item of the user's words about to come (taken out if an echo).
    private var lastInputItem: String?
    /// The socket's last frame (or pong), the ping waiting for its pong, and whether this socket
    /// ever answered one (a server that doesn't is never taken for dead).
    private var heardAt: Date?
    private var pingSentAt: Date?
    private var pongSeen = false
    /// Voice played since the last thing was given (its answer, unless that turn was cut).
    private var voiceSinceGiven = false
    /// A tool answer waited to be asked for when the held answer started (asked again if dropped).
    private var heldWanted = false
    /// The held answer's words and tool calls: shown and run if it plays, never if it's an echo's.
    private var heldText: [(String, Bool)] = []
    private var heldTools: [(id: String, name: String, argumentsJSON: String)] = []
    /// When everything queued should have played (each piece's own length after the one before);
    /// nil while nothing is queued.
    private var playEndsAt: Date?
    private var pendingCues: [String] = []
    private var lastSeq = Int64.min
    private var announced = Set<String>()

    // The transcript upload
    private var lastFlush: Date?
    private var sendingLines = false

    private var tasks: [Int: Task<Void, Never>] = [:]
    private var nextTask = 0
    private(set) var finishing: Task<Message?, Never>?
    /// The provider needs to be asked for each answer, one response at a time (StepFun).
    private let sequenced: Bool

    init(codec: any VoiceCodec, backend: any CallBackend, clock: any CallClock = SystemCallClock(),
         playback: any CallPlayback, reconnectDelays: [Double] = [1, 2, 4, 8, 15],
         makeLineId: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() },
         openSocket: @escaping LiveSocketFactory) {
        self.codec = codec
        self.backend = backend
        self.clock = clock
        self.playback = playback
        self.reconnectDelays = reconnectDelays
        self.openSocket = openSocket
        sequenced = !codec.respond().isEmpty
        transcript = CallTranscript(makeId: makeLineId)
    }

    // MARK: - The app's side

    /// Opens the session of a started call (POST /api/calls answered). The answer's credential
    /// goes into the socket's request and isn't kept.
    func begin(_ started: StartCallResponse, channelId: String, language: String?) {
        guard call == nil, !phase.isOver else { return }
        call = started.call
        self.channelId = channelId
        self.language = language
        startedAt = clock.now
        lastFlush = startedAt
        phase = .connecting
        connect(started)
        changed()
    }

    /// The microphone delivers (after `onReady`).
    func micStarted() {
        guard !phase.isOver else { return }
        micRunning = true
        if phase == .ready { phase = .listening }
        changed()
        flushCues()
    }

    /// The microphone couldn't start.
    func micFailed(_ reason: String) { fail(reason, .microphone) }

    /// A 20 ms piece of the microphone, PCM16 at the codec's input rate (dropped while muted).
    func sendAudio(_ pcm: Data) {
        tick()
        guard socketReady, !muted, let socket else { return }
        socket.send(codec.audio(pcm))
    }

    /// Time-driven work: a barge-in to settle, the watchdog, cues waiting for a quiet moment, tool
    /// answers waiting for the last response and the transcript batch.
    func tick() {
        guard let call, !phase.isOver else { return }
        watch()
        flushCues()
        answerTools()
        guard !sendingLines, !transcript.unsent.isEmpty else { return }
        let waited = clock.now.timeIntervalSince(lastFlush ?? .distantPast)
        if transcript.unsent.count >= flushCount || waited >= flushInterval { flushLines(call.id) }
    }

    /// What the server wants the voice to say (SSE `call`).
    func hear(_ cue: CallCue) {
        guard let call, cue.callId == call.id, !phase.isOver, cue.seq > lastSeq else { return }
        lastSeq = cue.seq
        let text = cue.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        switch cue.kind {
        case .reply:
            pendingCues.append(CueText.reply(text))
        case .notice:
            guard announced.insert(text).inserted else { return }
            pendingCues.append(CueText.notice(text))
        case .progress:
            // Only a quiet moment is worth filling; a busy one drops it.
            guard isIdle, pendingCues.isEmpty else { return }
            pendingCues.append(CueText.progress(text))
        }
        flushCues()
    }

    /// The user cut the voice short (tapped while it speaks).
    func interrupt() {
        guard !phase.isOver else { return }
        // Tapped during a reconnect: the cut reply isn't picked up again either.
        resumeCut = nil
        guard phase == .speaking || responding || queued > 0 || holding else { return }
        cutShort(cancel: responding, dropRest: responding)
    }

    /// Hangs up: closes the socket, stops the audio and posts /end with the seconds and the
    /// unsent lines. Idempotent: a second call answers the same message.
    @discardableResult
    func end() async -> Message? {
        if !phase.isOver {
            phase = .ended
            teardown()
            changed()
        }
        return await startFinishing().value
    }

    /// Waits for the requests under way (tool calls, transcript batches).
    func settle() async {
        while let first = tasks.first {
            await first.value.value
            tasks[first.key] = nil
        }
    }

    /// The call's length so far (or in all, once over), 0…86 400 s.
    var seconds: Int {
        guard let startedAt else { return 0 }
        let elapsed = (endedAt ?? clock.now).timeIntervalSince(startedAt)
        return max(0, min(86_400, Int(elapsed.rounded())))
    }

    var captions: [CallLine] { transcript.captions }

    // MARK: - The connection

    private func connect(_ started: StartCallResponse) {
        let config = VoiceSessionConfig(
            model: started.model, voice: started.call.voice, instructions: started.instructions,
            tools: started.tools, resumeHandle: codec.engine == .gemini ? resumeHandle : nil
        )
        self.config = config
        guard let request = codec.request(url: started.url, credential: started.credential) else {
            return fail(String(localized: "The voice service's address isn't valid."), .setup)
        }
        generation += 1
        socketReady = false
        heardAt = clock.now
        pingSentAt = nil
        pongSeen = false
        let socket = openSocket(request)
        self.socket = socket
        for frame in codec.setup(config) { socket.send(frame) }
        receive(on: socket, generation: generation)
    }

    private func receive(on socket: any LiveSocket, generation: Int) {
        Task { [weak self] in
            while true {
                let frame: String
                do {
                    frame = try await socket.receive()
                } catch {
                    self?.dropped(socket, generation: generation)
                    return
                }
                guard let self, self.generation == generation else { return }
                // Any frame shows the socket is alive (a pong can sit behind seconds of audio).
                heardAt = clock.now
                pingSentAt = nil
                for event in codec.decode(frame) {
                    guard self.generation == generation, !phase.isOver else { return }
                    handle(event)
                }
            }
        }
    }

    private func dropped(_ socket: any LiveSocket, generation: Int) {
        guard generation == self.generation, !phase.isOver else { return }
        let code = socket.closeCode
        let reason = socket.closeReason.trimmingCharacters(in: .whitespacesAndNewlines)
        self.socket = nil
        socketReady = false
        if codec.isFatal(closeCode: code) {
            return fail(reason.isEmpty ? String(localized: "The voice service ended the call.") : reason, .provider)
        }
        // The first session never came up: the provider refused it, a retry won't help.
        guard everReady else {
            return fail(reason.isEmpty ? String(localized: "Couldn't connect to the voice service.") : reason, .connection)
        }
        if replacing {
            replacing = false
            return reconnect(retry: false, reason: reason)
        }
        reconnect(retry: true, reason: reason)
    }

    /// Carries on in a new session: at once after goAway, else after the next wait.
    private func reconnect(retry: Bool, reason: String) {
        if !reason.isEmpty { lastDropReason = reason }
        noteLost()
        transcript.finishAll()
        // The voice already here plays on: a network wobble doesn't cut what was received.
        responding = false
        dropping = false
        userSpeaking = false
        answerDue = nil
        toolsRunning = 0
        responseOpen = false
        requested = false
        answerWanted = false
        speechStoppedAt = nil
        echoAnswerAt = nil
        replaceAfterTurn = false
        lastInputItem = nil
        dropHeld()
        phase = .reconnecting
        changed()
        var delay = 0.0
        if retry {
            guard attempts < reconnectDelays.count else {
                return fail(lastDropReason ?? String(localized: "Lost the connection to the voice service."), .connection)
            }
            delay = reconnectDelays[attempts]
            attempts += 1
        }
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            if delay > 0 { try? await self?.clock.sleep(seconds: delay) }
            guard !Task.isCancelled else { return }
            await self?.resume()
        }
    }

    /// POST /api/calls again with the call's id (a fresh credential), then a new socket.
    private func resume() async {
        guard phase == .reconnecting, let call, let channelId else { return }
        // The newest lines first: the new session's "This call so far" is read from them (on the
        // first try only: a network that swallows requests would make every try twice as long).
        let batch = attempts <= 1 ? transcript.take() : []
        if !batch.isEmpty {
            do {
                try await backend.sendCallLines(callId: call.id, batch)
            } catch {
                transcript.putBack(batch)
            }
            guard phase == .reconnecting else { return }
        }
        let body = StartCallRequest(channelId: channelId, callId: call.id, language: language)
        do {
            let started = try await backend.startCall(body)
            guard phase == .reconnecting else { return }
            connect(started)
        } catch {
            guard phase == .reconnecting else { return }
            if let api = error as? APIError, api == .notFound || api == .notConfigured || api == .unauthorized {
                return fail(api.localizedReason, .setup)
            }
            reconnect(retry: true, reason: "")
        }
    }

    private func send(_ frame: String) {
        socket?.send(frame)
    }

    // MARK: - The provider's side

    private func handle(_ event: EngineEvent) {
        switch event {
        case .ready:
            becameReady()
        case .audio(let pcm, let rate):
            voiceAudio(pcm, rate: rate)
        case .inputText(let text, let final):
            if final {
                userSpeaking = false
                let item = lastInputItem
                lastInputItem = nil
                // Words over the voice are judged first: its own echo is no line of the user's.
                let overVoice = bargeInAt != nil
                let verdict = overVoice ? judge(text) : .words
                if verdict == .echo {
                    transcript.drop(.user)
                } else {
                    transcript.complete(.user, text, at: clock.now)
                    // They moved on: a reply a drop cut isn't picked up again.
                    if verdict == .words { resumeCut = nil }
                }
                // Acted on once their line is in (a held hand-off carries their words).
                if overVoice { settleBargeIn(verdict) }
                // The echo is no turn in the provider's conversation either (after its answer is
                // cancelled; it'd answer it later).
                if verdict == .echo, let item { codec.forget(item: item).forEach(send) }
            } else {
                transcript.add(.user, text, at: clock.now)
            }
            changed()
            if final {
                flushCues()
                answerTools()
            }
        case .inputItem(let id):
            lastInputItem = id
        case .outputText(let text, let final):
            guard !dropping else { return }
            noteResponse()
            // The held answer's words wait with its audio (none of it if it answers an echo).
            if holding {
                heldText.append((text, final))
                return
            }
            transcript.finish(.user)
            if final { transcript.complete(.voice, text, at: clock.now) } else { transcript.add(.voice, text, at: clock.now) }
            changed()
        case .turnComplete:
            turnEnded()
        case .responseStarted:
            responseStarted()
        case .interrupted:
            cutShort(cancel: false, dropRest: false)
        case .speechStarted:
            speechStarted()
        case .speechStopped:
            speechStopped()
        case .toolCall(let id, let name, let argumentsJSON):
            noteResponse()
            // A cancelled response's (an answer to an echo, a reply talked over) isn't run: the
            // provider still gets an answer, so nothing waits on it.
            if dropping, sequenced {
                codec.toolResult(id: id, name: name, result: Self.notRun).forEach(send)
            } else if holding {
                // The held answer's: run if it plays, never if it answers an echo.
                heldTools.append((id, name, argumentsJSON))
            } else {
                runTool(id: id, name: name, argumentsJSON: argumentsJSON)
            }
        case .resumeHandle(let handle):
            resumeHandle = handle
        case .goAway:
            // The session ends soon (Gemini says when): the reply under way finishes first.
            replacing = true
            if responding { replaceAfterTurn = true } else { socket?.close() }
        case .error(let message, let fatal):
            Self.log.error("voice provider error (fatal: \(fatal, privacy: .public)): \(message, privacy: .private)")
            if fatal { fail(message, .provider) } else { lastProviderError = message }
        }
    }

    private func becameReady() {
        guard !socketReady else { return }
        socketReady = true
        attempts = 0
        lastDropReason = nil
        // One ping at once: a socket that answers it can be told dead later by one it doesn't.
        sendPing()
        if everReady {
            // The voice that arrived before the drop may still be playing.
            phase = micRunning ? (queued > 0 ? .speaking : .listening) : .ready
            changed()
        } else {
            everReady = true
            phase = .ready
            changed()
            onReady?()
        }
        flushCues()
    }

    private func voiceAudio(_ pcm: Data, rate: Int) {
        // The late audio of a reply that was talked over isn't played.
        guard !dropping else { return }
        noteResponse()
        transcript.finish(.user)
        // Still the old reply while a barge-in waits: the user may be talking.
        if bargeInAt == nil || holding { userSpeaking = false }
        responding = true
        answerDue = nil
        if holding {
            held.append((pcm, rate))
            return
        }
        enqueue(pcm, rate: rate)
    }

    private func enqueue(_ pcm: Data, rate: Int) {
        // PCM16 mono: two bytes a sample. It plays after what's queued, or now.
        let length = rate > 0 ? Double(pcm.count / 2) / Double(rate) : 0
        let start = max(playEndsAt ?? clock.now, clock.now)
        playEndsAt = start.addingTimeInterval(length)
        queued += 1
        voiceSinceGiven = true
        let epoch = playEpoch
        playback.play(pcm, rate: rate) { [weak self] in self?.played(epoch) }
        if phase == .listening || phase == .ready {
            phase = .speaking
            changed()
        }
    }

    private func played(_ epoch: Int) {
        guard epoch == playEpoch, queued > 0 else { return }
        queued -= 1
        guard queued == 0 else { return }
        playEndsAt = nil
        // Under speech still being judged, a held answer waits for the verdict (it may be an echo's).
        if held.isEmpty, !responding, !holding { finishedSpeaking() }
    }

    private func turnEnded() {
        // What was given has been answered once a whole turn spoke after it (not a cut one).
        if !dropping, voiceSinceGiven, !requested, !answerWanted { unanswered.removeAll() }
        dropping = false
        responding = false
        answerDue = nil
        // A done before the response asked for has started is an earlier one's.
        if !requested { responseOpen = false }
        // The provider answers the dropped echo after the response under way: the wait starts now.
        if echoAnswerAt != nil { echoAnswerAt = clock.now }
        // The held answer's words are held with it (its line is made when it plays).
        if holding { heldOpen = false } else { transcript.finish(.voice) }
        transcript.finish(.user)
        changed()
        if queued == 0, held.isEmpty { finishedSpeaking() }
        answerTools()
        // Gemini's goAway came during the reply: the session is replaced now it's done.
        if replaceAfterTurn {
            replaceAfterTurn = false
            socket?.close()
        }
    }

    private func finishedSpeaking() {
        echoHeard = false
        if phase == .speaking {
            phase = .listening
            changed()
        }
        flushCues()
    }

    /// A sign of the provider's response (StepFun may skip response.created; Gemini isn't tracked).
    private func noteResponse() {
        guard sequenced else { return }
        responseOpen = true
        responseActivity = clock.now
    }

    /// StepFun started a response: the one asked for, or its own answer to the user's turn.
    private func responseStarted() {
        let ours = requested
        let wanted = answerWanted
        requested = false
        responseOpen = true
        responseActivity = clock.now
        // Responses come one at a time: the last one is over, and anything added is answered.
        dropping = false
        responding = false
        answerWanted = false
        transcript.finish(.voice)
        changed()
        guard !ours else { return }
        // Its own answer: the user's turn ended.
        userSpeaking = false
        if echoAnswerAt != nil {
            // It answers the voice's own echo (dropped already): cancelled, never played; what was
            // added meanwhile is still to be answered.
            echoAnswerAt = nil
            codec.cancelResponse().forEach(send)
            dropping = true
            answerWanted = wanted
            Self.log.notice("call: the provider answered the voice's echo; cancelled")
            return
        }
        // Speech over the voice isn't judged yet (it may be the voice's echo): the answer waits,
        // even when the voice has played out meanwhile.
        if bargeInAt != nil {
            holding = true
            heldOpen = true
            heldWanted = wanted
            Self.log.debug("call: the provider answers speech over the voice that isn't settled; held")
        }
    }

    /// The provider is about to answer the user's turn by itself (asking now would collide).
    private var providerAnswers: Bool {
        guard sequenced, let speechStoppedAt else { return false }
        return clock.now.timeIntervalSince(speechStoppedAt) < ownAnswerWait
    }

    /// Asks for the voice's answer to the tool results added, once the last response is done,
    /// no tool is still running (one answer for them all) and nobody is talking.
    private func answerTools() {
        guard answerWanted, socketReady, !responseOpen, toolsRunning == 0, !userSpeaking,
              bargeInAt == nil, !providerAnswers else { return }
        answerWanted = false
        answerDue = clock.now
        requestAnswer()
    }

    /// StepFun's response.create (nothing for Gemini, which answers by itself).
    private func requestAnswer() {
        let frames = codec.respond()
        guard !frames.isEmpty else { return }
        frames.forEach(send)
        requested = true
        responseOpen = true
        responseActivity = clock.now
        // Asked for by the phone: not an answer to an echo.
        echoAnswerAt = nil
    }

    // MARK: - Barge-in

    /// Something a barge-in would cut: queued voice, or a reply still arriving (not a held one).
    private var cuttable: Bool { queued > 0 || (responding && !holding) }

    private func speechStarted() {
        userSpeaking = true
        speechStoppedAt = nil
        // A new turn of theirs: what the provider answers next answers it (over the voice, it's
        // held and judged by these words).
        echoAnswerAt = nil
        // An echo or a cough trips the VAD as well as the user: the voice is only lowered until
        // their words come back. Not again after an echo while it speaks (it'd come and go with
        // the volume). Not over the voice's last moment: they answer as it ends.
        if bargeInAt == nil, cuttable, !endingSoon {
            bargeInAt = clock.now
            if !echoHeard { setDucked(true) }
            Self.log.notice("call: speech over the voice; lowered until its words are in")
        }
    }

    private func speechStopped() {
        speechStoppedAt = clock.now
    }

    /// The whole reply is here and less than `endOverlap` of it is left to play.
    private var endingSoon: Bool {
        guard !responding, let playEndsAt else { return false }
        return playEndsAt.timeIntervalSince(clock.now) < endOverlap
    }

    /// The words of speech over the voice: the voice's own echo (dropped, the voice carries on),
    /// unsure, a filler or a backchannel (the voice carries on, the provider's answer after it)
    /// or words (the voice is cut, the answer plays instead).
    private func judge(_ text: String) -> EchoCheck.Verdict {
        // The voice's lines (the held answer's words aren't among them: they're held with it).
        let verdict = EchoCheck.verdict(text, voice: transcript.recent(.voice, 3))
        Self.log.notice("call: speech over the voice was \(verdict.rawValue, privacy: .public)")
        return verdict
    }

    private func settleBargeIn(_ verdict: EchoCheck.Verdict) {
        switch verdict {
        case .echo: dropEcho()
        case .unsure, .filler: dismissBargeIn()
        case .words: confirmBargeIn()
        }
    }

    /// Speech over the voice whose words never came: stopped and 2 s without them, or still going
    /// after 6 s. The voice goes on at full volume, a held answer after it.
    private func watchBargeIn() {
        guard let bargeInAt else { return }
        let now = clock.now
        if let speechStoppedAt {
            guard now.timeIntervalSince(speechStoppedAt) >= falseStartWait else { return }
        } else {
            guard now.timeIntervalSince(bargeInAt) >= bargeInLimit else { return }
        }
        Self.log.notice("call: speech over the voice had no words in time; let go")
        dismissBargeIn()
    }

    /// The user talks over the voice: what's queued stops; a reply still arriving is cancelled;
    /// the provider's answer to them, if it started, plays instead.
    private func confirmBargeIn() {
        Self.log.notice("call: barge-in confirmed; the voice's reply was cut")
        if holding {
            endBargeIn()
            flushPlayback()
            changed()
            releaseHeld()
        } else {
            cutShort(cancel: responding, dropRest: responding)
        }
    }

    /// It wasn't words for the voice: it carries on, a held answer after it.
    private func dismissBargeIn() {
        endBargeIn()
        releaseHeld()
    }

    /// The voice heard itself: it carries on at full volume; the provider's answer to the echo is
    /// dropped (its response cancelled if still arriving) or, not started yet, cancelled when it
    /// starts.
    private func dropEcho() {
        echoHeard = true
        let wasHolding = holding
        let stillArriving = heldOpen
        let wanted = heldWanted
        // Its words, audio and tool calls go unseen, unheard and unrun.
        dropHeld()
        if wasHolding {
            if stillArriving {
                codec.cancelResponse().forEach(send)
                dropping = true
                responding = false
            }
            // A tool answer it took over is asked for again.
            if wanted { answerWanted = true }
        } else {
            echoAnswerAt = clock.now
        }
        if queued == 0, !responding { finishedSpeaking() }
        changed()
    }

    /// The held answer plays: its words become its line (left open if more are coming), its audio
    /// is queued and its tool calls run.
    private func releaseHeld() {
        let wasHolding = holding
        let stillArriving = heldOpen
        holding = false
        heldOpen = false
        heldWanted = false
        let pieces = held, texts = heldText, tools = heldTools
        held = []
        heldText = []
        heldTools = []
        for (text, final) in texts {
            if final { transcript.complete(.voice, text, at: clock.now) } else { transcript.add(.voice, text, at: clock.now) }
        }
        if wasHolding, !stillArriving { transcript.finish(.voice) }
        if !texts.isEmpty { changed() }
        for (pcm, rate) in pieces { enqueue(pcm, rate: rate) }
        for tool in tools { runTool(id: tool.id, name: tool.name, argumentsJSON: tool.argumentsJSON) }
        if queued == 0, !responding { finishedSpeaking() }
    }

    /// The held answer is thrown away; its tool calls are answered (not run), so nothing waits.
    private func dropHeld() {
        endBargeIn()
        let tools = heldTools
        holding = false
        heldOpen = false
        heldWanted = false
        held = []
        heldText = []
        heldTools = []
        for tool in tools { codec.toolResult(id: tool.id, name: tool.name, result: Self.notRun).forEach(send) }
    }

    /// Speech over the voice is settled: back at full volume.
    private func endBargeIn() {
        bargeInAt = nil
        setDucked(false)
    }

    private func setDucked(_ on: Bool) {
        guard ducked != on else { return }
        ducked = on
        playback.duck(on)
    }

    // MARK: - The watchdog

    /// Every tick: a barge-in to settle, a provider that didn't answer the user's turn, a stuck
    /// speaker, a response whose done was lost.
    private func watch() {
        watchBargeIn()
        watchSocket()
        // The provider didn't answer the dropped echo: its next answer is the user's again.
        if let echoAnswerAt, !responseOpen, clock.now.timeIntervalSince(echoAnswerAt) >= ownAnswerWait {
            self.echoAnswerAt = nil
        }
        let now = clock.now
        if let speechStoppedAt, bargeInAt == nil, now.timeIntervalSince(speechStoppedAt) >= ownAnswerWait {
            // It didn't answer their turn: asking is safe again (and nobody is talking).
            self.speechStoppedAt = nil
            userSpeaking = false
        }
        // Pieces that should have played out long ago and still haven't finished (a route change
        // can leave the player silent): dropped, back to listening, so the cues and the next
        // replies aren't held behind them. Never while the voice is still playing what it was sent.
        if queued > 0, !responding, bargeInAt == nil, let playEndsAt,
           now.timeIntervalSince(playEndsAt) >= stallTimeout {
            let stuck = queued
            Self.log.error("call: playback stalled with \(stuck, privacy: .public) pieces queued; back to listening")
            flushPlayback()
            transcript.finish(.voice)
            finishedSpeaking()
        }
        if responseOpen, let responseActivity, now.timeIntervalSince(responseActivity) >= responseTimeout {
            Self.log.error("call: the provider's response never finished; going on without it")
            responseOpen = false
            requested = false
            responding = false
            if queued == 0, held.isEmpty { finishedSpeaking() }
        }
    }

    /// A quiet socket is pinged; one that answered a ping before and now doesn't is dead: closed,
    /// so the call reconnects (the voice already here plays on) instead of waiting minutes.
    private func watchSocket() {
        guard socketReady, let socket, let heardAt else { return }
        let now = clock.now
        if let pingSentAt {
            guard now.timeIntervalSince(pingSentAt) >= pongTimeout else { return }
            self.pingSentAt = nil
            // Never answered one: it may not answer pings at all; asked again later.
            guard pongSeen else { return }
            Self.log.error("call: the voice service stopped answering; reconnecting")
            socket.close()
            return
        }
        let due = responding || responseOpen || toolsRunning > 0 ? quietPing : idlePing
        guard now.timeIntervalSince(heardAt) >= due else { return }
        sendPing()
    }

    private func sendPing() {
        guard let socket else { return }
        pingSentAt = clock.now
        let generation = self.generation
        socket.ping { [weak self] in
            guard let self, self.generation == generation else { return }
            pongSeen = true
            pingSentAt = nil
            heardAt = clock.now
        }
    }

    /// Barge-in: what's queued stops at once; `cancel` asks the provider to stop the response,
    /// `dropRest` ignores what's still on its way of it.
    private func cutShort(cancel: Bool, dropRest: Bool) {
        dropHeld()
        flushPlayback()
        if cancel { codec.cancelResponse().forEach(send) }
        if dropRest { dropping = true }
        responding = false
        transcript.finish(.voice)
        if phase == .speaking { phase = .listening }
        changed()
    }

    private func flushPlayback() {
        playEpoch += 1
        queued = 0
        playEndsAt = nil
        playback.flush()
    }

    // MARK: - Tools

    private func runTool(id: String, name: String, argumentsJSON: String) {
        guard let call else { return }
        transcript.finish(.user)
        let lines = transcript.take()
        let arguments = JSONValue.parse(argumentsJSON)?.object ?? [:]
        let generation = self.generation
        toolsRunning += 1
        changed()
        track { [weak self] in
            guard let self else { return }
            let result: String
            do {
                let body = CallToolRequest(name: name, arguments: arguments, lines: lines)
                result = try await backend.callTool(callId: call.id, body).result
            } catch {
                transcript.putBack(lines)
                result = Self.toolFailure(error)
            }
            guard !phase.isOver else { return }
            guard self.generation == generation else {
                // Its session dropped meanwhile: the new one is told, so the answer isn't lost.
                pendingCues.append(CueText.lostAnswer(name, result))
                flushCues()
                return
            }
            toolsRunning = max(0, toolsRunning - 1)
            // Added at once; the voice is asked to answer once it's free (StepFun).
            codec.toolResult(id: id, name: name, result: result).forEach(send)
            given(CueText.lostAnswer(name, result))
            answerWanted = true
            answerTools()
        }
    }

    /// What a cancelled response's tool call is answered with (model-facing, English).
    static let notRun = "Not done: this response was cancelled."

    // MARK: - A drop

    /// Something the voice was given to answer (kept until a whole turn of it speaks after).
    private func given(_ text: String) {
        unanswered.append(String(text.prefix(1200)))
        if unanswered.count > 4 { unanswered.removeFirst(unanswered.count - 4) }
        voiceSinceGiven = false
    }

    /// The session dropped: what it was saying and what it hadn't answered yet are put to the
    /// next one, so the voice carries on instead of stopping (a reply cut midway, tool answers or
    /// cues lost with the session, the user's turn it was about to answer).
    private func noteLost() {
        let saying = transcript.openText(.voice)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // A tool still running speaks for itself when its answer comes (asked again, the voice
        // could hand the same thing to the assistant twice); a cancelled response is no answer to finish.
        let carries = toolsRunning == 0 && !holding && !dropping
        if carries, responding || !saying.isEmpty {
            resumeCut = CueText.cutReply(saying)
        } else if carries, responseOpen, !requested, unanswered.isEmpty {
            resumeCut = CueText.unansweredTurn(transcript.recent(.user, 1).first ?? "")
        }
        // Answers and cues it lost are still owed, whatever the user does next.
        pendingCues.insert(contentsOf: unanswered, at: 0)
        let lost = !unanswered.isEmpty
        unanswered.removeAll()
        if resumeCut != nil || lost {
            Self.log.notice("call: the session dropped mid-answer; the next one carries on")
        }
    }

    /// The answer for the voice model when a tool request failed (model-facing, English).
    static func toolFailure(_ error: any Error) -> String {
        switch error as? APIError {
        case .validationFailed(_, let message)? where !message.isEmpty:
            "That didn't go through: \(message). Tell the user."
        case .unreachable?:
            "That didn't go through: OpenDuet's server couldn't be reached. Tell the user and offer to try again."
        default:
            "That didn't go through: the server answered with an error. Tell the user and offer to try again."
        }
    }

    // MARK: - Cues

    /// Nobody is talking and nothing is on its way: a cue can be said.
    private var isIdle: Bool {
        guard socketReady, !responding, !responseOpen, queued == 0, held.isEmpty, toolsRunning == 0,
              !userSpeaking, bargeInAt == nil, !providerAnswers, !transcript.isOpen(.user) else { return false }
        guard let answerDue else { return true }
        return clock.now.timeIntervalSince(answerDue) > 10
    }

    private func flushCues() {
        guard !pendingCues.isEmpty || resumeCut != nil, isIdle else { return }
        // A reply a drop cut goes first, unless the user moved on meanwhile.
        let text = ([resumeCut].compactMap { $0 } + pendingCues).joined(separator: "\n\n")
        resumeCut = nil
        pendingCues.removeAll()
        codec.say(text).forEach(send)
        given(text)
        // One answer for the cues and any tool answer added.
        answerWanted = false
        answerDue = clock.now
        requestAnswer()
    }

    // MARK: - Transcript upload

    private func flushLines(_ callId: String) {
        let batch = transcript.take()
        guard !batch.isEmpty else { return }
        lastFlush = clock.now
        sendingLines = true
        track { [weak self] in
            guard let self else { return }
            do {
                try await backend.sendCallLines(callId: callId, batch)
            } catch {
                transcript.putBack(batch)
            }
            sendingLines = false
        }
    }

    // MARK: - The end

    private func fail(_ reason: String, _ kind: CallFailure) {
        guard !phase.isOver else { return }
        phase = .failed(reason: reason, kind: kind)
        teardown()
        changed()
        _ = startFinishing()
    }

    private func teardown() {
        generation += 1
        socket?.close()
        socket = nil
        socketReady = false
        reconnectTask?.cancel()
        reconnectTask = nil
        flushPlayback()
        dropHeld()
        responding = false
        responseOpen = false
        requested = false
        answerWanted = false
        pendingCues.removeAll()
        resumeCut = nil
        unanswered.removeAll()
        echoAnswerAt = nil
        heldText = []
        heldTools = []
        replaceAfterTurn = false
        transcript.finishAll()
        config = nil
        guard !tornDown else { return }
        tornDown = true
        endedAt = clock.now
        onStop?()
    }

    /// POST /end once (after the requests under way, the lines over one batch sent first).
    private func startFinishing() -> Task<Message?, Never> {
        if let finishing { return finishing }
        let task = Task { [weak self] () -> Message? in
            guard let self, let call else { return nil }
            await settle()
            while transcript.unsent.count > CallTranscript.batchLimit {
                let batch = transcript.take()
                do {
                    try await backend.sendCallLines(callId: call.id, batch)
                } catch {
                    transcript.putBack(batch)
                    break
                }
            }
            let body = EndCallRequest(seconds: seconds, lines: transcript.take())
            let message = try? await backend.endCall(callId: call.id, body)
            onEnded?(message)
            return message
        }
        finishing = task
        return task
    }

    private func track(_ work: @escaping @MainActor () async -> Void) {
        let key = nextTask
        nextTask += 1
        tasks[key] = Task { [weak self] in
            await work()
            self?.tasks[key] = nil
        }
    }

    private func changed() { onChange?() }
}
