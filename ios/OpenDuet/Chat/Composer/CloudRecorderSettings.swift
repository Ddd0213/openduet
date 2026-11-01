// M27 the cloud recorder's AVAudioRecorder settings, apart from the recorder (iOS-only audio
// session) so the host tests check them: WAV linear PCM, 16 kHz, mono, 16-bit little-endian
// (TranscriptionLimits), which the server sends on unchanged.
import AVFoundation

enum CloudRecorderSettings {
    static var settings: [String: Any] {
        [
            AVFormatIDKey: Int(kAudioFormatLinearPCM),
            AVSampleRateKey: TranscriptionLimits.sampleRate,
            AVNumberOfChannelsKey: TranscriptionLimits.channels,
            AVLinearPCMBitDepthKey: TranscriptionLimits.bitDepth,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
    }
}
