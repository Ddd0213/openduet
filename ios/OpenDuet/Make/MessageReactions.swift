// Reactions and feedback (prompt L157): reactions sit on small white round badges at the bubble's
// bottom-left (the assistant reacts to the user's messages too, by == assistant). A reaction or rating that
// didn't go through leaves a grey line under the bubble for a few seconds.
// M9: the long-press menu itself is the custom bubble menu (Chat/BubbleMenu/: emoji bar, Reply,
// Copy, Select text, Share, Good / Bad response), applied on the bubble by MessageView; the
// system .contextMenu that lived here is gone.
import SwiftUI

extension View {
    /// The reaction badges and the failure line of one text bubble (its menu is `bubbleMenu`).
    func messageReactions(_ message: Message, actions: ChatExtrasActions, alignment: HorizontalAlignment) -> some View {
        modifier(MessageReactionsModifier(message: message, alignment: alignment))
    }
}

private struct MessageReactionsModifier: ViewModifier {
    var message: Message
    var alignment: HorizontalAlignment

    @Environment(\.chatExtras) private var extras

    func body(content: Content) -> some View {
        VStack(alignment: alignment, spacing: 0) {
            content
                // The badges straddle the bubble's bottom edge at its left (L157); the bubble keeps
                // its own width, the row only grows by the overhang.
                .padding(.bottom, message.reactions.isEmpty ? 0 : Metrics.reactionBadge - 8)
                .overlay(alignment: .bottomLeading) {
                    ReactionBadges(reactions: message.reactions)
                        .padding(.leading, 10)
                }
            if let failure = extras.failures[message.id] {
                Text(verbatim: failure)
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.secondaryText)
                    .padding(.top, 4)
                    .padding(.horizontal, 4)
                    .transition(.opacity)
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.75), value: message.reactions)
        .animation(.easeInOut(duration: 0.25), value: extras.failures[message.id])
    }
}

/// One small white round badge per emoji, overlapping the bubble's bottom-left.
struct ReactionBadges: View {
    var reactions: [Reaction]

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 4) {
            ForEach(ReactionToggle.badges(reactions), id: \.self) { emoji in
                Text(verbatim: emoji)
                    .font(.system(size: 14))
                    .frame(width: Metrics.reactionBadge, height: Metrics.reactionBadge)
                    .background(
                        Circle()
                            .fill(Palette.reactionBadge)
                            .strokeBorder(Palette.hairline, lineWidth: Metrics.hairline)
                            .shadow(color: .black.opacity(0.08), radius: 3, y: 1)
                    )
                    .accessibilityLabel(label(emoji))
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
            }
        }
    }

    private func label(_ emoji: String) -> Text {
        let mine = reactions.contains { $0.emoji == emoji && $0.by == .user }
        let assistant = reactions.contains { $0.emoji == emoji && $0.by == .assistant }
        switch (mine, assistant) {
        case (true, true): return Text("\(emoji) from you and OpenDuet")
        case (false, true): return Text("\(emoji) from OpenDuet")
        default: return Text("\(emoji) from you")
        }
    }
}
