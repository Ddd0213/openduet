// M22 (plan 「任务列表分类」 candidates 1 and 2): "Coming up" at the bottom of Up next: the routines
// waiting for their next run (TaskGrouping.comingUp; a run that is going or stopped for you shows
// in Active meanwhile; a "once" routine that ran is in Done) and, when the server runs them, the
// Morning brief and Check-in rows. A tap opens the existing routine / schedule sheet (times, Pause /
// Resume, Run now, history); the routine's long-press and ⋯ menu stay as they were.
import SwiftUI

struct ComingUpSection: View {
    var routines: [TaskSummary]
    /// Morning brief and Check-in (nil: not shown, or GET /api/schedule hasn't answered)
    var schedule: ScheduleInfo?
    /// GET /api/schedule failed: its grey line with Retry
    var scheduleFailure: String?
    var requests: ShellState.CardRequests
    var actions: TaskActions
    var now: Date
    var onOpenRoutine: (_ taskId: String, _ editingTime: Bool) -> Void
    var onOpenSchedule: (RunNowRequest.Kind) -> Void

    @ScaledMetric(relativeTo: .headline) private var headerSize: CGFloat = Metrics.taskGroupTitle

    private var isEmpty: Bool { routines.isEmpty && schedule == nil && scheduleFailure == nil }

    var body: some View {
        if !isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Text("Coming up")
                    .font(.system(size: headerSize, weight: .regular))
                    .foregroundStyle(Palette.secondaryText)
                    .padding(.vertical, 6)
                    .accessibilityAddTraits(.isHeader)
                if let schedule {
                    ScheduledRows(info: schedule, now: now, onOpen: onOpenSchedule)
                        .transition(.opacity)
                    if !routines.isEmpty { divider }
                } else if let scheduleFailure {
                    InlineFailure(reason: scheduleFailure, onRetry: actions.refresh)
                        .padding(.vertical, 10)
                        .transition(.opacity)
                }
                ForEach(Array(routines.enumerated()), id: \.element.id) { index, task in
                    if index > 0 { divider }
                    if let routine = task.routine {
                        RoutineRow(
                            task: task, routine: routine, requests: requests, now: now,
                            onOpen: { onOpenRoutine(task.id, false) },
                            onEditTime: { onOpenRoutine(task.id, true) },
                            actions: actions
                        )
                        .transition(.opacity)
                    } else {
                        // A scheduled task of an older server without a routine: a plain row.
                        TaskRow(
                            task: task, channelTag: nil, query: "", request: requests[task.id], now: now,
                            onOpen: { actions.open(task.id) }, onComplete: { actions.completeWithUndo(task.id) },
                            onRetry: { actions.markComplete(task.id) }
                        )
                    }
                }
            }
            .animation(.easeInOut(duration: 0.25), value: routines.map(\.id))
        }
    }

    private var divider: some View {
        Divider().overlay(Palette.cardBorder).padding(.leading, Metrics.taskCheckbox + 12)
    }
}
