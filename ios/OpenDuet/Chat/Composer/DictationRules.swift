// M27 the composer microphone's rules, without SwiftUI or AVFoundation for the host tests: which
// recognizer the mic uses (Apple's, optionally on the iPhone only; the cloud one when it's ready;
// never Apple's in place of a cloud one that isn't), the inline notes (with Retry / Voice /
// Settings), the language sent with a clip, a clip too short to send, and where the text goes
// (where the cursor was). The recorder's settings: CloudDictation.swift.
import Foundation

/// What a tap on the mic does.
enum DictationMode: Hashable, Sendable {
    /// SFSpeechRecognizer, live partial results; `onDeviceOnly`: requiresOnDeviceRecognition
    case device(onDeviceOnly: Bool)
    /// record a WAV, then POST /api/transcriptions
    case cloud
    /// cloud is chosen but can't be used: nothing is recorded, the note says why
    case cloudNotReady
}

/// The line above the composer when dictation can't go on (never an alert).
enum DictationNote: Hashable, Sendable {
    /// Apple's recognizer: Speech Recognition or the microphone is off for the app (+ Settings)
    case notAllowed
    /// cloud: the microphone is off for the app (+ Settings)
    case micNotAllowed
    case unavailable
    /// "Only on this iPhone" is on and this language can't be recognized on the iPhone (+ Voice)
    case notOnDevice
    /// cloud chosen but not ready, or the server's not_configured (+ Voice)
    case notSetUp
    /// 502 transcription_failed: "Couldn't transcribe. <server message>" (+ Retry)
    case failed(String?)
    /// 413
    case tooLong
    /// the server can't be reached (+ Retry)
    case unreachable
    /// 400 field language
    case language
    /// 400 field file / 415: the recording can't be read
    case badRecording
    /// 200 with "": nothing was heard
    case nothingHeard

    var message: String {
        switch self {
        case .notAllowed: String(localized: "Allow Speech Recognition and the microphone for OpenDuet in Settings.")
        case .micNotAllowed: String(localized: "Allow the microphone for OpenDuet in Settings.")
        case .unavailable: String(localized: "Dictation isn't available right now.")
        case .notOnDevice: String(localized: "This language can't be recognized on this iPhone.")
        case .notSetUp: String(localized: "Cloud dictation isn't set up.")
        case .failed(let reason?) where !reason.isEmpty: String(localized: "Couldn't transcribe. \(reason)")
        case .failed: String(localized: "Couldn't transcribe.")
        case .tooLong: String(localized: "Too long to transcribe (2 min max)")
        case .unreachable: String(localized: "Can't reach your server.")
        case .language: String(localized: "This provider can't transcribe this language.")
        case .badRecording: String(localized: "The recording couldn't be read.")
        case .nothingHeard: String(localized: "Nothing was heard.")
        }
    }

    /// Retry sends the same recording again.
    var offersRetry: Bool {
        switch self {
        case .failed, .unreachable: true
        default: false
        }
    }

    /// "Voice" opens the settings' Voice page.
    var offersVoice: Bool {
        switch self {
        case .notSetUp, .notOnDevice: true
        default: false
        }
    }

    /// "Settings" opens the app's page in iOS Settings.
    var offersSettings: Bool {
        self == .notAllowed || self == .micNotAllowed
    }

    /// How long the line stays (nil: until Send, clear, Retry or the next tap).
    var lasts: Double? {
        if offersRetry { return nil }
        if offersVoice || offersSettings { return 8 }
        return 4
    }

    /// The note for a failed POST /api/transcriptions (nil: cancelled).
    static func from(_ error: any Error) -> DictationNote? {
        if error is CancellationError { return nil }
        if let failure = error as? TranscriptionFailure { return .failed(failure.message) }
        switch error as? APIError {
        case .notConfigured?: return .notSetUp
        case .tooLarge?: return .tooLong
        case .validationFailed(let field, _)? where field == "language": return .language
        case .validationFailed?, .unsupportedType?: return .badRecording
        case .unreachable?: return .unreachable
        // 502 transcription_failed without a readable message, a 429, anything else
        default: return .failed(nil)
        }
    }
}

