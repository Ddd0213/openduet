// The task row in the chat (prompt L102 as changed in M22, plan 修改意见 5): one row per task a
// turn started, stacked under the last paragraph of the assistant's turn (ThreadLayout.ordered): a
// status mark (the spinner while working, a dot while it waits on you, ✓ when done) and the
// truncated title. No capsule and no connector. It follows the task's live status; tapping opens
// the task.
import SwiftUI

struct TaskSpawnChip: View {
    var task: TaskSummary
    var onOpen: () -> Void

    @Environment(\.cardContext) private var context
    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 15

    private var status: TaskStatus { context.taskStatuses[task.id] ?? task.status }

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 8) {
                mark
                    .frame(width: fontSize + 2, height: fontSize + 2)
                    .animation(.easeInOut(duration: 0.3), value: status)
                Text(verbatim: task.title)
                    .font(.system(size: fontSize, weight: .medium))
                    .foregroundStyle(status == .resolved ? Palette.secondaryText : Palette.primaryText)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Task: \(task.title)"))
        .accessibilityValue(Text(status.word))
        .accessibilityHint(Text("Opens the task"))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onOpen() }
    }

    /// Spinner (working), a dot in the status colour (waiting on you: needs input / ready for
    /// review), ✓ (resolved), the clock (scheduled).
    @ViewBuilder
    private var mark: some View {
        switch status {
        case .working:
            SpinnerArc(size: fontSize - 2, lineWidth: max(1.6, fontSize / 9))
        case .needsInput, .readyForReview:
            Circle()
                .fill(status.color)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
        case .resolved:
            DuetArtGlyph(art: .check, symbol: "checkmark", size: fontSize, tint: Palette.secondaryText)
                .accessibilityHidden(true)
        case .scheduled:
            TaskStatusGlyph(status: status, size: fontSize - 1)
        }
    }
}
