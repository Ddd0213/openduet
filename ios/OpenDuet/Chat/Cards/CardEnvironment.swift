// What M3's cards read besides their own message: the in-flight / failed taps
// (ShellState.cardRequests), live task statuses for chips, the fields glowing after an edit by
// chat (set per thread by ThreadView), and two hooks into the shell (focus the composer for
// "Edit" / ✎, switch to the Tasks tab for "See all tasks").
import SwiftUI

struct CardContext: Hashable, Sendable {
    /// ShellState.cardRequests: message ids for cards, task ids for rows, suggestion ids for Up next.
    var requests: ShellState.CardRequests = [:]
    /// The latest known status of each task (the chip under a delegation follows it live).
    var taskStatuses: [String: TaskStatus] = [:]

    /// Builds the lookup from the Tasks tab's list and the open task detail.
    init(state: ShellState) {
        requests = state.cardRequests
        var statuses: [String: TaskStatus] = [:]
        for task in state.tasks.tasks { statuses[task.id] = task.status }
        if let task = state.taskDetail?.task { statuses[task.id] = task.summary.status }
        taskStatuses = statuses
    }

    init() {}
}

struct CardHooks: Sendable {
    /// "Edit" on a failed approval and the ✎ on an email card: focus the thread's composer.
    var focusComposer: @MainActor @Sendable () -> Void = {}
    /// "See all tasks ›" under a started suggestion.
    var showAllTasks: @MainActor @Sendable () -> Void = {}
}

extension EnvironmentValues {
    @Entry var cardContext = CardContext()
    @Entry var cardHooks = CardHooks()
    /// Message id -> preview fields glowing right now (L163); set by the thread showing the card.
    @Entry var glowingFields: [String: Set<String>] = [:]
}

/// An assistant-style lead bubble above a card ("A task I could help with:"), 80% of the thread wide.
struct LeadBubble: View {
    var text: String
    var streaming = false

    var body: some View {
        if !text.isEmpty {
            AssistantBubble(text: text, streaming: streaming)
                .bubbleAccessibility(label: Text(verbatim: "OpenDuet"), value: Text(verbatim: MarkdownCache.plainText(text, streaming: streaming)))
                // The same 80% slot ThreadRowView gives a plain bubble.
                .containerRelativeFrame(.horizontal, alignment: .leading) { width, _ in
                    width * Metrics.bubbleMaxWidthFraction
                }
        }
    }
}

/// The grey reason line with Retry (and optionally Edit) under a failed tap (L182, L184).
struct InlineFailure: View {
    var reason: String
    var onRetry: () -> Void
    var onEdit: (() -> Void)?

    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 14

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                DuetIcon(glyph: .warning, size: fontSize + 2, tint: Palette.failure)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                Text(verbatim: reason)
                    .font(.system(size: fontSize))
                    .foregroundStyle(Palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                CapsuleButton(title: Text("Retry"), style: .outline, fullWidth: false, action: onRetry)
                if let onEdit {
                    CapsuleButton(title: Text("Edit"), style: .outline, fullWidth: false, action: onEdit)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .transition(.opacity)
    }
}
