// Tasks > Scheduled's Morning brief and Check-in rows (prompt L117-L118): a clock icon where a
// task row has its checkbox, the title ~20 pt, then "Weekdays at 8:19 AM · next run tomorrow at
// 8:19 AM" ("Daily at" once weekends are on) or "Next run today at 4:49 PM". A tap opens the
// schedule sheet. While GET /api/schedule hasn't loaded the group isn't shown; a failure is a
// grey line with Retry.
import SwiftUI

struct ScheduledRows: View {
    var info: ScheduleInfo
    var now: Date
    var onOpen: (RunNowRequest.Kind) -> Void

    @Environment(\.locale) private var locale

    var body: some View {
        let copy = ScheduleCopy(format: ChatDateFormat(locale: locale, now: now))
        VStack(alignment: .leading, spacing: 0) {
            ScheduledRow(title: Text("Morning brief"), detail: briefLine(copy)) { onOpen(.brief) }
            Divider().overlay(Palette.cardBorder).padding(.leading, Metrics.taskCheckbox + 12)
            ScheduledRow(title: Text("Check-in"), detail: Text("Next run \(copy.nextRun(info.checkin.nextRunAt))")) { onOpen(.checkin) }
        }
    }

    private func briefLine(_ copy: ScheduleCopy) -> Text {
        let time = copy.time(info.brief.time)
        let next = copy.nextRun(info.brief.nextRunAt)
        return info.weekendsOn
            ? Text("Daily at \(time) · next run \(next)")
            : Text("Weekdays at \(time) · next run \(next)")
    }
}

/// One schedule row, laid out like a task row (L117).
private struct ScheduledRow: View {
    var title: Text
    var detail: Text
    var onOpen: () -> Void

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = Metrics.taskRowTitle
    @ScaledMetric(relativeTo: .subheadline) private var detailSize: CGFloat = Metrics.taskStatusLine

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 12) {
                DuetIcon(glyph: .clock, size: Metrics.taskCheckbox, tint: Palette.secondaryText)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 4) {
                    title
                        .font(.system(size: titleSize, weight: .medium))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(2)
                    detail
                        .font(.system(size: detailSize))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(Text("Shows the times, past runs and Run now"))
    }
}
