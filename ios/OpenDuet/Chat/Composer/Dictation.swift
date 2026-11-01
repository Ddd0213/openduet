// Dictation into the composer (prompt L92, L95). M27: the recognizer the settings' Voice page
// chose (VoiceSettings.dictation through DictationSettingsStore):
// - iPhone (default): SFSpeechRecognizer in the app's language (zh-CN for Chinese), live partial
//   results, stopped by a second tap or by sending; "Only on this iPhone" sets
//   requiresOnDeviceRecognition, and a language the iPhone can't do there says so (no server).
// - Cloud (ready): records a 16 kHz mono WAV (CloudRecorder), stopped by a second tap, by Send or
//   at 120 s; under 0.5 s nothing is sent; then POST /api/transcriptions and the text goes where
//   the cursor was (`insertion`). A failure keeps the clip for Retry; it's deleted after success,
//   Send, clear, or leaving the thread.
// - Cloud (not ready): nothing is recorded; the note says so (+ Voice). Never Apple's instead.
// Needs NSSpeechRecognitionUsageDescription and NSMicrophoneUsageDescription.
import AVFoundation
import Observation
import Speech

@MainActor
@Observable
final class Dictation {
    enum Phase: Hashable {
        case idle, recording, transcribing
    }

    /// Text from the cloud recognizer, for the composer to put where the cursor was (once per id).
    struct Insertion: Hashable {
        var id = UUID()
        var text: String
    }

    private(set) var phase: Phase = .idle
    /// Apple's recognizer: what has been heard so far in this session.
    private(set) var transcript = ""
    /// Why dictation stopped or can't start (inline above the composer).
    var note: DictationNote?
    /// When the cloud recording started (the line's timer).
    private(set) var recordingSince: Date?
    private(set) var insertion: Insertion?
    /// Set by the composer (`\.apiClient`): the settings' server and POST /api/transcriptions.
    @ObservationIgnored var api: APIClient?

    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private let recorder = CloudRecorder()
    /// A clip whose transcription failed: Retry sends it again.
    @ObservationIgnored private var kept: DictationClip?
    @ObservationIgnored private var limitTask: Task<Void, Never>?
    @ObservationIgnored private var uploadTask: Task<Void, Never>?
    @ObservationIgnored private var uploadToken = 0
    @ObservationIgnored private var starting = false

    var isRecording: Bool { phase == .recording }
    var isTranscribing: Bool { phase == .transcribing }

    // MARK: - Taps

    /// The mic: start, or stop (cloud: then transcribe). Nothing while a clip is transcribing.
    func toggle() async {
        switch phase {
        case .recording: finish()
        case .idle: await start()
        case .transcribing: break
        }
    }

    func start() async {
        guard phase == .idle, !starting else { return }
        starting = true
        defer { starting = false }
        note = nil
        dropKept()
        let settings = await DictationSettingsStore.shared.current(for: api)
        guard phase == .idle else { return }
        switch DictationRules.mode(settings) {
        case .device(let onDeviceOnly): await startDevice(onDeviceOnly: onDeviceOnly)
        case .cloud: await startCloud()
        case .cloudNotReady: note = .notSetUp
        }
    }

    /// A second tap, or the 120 s limit: Apple's stops (its text is in already); cloud sends the clip.
    func finish() {
        guard phase == .recording else { return }
        if engine != nil {
            stopDevice()
            return
        }
        limitTask?.cancel()
        limitTask = nil
        recordingSince = nil
        guard let clip = recorder.stop() else {
            phase = .idle
            return
        }
        guard DictationRules.shouldSend(seconds: clip.seconds) else {
            clip.delete()
            phase = .idle
            return
        }
        upload(clip)
    }

    /// Send: recording stops (a cloud clip still goes, its text lands after); a failed clip kept
    /// for Retry is dropped with its note.
    func send() {
        finish()
        dropKept()
    }

    /// A call takes the microphone: recording stops and nothing is sent.
    func stop() {
        guard phase == .recording else { return }
        if engine != nil {
            stopDevice()
        } else {
            limitTask?.cancel()
            limitTask = nil
            recordingSince = nil
            recorder.cancel()
            phase = .idle
        }
    }

    /// The draft was cleared: a failed clip kept for Retry goes with its note.
    func clearKept() {
        dropKept()
    }

    /// Leaving the thread: everything stops, a clip in flight or kept is dropped.
    func leave() {
        stop()
        uploadToken += 1
        uploadTask?.cancel()
        uploadTask = nil
        if phase == .transcribing { phase = .idle }
        dropKept()
    }

    /// Retry: the same recording again.
    func retry() {
        guard phase == .idle, let clip = kept else { return }
        kept = nil
        note = nil
        upload(clip)
    }

