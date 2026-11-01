// M27 the Voice page's "Try it": records 3 seconds with the cloud recorder, sends the clip to
// POST /api/transcriptions with the saved recognizer and shows the text (or why it failed). The
// clip is deleted right after; nothing goes into a chat.
import Foundation
import Observation

@MainActor @Observable
final class VoiceDictationTrial {
    enum Phase: Hashable {
        case idle, recording, transcribing
        case heard(String)
        case nothingHeard
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    @ObservationIgnored private let recorder = CloudRecorder()
    @ObservationIgnored private var task: Task<Void, Never>?

    static let seconds: Double = 3

    var busy: Bool { phase == .recording || phase == .transcribing }

    func run(_ voice: VoiceSettingsModel) {
        guard !busy else { return }
        task = Task { [weak self] in await self?.trial(voice) }
    }

    private func trial(_ voice: VoiceSettingsModel) async {
        guard await MicrophoneAccess.request() else {
            phase = .failed(DictationNote.micNotAllowed.message)
            return
        }
        do {
            try recorder.start()
        } catch {
            phase = .failed(DictationNote.unavailable.message)
            return
        }
        phase = .recording
        try? await Task.sleep(for: .seconds(Self.seconds))
        guard !Task.isCancelled, let clip = recorder.stop() else {
            recorder.cancel()
            return
        }
        defer { clip.delete() }
        phase = .transcribing
        do {
            let wav = try Data(contentsOf: clip.url)
            let language = DictationRules.language(preferred: Bundle.main.preferredLocalizations.first, current: .current)
            let text = try await voice.tryTranscription(wav, language: language)
            guard !Task.isCancelled else { return }
            let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
            phase = words.isEmpty ? .nothingHeard : .heard(words)
        } catch {
            guard !Task.isCancelled, let note = DictationNote.from(error) else { return }
            phase = .failed(note.message)
        }
    }

    /// Leaving the page: the recording stops, nothing is sent.
    func cancel() {
        task?.cancel()
        task = nil
        recorder.cancel()
        if busy { phase = .idle }
    }
}
