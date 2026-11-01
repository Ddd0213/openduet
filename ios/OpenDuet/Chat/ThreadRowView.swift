// One row of the main thread: the assistant's rows sit left in an 80%-wide slot, the user's right,
// system rows centred full width (prompt L82). M9 (L114 as the user asked): each bubble row has
// its own horizontal swipe (BubbleSwipe): left shows that bubble's time, right on an assistant text
// bubble quotes it; nothing else in the thread moves. Cards (full width) keep their own gestures.
import SwiftUI

struct ThreadRowView: View {
    var row: ThreadRow
    var streaming: Bool
    var actions: ShellActions
    var onSent: () -> Void

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: alignment)
    }

    private var alignment: Alignment {
        switch row.sender {
        case .user: .trailing
        case .assistant: .leading
        case .center, nil: .center
        }
    }

    @ViewBuilder
    private var content: some View {
        switch row.kind {
        case .loadingOlder:
            OlderSkeleton()
        case .dateSeparator(let date):
            DateSeparator(date: date)
        case .newDivider:
            NewDivider()
        case .message(let message, let layout) where ThreadLayout.isWide(message):
            // M3 cards use the thread's full width; their lead bubble keeps the 80% slot.
            MessageView(message: message, layout: layout, streaming: streaming, actions: actions, onSent: onSent)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .message(let message, let layout):
            slot {
                QuotingMessage(message: message) {
                    MessageView(message: message, layout: layout, streaming: streaming, actions: actions, onSent: onSent)
                }
            }
            .frame(maxWidth: .infinity, alignment: alignment)
            .bubbleSwipe(time: row.time, onQuote: quote(message))
        case .pending(let pending, let layout):
            slot {
                VStack(alignment: .trailing, spacing: 4) {
                    if let quote = pending.replyTo { QuotedBlock(excerpt: quote.excerpt) }
                    PendingBubble(pending: pending, tail: layout.tail) { actions.retryPending(pending.clientId) }
                }
            }
            .frame(maxWidth: .infinity, alignment: alignment)
            .bubbleSwipe(time: row.time)
        case .activity(let status):
            slot {
                ZStack(alignment: .leading) {
                    if let status {
                        StatusBubble(status: status).transition(.opacity)
                    } else {
                        TypingIndicator().transition(.opacity)
                    }
                }
                .animation(.easeInOut(duration: 0.3), value: status)
            }
        }
    }

    /// Swipe right on an assistant text bubble: its quote goes to this thread's composer (cut when
    /// the swipe lands, M10, not on every render while the reply streams).
    private func quote(_ message: Message) -> (() -> Void)? {
        guard BubbleQuote.quotable(message) else { return nil }
        let setReplyTo = actions.setReplyTo
        return { setReplyTo(BubbleQuote.make(message)) }
    }

    /// Bubbles hug their content inside an 80%-wide slot of the thread; centred rows use the full width.
    @ViewBuilder
    private func slot<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        if row.sender == .center {
            content()
        } else {
            content()
                .containerRelativeFrame(.horizontal, alignment: alignment) { width, _ in
                    width * Metrics.bubbleMaxWidthFraction
                }
        }
    }
}

/// M19: a thread row that re-renders only when what it shows changed: the row (its message and
/// layout, gap, time) and whether it streams. The thread re-ran every realized row's body on
/// every store write, because `actions` and `onSent` are new closures each time the shell
/// renders; they only reach the store (weakly) or bump a counter, so an older copy does the same.
struct EquatableThreadRow: View, Equatable {
    var row: ThreadRow
    var streaming: Bool
    var actions: ShellActions
    var onSent: () -> Void

    var body: some View {
        ThreadRowView(row: row, streaming: streaming, actions: actions, onSent: onSent)
    }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.streaming == rhs.streaming && lhs.row == rhs.row
    }
}

/// Quote reply (M8 contract §2): a user message that quoted an assistant bubble shows the excerpt
/// above its bubble (the swipe itself is BubbleSwipe on the row).
private struct QuotingMessage<Content: View>: View {
    var message: Message
    @ViewBuilder var content: Content

    var body: some View {
        if message.role == .user, case .text(let payload) = message.content, let quoted = payload.replyTo {
            VStack(alignment: .trailing, spacing: 4) {
                QuotedBlock(excerpt: quoted.excerpt)
                content
            }
        } else {
            content
        }
    }
}