    private func dropKept() {
        kept?.delete()
        kept = nil
        if note?.offersRetry == true { note = nil }
    }

    // MARK: - Apple's recognizer

    private func startDevice(onDeviceOnly: Bool) async {
        guard await Self.speechAuthorized(), await AVAudioApplication.requestRecordPermission() else {
            note = .notAllowed
            return
        }
        guard phase == .idle, let recognizer = SFSpeechRecognizer(locale: Self.deviceLocale) else {
            note = .unavailable
            return
        }
        if onDeviceOnly, !recognizer.supportsOnDeviceRecognition {
            note = .notOnDevice
            return
        }
        guard recognizer.isAvailable else {
            note = .unavailable
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.requiresOnDeviceRecognition = onDeviceOnly
        let engine = AVAudioEngine()
        do {
            try Self.activateSession()
            Self.installTap(on: engine, feeding: request)
            engine.prepare()
            try engine.start()
        } catch {
            engine.inputNode.removeTap(onBus: 0)
            note = .unavailable
            return
        }
        self.engine = engine
        self.request = request
        transcript = ""
        phase = .recording
        task = Self.recognize(request, with: recognizer, owner: self)
    }

    private func stopDevice() {
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.finish()
        engine = nil
        request = nil
        task = nil
        phase = .idle
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    fileprivate func received(_ text: String?, final: Bool, failed: Bool) {
        guard phase == .recording, engine != nil else { return }
        if let text { transcript = text }
        if final || failed { stopDevice() }
    }

    // MARK: - The cloud recognizer

    private func startCloud() async {
        guard await MicrophoneAccess.request() else {
            note = .micNotAllowed
            return
        }
        guard phase == .idle else { return }
        do {
            try recorder.start()
        } catch {
            note = .unavailable
            return
        }
        phase = .recording
        recordingSince = Date()
        limitTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(DictationRules.maxRecordingSeconds))
            guard !Task.isCancelled else { return }
            self?.finish()
        }
    }

    private func upload(_ clip: DictationClip) {
        uploadToken += 1
        let token = uploadToken
        phase = .transcribing
        let api = api
        let language = Self.cloudLanguage
        uploadTask = Task { [weak self] in
            do {
                guard let api else { throw APIError.unreachable }
                let wav = try await Self.read(clip.url)
                let text = try await api.transcribe(wav: wav, language: language)
                self?.transcribed(text, clip: clip, token: token)
            } catch {
                self?.failed(error, clip: clip, token: token)
            }
        }
    }

    private func transcribed(_ text: String, clip: DictationClip, token: Int) {
        clip.delete()
        guard token == uploadToken else { return }
        uploadTask = nil
        phase = .idle
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if words.isEmpty { note = .nothingHeard } else { insertion = Insertion(text: words) }
    }

    private func failed(_ error: any Error, clip: DictationClip, token: Int) {
        guard token == uploadToken else {
            clip.delete()
            return
        }
        uploadTask = nil
        phase = .idle
        guard let reason = DictationNote.from(error) else {
            clip.delete()
            return
        }
        note = reason
        if reason.offersRetry { kept = clip } else { clip.delete() }
    }

    /// The clip's bytes, off the main actor.
    nonisolated private static func read(_ url: URL) async throws -> Data {
        try await Task.detached { try Data(contentsOf: url) }.value
    }

    /// The `language` of a clip: as Apple's recognizer picks its locale.
    private static var cloudLanguage: String {
        DictationRules.language(preferred: Bundle.main.preferredLocalizations.first, current: Locale.current)
    }

    /// The app's language: Chinese dictates in zh-CN, otherwise the device's English variant.
    private static var deviceLocale: Locale {
        if Bundle.main.preferredLocalizations.first?.hasPrefix("zh") == true { return Locale(identifier: "zh-CN") }
        let current = Locale.current
        if current.language.languageCode?.identifier == "en", SFSpeechRecognizer.supportedLocales().contains(current) {
            return current
        }
        return Locale(identifier: "en-US")
    }

    // MARK: - Off the main actor (Speech and AVAudio call back on their own queues)

    nonisolated private static func speechAuthorized() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
    }

    nonisolated private static func activateSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    nonisolated private static func installTap(on engine: AVAudioEngine, feeding request: SFSpeechAudioBufferRecognitionRequest) {
        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
            request.append(buffer)
        }
    }

    nonisolated private static func recognize(
        _ request: SFSpeechAudioBufferRecognitionRequest, with recognizer: SFSpeechRecognizer, owner: Dictation
    ) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { [weak owner] result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor [owner] in owner?.received(text, final: final, failed: failed) }
        }
    }
}
