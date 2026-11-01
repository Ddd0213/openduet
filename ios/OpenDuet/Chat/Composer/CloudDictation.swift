// M27 cloud dictation's recording: AVAudioRecorder to a temp WAV in the format the server takes
// (TranscriptionLimits: 16 kHz, mono, 16-bit linear PCM), stopped by the caller (a second tap,
// Send, or the 120 s limit). The file is the caller's to send and delete; nothing else keeps it.
// Needs NSMicrophoneUsageDescription.
import AVFoundation
import Foundation

/// One recorded clip: its temp file and length.
struct DictationClip: Hashable, Sendable {
    var url: URL
    var seconds: Double

    /// Gone from the disk (after it was transcribed, Send, clear, or leaving the thread).
    func delete() {
        try? FileManager.default.removeItem(at: url)
    }
}

@MainActor
final class CloudRecorder {
    private var recorder: AVAudioRecorder?

    var isRecording: Bool { recorder?.isRecording == true }

    /// Starts a new clip (the microphone must be allowed); throws when the audio can't start.
    func start() throws {
        cancel()
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("dictation-\(UUID().uuidString)")
            .appendingPathExtension("wav")
        let recorder = try AVAudioRecorder(url: url, settings: CloudRecorderSettings.settings)
        guard recorder.record(forDuration: DictationRules.maxRecordingSeconds + 0.4) else {
            try? FileManager.default.removeItem(at: url)
            Self.deactivate()
            throw CloudRecorderError.couldNotStart
        }
        self.recorder = recorder
    }

    /// Stops and hands over the clip (nil when nothing was recording).
    func stop() -> DictationClip? {
        guard let recorder else { return nil }
        let seconds = recorder.currentTime
        recorder.stop()
        self.recorder = nil
        Self.deactivate()
        // currentTime reads 0 once the recorder stopped by itself: the file's own length then.
        let length = seconds > 0 ? seconds : Self.duration(of: recorder.url)
        return DictationClip(url: recorder.url, seconds: length)
    }

    /// Stops and deletes the clip.
    func cancel() {
        stop()?.delete()
    }

    private static func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private static func duration(of url: URL) -> Double {
        guard let file = try? AVAudioFile(forReading: url) else { return 0 }
        let rate = file.processingFormat.sampleRate
        return rate > 0 ? Double(file.length) / rate : 0
    }
}

enum CloudRecorderError: Error {
    case couldNotStart
}

/// The microphone permission (cloud dictation records without Speech Recognition).
enum MicrophoneAccess {
    static func request() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }
}