/// 502 transcription_failed with the server's plain words (APIError keeps only the code).
struct TranscriptionFailure: Error, Hashable, Sendable {
    var message: String
}

enum DictationRules {
    /// What the mic does with these settings. Cloud never falls back to Apple's recognizer.
    static func mode(_ settings: DictationSettings) -> DictationMode {
        switch settings.engine {
        case .device: .device(onDeviceOnly: settings.onDeviceOnly)
        case .cloud: settings.cloudReady ? .cloud : .cloudNotReady
        }
    }

    /// The clip is long enough to send (under 0.5 s nothing is sent).
    static func shouldSend(seconds: Double) -> Bool {
        seconds >= TranscriptionLimits.minSendSeconds
    }

    /// Recording stops by itself just before the server's limit (the WAV header and timing slack).
    static let maxRecordingSeconds = TranscriptionLimits.maxSeconds - 0.5

    /// The `language` sent with a clip, as the iPhone recognizer picks its locale: Chinese
    /// dictates in zh-CN, otherwise the device's English variant (en-US when it isn't English).
    static func language(preferred: String?, current: Locale) -> String {
        if preferred?.hasPrefix("zh") == true { return "zh-CN" }
        if current.language.languageCode?.identifier == "en", let region = current.region?.identifier {
            return "en-" + region
        }
        return "en-US"
    }
}

/// Where dictated text goes and where the cursor ends up.
struct DictationInsertion: Hashable, Sendable {
    var text: String
    /// the cursor after the inserted text (UTF-16 offset)
    var caret: Int

    /// `heard` at `offset` (UTF-16; past the end or nil: the end) with a space against a word on
    /// either side (none for CJK, punctuation or existing space).
    static func insert(_ heard: String, into draft: String, at offset: Int?) -> DictationInsertion {
        let words = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        let utf16 = draft.utf16
        var position = min(max(offset ?? utf16.count, 0), utf16.count)
        // Not inside a character (a surrogate pair, an emoji): move to its end.
        while position < utf16.count,
              String.Index(utf16.index(utf16.startIndex, offsetBy: position), within: draft) == nil {
            position += 1
        }
        let index = String.Index(utf16.index(utf16.startIndex, offsetBy: position), within: draft) ?? draft.endIndex
        guard !words.isEmpty else { return DictationInsertion(text: draft, caret: position) }
        let before = index > draft.startIndex ? draft[draft.index(before: index)] : nil
        let after = index < draft.endIndex ? draft[index] : nil
        let lead = needsSpace(before, words.first) ? " " : ""
        let trail = needsSpace(words.last, after) ? " " : ""
        let piece = lead + words + trail
        let text = String(draft[..<index]) + piece + String(draft[index...])
        return DictationInsertion(text: text, caret: position + (lead + words).utf16.count)
    }

    /// A space between two characters that would otherwise run two words together.
    private static func needsSpace(_ left: Character?, _ right: Character?) -> Bool {
        guard let left, let right else { return false }
        if left.isWhitespace || right.isWhitespace { return false }
        if isWide(left) || isWide(right) { return false }
        if right.isPunctuation, !"([{\"'“‘".contains(right) { return false }
        if "([{“‘".contains(left) { return false }
        return true
    }

    /// CJK and fullwidth characters take no spaces around them.
    private static func isWide(_ character: Character) -> Bool {
        character.unicodeScalars.contains { scalar in
            switch scalar.value {
            case 0x2E80...0x9FFF, 0xAC00...0xD7AF, 0xF900...0xFAFF, 0xFE30...0xFE4F, 0xFF00...0xFFEF, 0x20000...0x2FA1F: true
            default: false
            }
        }
    }
}
