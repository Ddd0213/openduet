// M11 form pieces of the OpenDuet sheets' pages: a labelled field inside a card (format problem in
// red, a footnote, the characters left near the limit), the secret field (SecureField: typed,
// sent once, never kept or shown again) and the save row (Saved / the server's reason + Save).
import SwiftUI
import UIKit

/// A labelled text field for a CardSection.
struct SettingsField: View {
    var label: Text
    @Binding var text: String
    var prompt: Text?
    var limit: Int?
    /// nil = one line; otherwise it grows between these line counts
    var lines: ClosedRange<Int>?
    var monospaced = false
    /// URLs, domains, header names, skill names: no capitals, no autocorrect
    var plain = false
    var keyboard: UIKeyboardType = .default
    var problem: Text?
    var footnote: Text?

    @ScaledMetric(relativeTo: .footnote) private var labelSize: CGFloat = 13
    @ScaledMetric(relativeTo: .body) private var textSize: CGFloat = 16
    @ScaledMetric(relativeTo: .caption) private var noteSize: CGFloat = 12.5

    private var remaining: Int? {
        guard let limit else { return nil }
        let left = limit - text.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count
        return left <= max(20, limit / 10) ? left : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            label
                .font(.system(size: labelSize, weight: .semibold))
                .foregroundStyle(Palette.secondaryText)
                .accessibilityHidden(true)
            field
                .font(monospaced ? .system(size: textSize - 1, design: .monospaced) : .system(size: textSize))
                .foregroundStyle(Palette.primaryText)
                .textInputAutocapitalization(plain ? .never : .sentences)
                .autocorrectionDisabled(plain)
                .keyboardType(keyboard)
            if let problem {
                problem
                    .font(.system(size: noteSize))
                    .foregroundStyle(Palette.failure)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            } else if let footnote {
                footnote
                    .font(.system(size: noteSize))
                    .foregroundStyle(Palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let remaining {
                (remaining >= 0 ? Text("\(remaining) left") : Text("\(-remaining) over the limit"))
                    .font(.system(size: noteSize).monospacedDigit())
                    .foregroundStyle(remaining >= 0 ? Palette.secondaryText : Palette.failure)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .contentTransition(.numericText())
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.easeInOut(duration: 0.2), value: problem == nil)
    }

    @ViewBuilder private var field: some View {
        if let lines {
            TextField(text: $text, prompt: prompt, axis: .vertical) { label }
                .lineLimit(lines)
        } else {
            TextField(text: $text, prompt: prompt) { label }
        }
    }
}

/// A secret (an API key, a secret header value). Never prefilled: what's stored stays in the
/// server's vault and only its last 4 characters are ever shown (as the footnote).
struct SettingsSecretField: View {
    var label: Text
    @Binding var text: String
    var prompt: Text?
    var footnote: Text?

    @ScaledMetric(relativeTo: .footnote) private var labelSize: CGFloat = 13
    @ScaledMetric(relativeTo: .body) private var textSize: CGFloat = 16
    @ScaledMetric(relativeTo: .caption) private var noteSize: CGFloat = 12.5

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            label
                .font(.system(size: labelSize, weight: .semibold))
                .foregroundStyle(Palette.secondaryText)
                .accessibilityHidden(true)
            SecureField(text: $text, prompt: prompt) { label }
                .font(.system(size: textSize, design: .monospaced))
                .foregroundStyle(Palette.primaryText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .privacySensitive()
            if let footnote {
                footnote
                    .font(.system(size: noteSize))
                    .foregroundStyle(Palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Under a form: the server's reason when saving failed, then "Saved" (or a status line) and
/// the Save capsule with its spinner. Saved gives a success haptic, a failure a warning one.
struct SettingsSaveRow: View {
    var title = Text("Save")
    var busy: Bool
    var enabled: Bool
    var saved: Bool
    var failure: String?
    var status: Text?
    var onSave: () -> Void

    @ScaledMetric(relativeTo: .footnote) private var statusSize: CGFloat = 13

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let failure {
                SettingsReasonLine(reason: failure)
                    .transition(.opacity)
            }
            HStack(spacing: 12) {
                statusLine
                    .font(.system(size: statusSize))
                    .foregroundStyle(Palette.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentTransition(.opacity)
                CapsuleButton(title: title, busy: busy, fullWidth: false, action: onSave)
                    .disabled(!enabled || busy)
            }
        }
        .padding(.horizontal, 6)
        .animation(.easeInOut(duration: 0.2), value: failure)
        .animation(.easeInOut(duration: 0.2), value: saved)
        .sensoryFeedback(.success, trigger: saved) { _, new in new }
        .sensoryFeedback(.warning, trigger: failure) { _, new in new != nil }
    }

    private var statusLine: Text {
        if saved { return Text("\(Image(systemName: "checkmark")) Saved") }
        return status ?? Text(verbatim: "")
    }
}
