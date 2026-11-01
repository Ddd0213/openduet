// M27 the dictation lines above a composer (never an alert): why dictation stopped or can't start
// (with Retry for the same recording, Voice for the settings' Voice page, Settings for the app's
// iOS page), "Recording · 0:07" while a cloud clip records (no live text then) and
// "Transcribing…" while it's sent. Same look as the call's note line (CallNoteLine).
import SwiftUI

struct DictationNoteLine: View {
    var note: DictationNote
    /// nil: no Retry here
    var onRetry: (() -> Void)?
    /// nil: no Voice here (Make's composer)
    var onVoice: (() -> Void)?
    var alignment: Alignment = .trailing

    @Environment(\.openURL) private var openURL
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            DuetIcon(glyph: icon, size: fontSize + 2, tint: Palette.secondaryText)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                .accessibilityHidden(true)
            Text(verbatim: note.message)
                .foregroundStyle(Palette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            if note.offersRetry, let onRetry {
                action(Text("Retry"), onRetry)
            }
            if note.offersVoice, let onVoice {
                action(Text("Voice"), onVoice)
            }
            if note.offersSettings {
                action(Text("Settings")) {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                }
            }
        }
        .font(.system(size: fontSize))
        .multilineTextAlignment(alignment == .leading ? .leading : .trailing)
        .frame(maxWidth: .infinity, alignment: alignment)
        .padding(.horizontal, 12)
        .accessibilityElement(children: .contain)
    }

    private var icon: DuetGlyph {
        switch note {
        case .failed, .unreachable, .tooLong, .badRecording, .language: .warning
        case .notSetUp, .notOnDevice: .notSetUp
        default: .info
        }
    }

    private func action(_ title: Text, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            title
                .fontWeight(.semibold)
                .foregroundStyle(Palette.accent)
                .frame(minHeight: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// "Recording · 0:07" (a cloud clip: no live text) or "Transcribing…" with a small spinner.
struct DictationStatusLine: View {
    var dictation: Dictation
    var alignment: Alignment = .trailing

    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13

    var body: some View {
        HStack(spacing: 6) {
            if dictation.isTranscribing {
                ProgressView().controlSize(.mini).tint(Palette.secondaryText)
                Text("Transcribing…")
            } else if let since = dictation.recordingSince {
                DuetIcon(glyph: .dictate, size: fontSize + 2, tint: Palette.secondaryText)
                    .accessibilityHidden(true)
                TimelineView(.periodic(from: since, by: 1)) { context in
                    let seconds = Int(max(context.date.timeIntervalSince(since), 0))
                    Text("Recording · \(CallCopy.timer(seconds))")
                        .monospacedDigit()
                }
            }
        }
        .font(.system(size: fontSize))
        .foregroundStyle(Palette.secondaryText)
        .frame(maxWidth: .infinity, alignment: alignment)
        .padding(.horizontal, 12)
        .accessibilityElement(children: .combine)
    }

    /// A line shows (a cloud clip records, or one is being transcribed).
    static func shows(_ dictation: Dictation) -> Bool {
        dictation.isTranscribing || dictation.recordingSince != nil
    }
}
