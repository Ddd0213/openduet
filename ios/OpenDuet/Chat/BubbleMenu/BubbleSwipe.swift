// Per-bubble swipe (M9, prompt L114 as the user asked: "在哪个消息气泡滑动，这个气泡才会动，其他不变"):
// one horizontal gesture per bubble row (BubblePanRecognizer), so only the bubble under the finger
// moves and the rest of the thread stays still.
// - Left, on any bubble (the user's or the assistant's): the bubble follows the finger with a rubber band
//   (at most ~64 pt) and its own time fades in at the trailing edge; on release it springs back.
// - Right, on an assistant text bubble (M8 quote reply): it follows the finger, a ↪ circle fades in at
//   the left, a light haptic marks the threshold, and on release the composer shows "Replying to
//   OpenDuet".
// The pan never starts in the left 32 pt (side menu / task back swipe). Reduce Motion: the bubble
// stays put and the time or the ↪ circle just fades.
import SwiftUI

struct BubbleSwipe: ViewModifier {
    var time: Date?
    /// Right swipe quotes this bubble (the assistant's text bubbles); nil = left only.
    var onQuote: (() -> Void)?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.locale) private var locale
    @State private var drag: CGFloat = 0
    @ScaledMetric(relativeTo: .body) private var circle: CGFloat = 30

    /// A right swipe this far quotes.
    static let quoteThreshold: CGFloat = 56

    private var armed: Bool { drag >= Self.quoteThreshold }
    private var quoteProgress: CGFloat { min(max(drag, 0) / Self.quoteThreshold, 1) }
    private var timeProgress: CGFloat { min(max(-drag, 0) / Metrics.timeReveal, 1) }

    func body(content: Content) -> some View {
        content
            .offset(x: reduceMotion ? 0 : drag)
            .overlay(alignment: .leading) { quoteCircle }
            .overlay(alignment: .trailing) { timeLabel }
            .gesture(BubblePanGesture(allowsRight: onQuote != nil, onChange: changed, onEnd: ended))
            .sensoryFeedback(.impact(weight: .light), trigger: armed) { _, now in now }
    }

    // MARK: - Pieces

    @ViewBuilder
    private var quoteCircle: some View {
        if onQuote != nil {
            DuetIcon(glyph: .quote, size: circle * 0.56, tint: armed ? Palette.filledButtonText : Palette.secondaryText)
                .frame(width: circle, height: circle)
                .background(Circle().fill(armed ? Palette.filledButton : Palette.tile))
                .scaleEffect(reduceMotion ? 1 : 0.6 + 0.4 * quoteProgress)
                .opacity(quoteProgress)
                .offset(x: -circle - 6 + min(reduceMotion ? Self.quoteThreshold : max(drag, 0), Self.quoteThreshold) * 0.6)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
                .animation(.spring(response: 0.25, dampingFraction: 0.7), value: armed)
        }
    }

    @ViewBuilder
    private var timeLabel: some View {
        if let time {
            Text(verbatim: ChatTimeFormat.time(time, locale: locale))
                .font(Typography.caption.monospacedDigit())
                // The swipe reveals a fixed 64 pt slot: the time grows a little with larger text
                // but stops before it would run under the bubble.
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .foregroundStyle(Palette.secondaryText)
                .lineLimit(1)
                .fixedSize()
                .opacity(timeProgress)
                // At full swipe the time ends 4 pt inside the screen edge (the thread's inset); it
                // slides in a little as it fades.
                .offset(x: Metrics.threadInset - 4 + (reduceMotion ? 0 : 20 * (1 - timeProgress)))
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    // MARK: - Gesture

    private func changed(_ dx: CGFloat) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            drag = dx < 0 ? -Self.rubberBand(-dx, limit: Metrics.timeReveal) : (onQuote == nil ? 0 : Self.rubberBand(dx, limit: Self.quoteThreshold))
        }
    }

    private func ended(_ dx: CGFloat) {
        if dx >= Self.quoteThreshold, let onQuote { onQuote() }
        guard drag != 0 else { return }
        withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.32, dampingFraction: 0.78)) {
            drag = 0
        }
    }

    /// Follows the finger 1:1 up to `limit`, then ever more stiffly (never far past it).
    static func rubberBand(_ distance: CGFloat, limit: CGFloat) -> CGFloat {
        guard distance > 0 else { return 0 }
        guard distance > limit else { return distance }
        let extra = distance - limit
        return limit + extra / (1 + extra / 40)
    }
}

extension View {
    /// The bubble row's horizontal swipe: left shows its time, right (with `onQuote`) quotes it.
    func bubbleSwipe(time: Date?, onQuote: (() -> Void)? = nil) -> some View {
        modifier(BubbleSwipe(time: time, onQuote: onQuote))
    }
}

/// The quote an assistant bubble hands to the composer (swipe right, or Reply in its menu).
enum BubbleQuote {
    @MainActor
    static func make(_ message: Message) -> ReplyQuote {
        let plain = MarkdownCache.plainText(message.text)
        return ReplyQuote(messageId: message.id, excerpt: ReplyExcerpt.make(plain))
    }

    /// The assistant's text and quick-reply bubbles with words in them (cards and files don't quote).
    static func quotable(_ message: Message) -> Bool {
        guard message.role == .assistant, !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        switch message.content {
        case .text, .quickReplies: return true
        default: return false
        }
    }
}
