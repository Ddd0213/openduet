// The call's audio on the phone: AVAudioSession .playAndRecord / .voiceChat (the system's echo
// cancellation), the speaker by default, Bluetooth headsets allowed; the voice-processing
// microphone and an AVAudioPlayerNode for the voice. The microphone tap runs on a realtime
// thread: it only copies the samples into an AsyncStream; resampling to the codec's rate, the
// 20 ms chunks and the loudness are done off the main actor, and only finished chunks come back.
// A phone call or Siri pauses the call's audio and gives it back; a route change (AirPods)
// restarts the engine.
import AVFoundation
import Foundation

@MainActor
final class CallAudio: CallPlayback {
    /// A 20 ms PCM16 chunk at the codec's input rate, and its loudness (0…1).
    var onChunk: ((Data, Float) -> Void)?
    /// The audio couldn't come back after an interruption.
    var onFailure: ((String) -> Void)?
    /// The voice's loudness as it plays (0…1).
    private(set) var playLevel: Float = 0

    private let inputRate: Int
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let playFormat: AVAudioFormat?
    private var running = false
    private var paused = false
    private var sessionActive = false
    private var observers: [any NSObjectProtocol] = []
    private var continuation: AsyncStream<MicBuffer>.Continuation?
    private var pump: Task<Void, Never>?

    init(inputRate: Int, outputRate: Int) {
        self.inputRate = inputRate
        playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(outputRate), channels: 1, interleaved: false)
    }

    /// Starts the session, the microphone and the speaker.
    func start() throws {
        guard !running else { return }
        try activateSession()
        try engine.inputNode.setVoiceProcessingEnabled(true)
        engine.attach(player)
        player.volume = 1
        startPump()
        observe()
        try run()
        running = true
    }

    func stop() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        continuation?.finish()
        continuation = nil
        pump?.cancel()
        pump = nil
        if running {
            player.stop()
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            running = false
        }
        paused = false
        playLevel = 0
        if sessionActive {
            sessionActive = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    // MARK: - CallPlayback

    func play(_ pcm: Data, rate: Int, done: @escaping @MainActor () -> Void) {
        guard running, let format = playFormat, pcm.count >= 2 else { return done() }
        var samples = PCM.floats(pcm)
        let target = Int(format.sampleRate)
        if rate != target { samples = PCM.resample(samples, from: rate, to: target) }
        guard !samples.isEmpty,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let out = buffer.floatChannelData?[0] else { return done() }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in
            guard let base = source.baseAddress else { return }
            out.update(from: base, count: samples.count)
        }
        playLevel = PCM.level(samples)
        // Played back (not only rendered): what the user has heard, for barge-in and the cues.
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in
            Task { @MainActor in done() }
        }
    }

    /// The voice's volume while speech over it is judged (an echo, or the user cutting in).
    static let duckedVolume: Float = 0.35

    func duck(_ on: Bool) {
        player.volume = on ? Self.duckedVolume : 1
    }

    func flush() {
        playLevel = 0
        guard running else { return }
        player.stop()
        // Stopping drops what's scheduled; a running engine plays the next pieces again.
        if engine.isRunning { player.play() }
    }

    // MARK: - The engine

    private func activateSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
        sessionActive = true
    }

    /// Wires the speaker and taps the microphone for the current hardware, then starts.
    private func run() throws {
        // Wired again on every start, both links: after a reconfiguration the old connections stay
        // but play nothing, so the voice's pieces never finish and the call waits on them.
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        let format = input.outputFormat(forBus: 0)
        // No usable input (no microphone, mid route change): a tap on 0 Hz would crash.
        guard format.sampleRate > 0, format.channelCount > 0, let continuation else { throw MicUnavailable() }
        input.installTap(onBus: 0, bufferSize: 2048, format: format, block: Self.tap(continuation))
        engine.prepare()
        try engine.start()
        player.play()
    }

    /// The tap block, built off the main actor: it runs on the audio thread and only copies.
    nonisolated private static func tap(_ continuation: AsyncStream<MicBuffer>.Continuation) -> AVAudioNodeTapBlock {
        { buffer, _ in
            guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
            let samples = Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
            continuation.yield(MicBuffer(samples: samples, rate: Int(buffer.format.sampleRate)))
        }
    }

    /// Microphone buffers → the codec's rate → 20 ms PCM16 chunks, off the main actor.
    private func startPump() {
        let (stream, continuation) = AsyncStream.makeStream(of: MicBuffer.self, bufferingPolicy: .bufferingNewest(64))
        self.continuation = continuation
        let target = inputRate
        pump = Task.detached { [weak self] in
            var resampler: Resampler?
            var chunker = PCMChunker(rate: target)
            for await buffer in stream {
                if resampler?.source != buffer.rate { resampler = Resampler(from: buffer.rate, to: target) }
                guard var current = resampler else { continue }
                let samples = current.process(buffer.samples)
                resampler = current
                let level = PCM.level(samples)
                for chunk in chunker.push(PCM.int16(samples)) {
                    await self?.deliver(chunk, level: level)
                }
            }
        }
    }

    private func deliver(_ chunk: Data, level: Float) {
        guard running, !paused else { return }
        onChunk?(chunk, level)
    }

    // MARK: - Interruptions and routes

    private func observe() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            MainActor.assumeIsolated { [weak self] in
                switch type {
                case .began: self?.interrupted()
                case .ended: self?.resume()
                default: break
                }
            }
        })
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in
            MainActor.assumeIsolated { [weak self] in self?.reconfigured() }
        })
    }

    /// Another app took the audio: the voice stops, the microphone sends nothing.
    private func interrupted() {
        guard running else { return }
        paused = true
        player.stop()
        playLevel = 0
    }

    /// The audio came back (a phone call is always taken back: this is a call too).
    private func resume() {
        guard running, paused else { return }
        do {
            try activateSession()
            if !engine.isRunning { try run() } else { player.play() }
            paused = false
        } catch {
            onFailure?(String(localized: "The microphone stopped after an interruption."))
        }
    }

    /// The engine stops itself when the route or the format changes; it's wired and started again.
    private func reconfigured() {
        guard running, !paused, !engine.isRunning else { return }
        do {
            try run()
        } catch {
            onFailure?(String(localized: "The microphone stopped after the audio route changed."))
        }
    }
}

/// A copy of one microphone buffer, handed off the audio thread.
struct MicBuffer: Sendable {
    var samples: [Float]
    var rate: Int
}

struct MicUnavailable: LocalizedError {
    var errorDescription: String? { String(localized: "No microphone is available right now.") }
}
