// The two call engines (plan 2.7): GeminiLiveEngine and StepRealtimeEngine. Each is a socket
// (URLSessionLiveSocket), its codec, the CallCore state machine and the phone's audio
// (CallAudio); they differ only in the codec. The call's credential goes from the start answer
// into CallCore, which puts it in the socket's request: nothing here keeps it. A one-second
// heartbeat drives the transcript batches and the cues waiting for a quiet moment (and the
// bar's timer).
import Foundation

@MainActor
class RealtimeVoiceEngine: VoiceEngine {
    var onChange: (() -> Void)?
    var onEnded: ((Message?) -> Void)?

    private let core: CallCore
    private let audio: CallAudio
    private var micLevel: Float = 0
    private var heartbeat: Task<Void, Never>?

    init(codec: any VoiceCodec, backend: any CallBackend) {
        let audio = CallAudio(inputRate: codec.inputRate, outputRate: codec.outputRate)
        self.audio = audio
        core = CallCore(codec: codec, backend: backend, playback: audio) { request in
            URLSessionLiveSocket(request)
        }
        core.onChange = { [weak self] in self?.onChange?() }
        core.onReady = { [weak self] in self?.startMic() }
        core.onStop = { [weak self] in self?.stopAudio() }
        core.onEnded = { [weak self] message in self?.onEnded?(message) }
        audio.onChunk = { [weak self] chunk, level in self?.heard(chunk, level: level) }
        audio.onFailure = { [weak self] reason in self?.core.micFailed(reason) }
    }

    var phase: CallPhase { core.phase }
    var lastProviderError: String? { core.lastProviderError }
    var captions: [CallLine] { core.captions }
    var seconds: Int { core.seconds }

    var muted: Bool {
        get { core.muted }
        set { core.muted = newValue }
    }

    /// The voice's loudness while it speaks, the user's otherwise (0 while muted).
    var level: Float {
        switch core.phase {
        case .speaking: audio.playLevel
        case .listening, .ready: core.muted ? 0 : micLevel
        default: 0
        }
    }

    func start(_ started: StartCallResponse, channelId: String, language: String?) {
        core.begin(started, channelId: channelId, language: language)
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, !self.core.phase.isOver else { return }
                self.core.tick()
                self.onChange?()
            }
        }
    }

    func interrupt() { core.interrupt() }

    func hear(_ cue: CallCue) { core.hear(cue) }

    @discardableResult
    func end() async -> Message? {
        heartbeat?.cancel()
        heartbeat = nil
        return await core.end()
    }

    // MARK: - Audio

    /// The session is set up: the microphone starts (once per call).
    private func startMic() {
        do {
            try audio.start()
            core.micStarted()
        } catch {
            core.micFailed((error as? LocalizedError)?.errorDescription ?? String(localized: "The microphone couldn't start."))
        }
    }

    private func stopAudio() {
        heartbeat?.cancel()
        heartbeat = nil
        audio.stop()
        micLevel = 0
    }

    private func heard(_ chunk: Data, level: Float) {
        micLevel = level
        core.sendAudio(chunk)
        // The waveform follows the voice about 50 times a second (CallSession skips tiny changes).
        onChange?()
    }
}

/// Gemini Live (the server mints a short-lived token per call).
@MainActor
final class GeminiLiveEngine: RealtimeVoiceEngine {
    init(backend: any CallBackend) { super.init(codec: GeminiCodec(), backend: backend) }
}

/// StepFun Realtime (no short-lived keys: the key is held in memory for the call only).
@MainActor
final class StepRealtimeEngine: RealtimeVoiceEngine {
    init(backend: any CallBackend) { super.init(codec: StepCodec(), backend: backend) }
}
