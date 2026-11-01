// Quick replies (prompt L105 as changed in the M23 contract; plan §6 W5, 修改意见 5): under
// the assistant's question, one card (the card surface: fill, hairline border, rounded corners) with one
// option per row, hairlines between the rows and a trailing ↗. The whole row is tappable and sends
// its text with a light haptic and the usual press feedback; the text is primary, one size below
// the body (15 pt), and wraps instead of truncating. Once one is chosen (here or on the server) it
// turns bold with a ✓, the others fade and stop responding, and the card stays so the choice shows
// when reading back. M21: an earlier turn's options fade the same way (QuickReplyRules).
// (Was M18 variant B: faint options inside the bubble split by "·", which didn't read as tappable.)
import SwiftUI

/// The assistant's question (when there is text) in its bubble, then the options card under it.
struct QuickReplyBubble: View {
    var text: String
    var streaming: Bool
    var options: [String]
    var chosen: String?
    /// M21: an earlier turn's options (ThreadLayout.liveQuickReplies): shown, not tappable.
    var stale = false
    /// "OpenDuet, 8:47 AM" and the text without markdown, for the text part's VoiceOver element.
    var accessibilityLabel: Text
    var accessibilityText: String
    var onReply: (() -> Void)?
    var onChoose: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.bubbleSpacing) {
            if !text.isEmpty {
                AssistantBubble(text: text, streaming: streaming)
                    .bubbleAccessibility(label: accessibilityLabel, value: Text(verbatim: accessibilityText))
                    // Swipe right quotes it (ThreadRowView); VoiceOver gets the same.
                    .accessibilityAction(named: Text("Reply")) { onReply?() }
            }
            if !options.isEmpty {
                QuickReplies(options: options, chosen: chosen, stale: stale, onChoose: onChoose)
            }
        }
    }
}

struct QuickReplies: View {
    var options: [String]
    var chosen: String?
    /// M21: options of an earlier turn: faded like the unchosen ones after a pick, no taps.
    var stale = false
    var onChoose: (String) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 15
    /// Set on tap so the rows lock before the server echoes `chosen`.
    @State private var tapped: String?

    private var picked: String? { chosen ?? tapped }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                if index > 0 {
                    Rectangle()
                        .fill(Palette.cardBorder)
                        .frame(height: Metrics.hairline)
                        .padding(.leading, 16)
                        .accessibilityHidden(true)
                }
                row(option)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .easeInOut(duration: 0.25), value: picked)
        .animation(.easeInOut(duration: 0.25), value: stale)
        .sensoryFeedback(.impact(weight: .light), trigger: tapped) { _, new in new != nil }
    }

    private func row(_ option: String) -> some View {
        let state = QuickReplyRules.row(option, chosen: picked, stale: stale)
        let lift = fontSize * 0.3
        return Button {
            guard !QuickReplyRules.isLocked(chosen: picked, stale: stale) else { return }
            tapped = option
            onChoose(option)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                // The assistant's words (data, not UI copy).
                Text(verbatim: option)
                    .font(.system(size: fontSize, weight: state == .chosen ? .bold : .regular))
                    .foregroundStyle(Palette.primaryText)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ZStack {
                    if state == .chosen {
                        DuetIcon(glyph: .check, size: fontSize + 2, tint: Palette.primaryText)
                            .transition(.opacity.combined(with: .scale(scale: reduceMotion ? 1 : 0.6)))
                    } else {
                        Text(verbatim: "↗")
                            .font(.system(size: fontSize, weight: .medium))
                            .foregroundStyle(Palette.secondaryText)
                            .transition(.opacity)
                    }
                }
                .frame(minWidth: fontSize + 4)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + lift }
                .accessibilityHidden(true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: 44)
            .opacity(state == .faded ? QuickReplyRules.fadedOpacity : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .disabled(state == .faded)
        .accessibilityLabel(Text(verbatim: option))
        .accessibilityHint(hint(state))
        .accessibilityAddTraits(state == .chosen ? .isSelected : [])
    }

    private func hint(_ state: QuickReplyRules.Row) -> Text {
        switch state {
        case .live: Text("Sends this reply")
        case .chosen: Text("Chosen")
        case .faded: Text(verbatim: "")
        }
    }
}
