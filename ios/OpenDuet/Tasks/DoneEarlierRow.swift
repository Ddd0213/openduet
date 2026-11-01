// M22 (plan 修改意见 5): the last row of an open Done, while tasks were resolved more than 7 days
// ago (TaskList.olderResolved): "Earlier" loads the first page of them (GET /api/tasks?resolved=
// older, newest first; they show above this row), then "Show more" the next while there is one.
// The hand-drawn spinner while a page loads; a failed page is the grey reason with Retry.
import SwiftUI

struct DoneEarlierRow: View {
    var older: OlderTasksState
    var onLoad: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = Metrics.taskStatusLine

    var body: some View {
        Group {
            if case .failed(let reason) = older.phase {
                InlineFailure(reason: reason, onRetry: onLoad)
                    .padding(.vertical, 10)
            } else if older.hasMore {
                Button(action: onLoad) {
                    HStack(spacing: 8) {
                        if older.loaded { Text("Show more") } else { Text("Earlier") }
                        if older.phase == .loading {
                            SpinnerArc(size: fontSize - 2, color: Palette.secondaryText, lineWidth: 1.6)
                                .transition(.opacity)
                        } else {
                            Image(systemName: "chevron.down")
                                .font(.system(size: fontSize - 4, weight: .semibold))
                                .accessibilityHidden(true)
                        }
                    }
                    .font(.system(size: fontSize))
                    .foregroundStyle(Palette.secondaryText)
                    .padding(.leading, Metrics.taskCheckbox + 12)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle(scale: 0.98))
                .disabled(older.phase == .loading)
                .accessibilityHint(Text("Shows tasks done more than a week ago"))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: older.phase)
    }
}
