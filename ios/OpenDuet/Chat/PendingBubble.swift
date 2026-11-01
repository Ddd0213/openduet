// A message the store hasn't seen echoed yet (prompt L184): typed offline it waits with a clock
// badge and sends on reconnect; a failed send shows "Not delivered" with an inline Retry.
import SwiftUI

struct PendingBubble: View {
    var pending: PendingMessage
    var tail: Bool
    var onRetry: () -> Void

    /// A quick send shouldn't flash the clock: it shows after a moment while still sending.
    @State private var showClock = false

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            ForEach(pending.attachments) { file in
                Group {
                    if file.isImage { ImageBubble(file: file) } else { FileCard(file: file) {} }
                }
                .padding(.trailing, UserBubbleShape.tailWidth)
            }
            if !pending.text.isEmpty {
                HStack(alignment: .bottom, spacing: 6) {
                    badge
                    UserBubble(text: pending.text, tail: tail)
                        .opacity(pending.state == .failed ? 0.7 : 1)
                }
            }
            if pending.state == .failed {
                Button(action: onRetry) {
                    HStack(spacing: 4) {
                        Text("Not delivered")
                        Text(verbatim: "·")
                        Text("Retry").fontWeight(.semibold)
                    }
                    .font(Typography.caption)
                    .foregroundStyle(Palette.failure)
                    .padding(.vertical, 4)
                    .padding(.trailing, UserBubbleShape.tailWidth + 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityLabel(Text("Not delivered. Retry"))
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: pending.state)
        .animation(.easeInOut(duration: 0.25), value: showClock)
        // A send of the user's that failed (L186).
        .sensoryFeedback(.warning, trigger: pending.state) { _, new in new == .failed }
        .accessibilityElement(children: .contain)
        .task(id: pending.state) {
            switch pending.state {
            case .waiting: showClock = true
            case .failed: showClock = false
            case .sending:
                try? await Task.sleep(for: .seconds(1.2))
                if !Task.isCancelled { showClock = true }
            }
        }
    }

    @ViewBuilder
    private var badge: some View {
        if pending.state == .failed {
            DuetIcon(glyph: .failed, size: 21, tint: Palette.failure)
                .accessibilityElement(children: .ignore)
                .accessibilityAddTraits(.isImage)
                .accessibilityLabel(Text("Not delivered"))
                .padding(.bottom, 8)
                .transition(.opacity)
        } else if showClock {
            DuetIcon(glyph: .clock, size: 16, tint: Palette.secondaryText)
                .accessibilityElement(children: .ignore)
                .accessibilityAddTraits(.isImage)
                .accessibilityLabel(Text("Waiting to send"))
                .padding(.bottom, 10)
                .transition(.opacity)
        }
    }
}
