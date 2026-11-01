// A finished voice call in the chat: one quiet system row, "Voice call · 3 min" and the call's
// title when it has one. A tap opens the conversation (CallDetailSheet). M15: when the voice
// service reported an error during the call (one that didn't end it), a grey line under it says
// so; it's kept on this phone only (CallProblems).
import SwiftUI

struct CallLineRow: View {
    var payload: CallPayload

    @Environment(\.locale) private var locale
    @State private var showDetail = false
    private let problems = CallProblems.shared
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13

    var body: some View {
        Button { showDetail = true } label: {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                DuetIcon(glyph: .voice, size: fontSize + 3, tint: Palette.secondaryText)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                    .accessibilityHidden(true)
                VStack(spacing: 2) {
                    Text(verbatim: line)
                        .font(.system(size: fontSize))
                        .foregroundStyle(Palette.secondaryText)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                    if let problem = problems.message(for: payload.callId) {
                        Text("The voice service reported an error: \(problem)")
                            .font(.system(size: fontSize - 1))
                            .foregroundStyle(Palette.secondaryText.opacity(0.85))
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.97))
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .accessibilityHint(Text("Opens the conversation"))
        .sheet(isPresented: $showDetail) {
            CallDetailSheet(callId: payload.callId) { showDetail = false }
                .duetSheetChrome()
                .presentationDetents([.large])
        }
    }

    private var line: String {
        let length = CallCopy.line(seconds: payload.seconds, locale: locale)
        let title = payload.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? length : "\(length) · \(title)"
    }
}
