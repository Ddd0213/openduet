// The schedule sheet (prompt L118): tapping Check-in (or Morning brief) shows its times ("At 10:49
// AM, 1:49 PM, 4:49 PM, 7:49 PM and 10:49 PM, every weekday" / "every day" once weekends are
// on), the next run, the run history ("Today at 1:49 PM · Resolved", Skipped too) and "Run now"
// (spinner in flight; on success a line says the result will show up in Chat and Tasks).
import SwiftUI

struct ScheduleSheet: View {
    var kind: RunNowRequest.Kind
    var info: ScheduleInfo
    /// cardRequests[RequestKey.runNow(kind)]
    var request: CardRequest?
    var onRunNow: () -> Void
    var onClose: () -> Void

    @Environment(\.locale) private var locale
    @State private var ran = false
    @ScaledMetric(relativeTo: .title) private var titleSize: CGFloat = 26
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var rowSize: CGFloat = 15
    @ScaledMetric(relativeTo: .subheadline) private var noteSize: CGFloat = 14

    private var history: [RunRecord] {
        ScheduleCopy.history(kind == .brief ? info.brief.history : info.checkin.history)
    }

    var body: some View {
        TimelineView(.everyMinute) { timeline in
            let copy = ScheduleCopy(format: ChatDateFormat(locale: locale, now: timeline.date))
            VStack(spacing: 0) {
                SheetHeader(title: nil, leading: .close, onLeading: onClose)
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        header(copy)
                        runNow
                        historySection(copy)
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 40)
                }
                .scrollIndicators(.hidden)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: request)
        .animation(.easeInOut(duration: 0.25), value: ran)
        .onChange(of: request) { old, new in
            if old == .inFlight, new == nil { ran = true }
        }
        .sensoryFeedback(.success, trigger: ran) { _, new in new }
        .sensoryFeedback(.warning, trigger: request) { _, new in new?.failureReason != nil }
    }

    private func header(_ copy: ScheduleCopy) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            IconTile(app: nil, systemImage: "clock", size: 48, tint: Palette.primaryText)
            (kind == .brief ? Text("Morning brief") : Text("Check-in"))
                .font(Typography.serifTitle(titleSize))
                .foregroundStyle(Palette.primaryText)
                .accessibilityAddTraits(.isHeader)
            timesLine(copy)
                .font(.system(size: bodySize))
                .foregroundStyle(Palette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
            Text("Next run \(copy.nextRun(kind == .brief ? info.brief.nextRunAt : info.checkin.nextRunAt))")
                .font(.system(size: bodySize - 1))
                .foregroundStyle(Palette.secondaryText)
                .contentTransition(.opacity)
        }
    }

    private func timesLine(_ copy: ScheduleCopy) -> Text {
        let times = copy.timeList(kind == .brief ? [info.brief.time] : info.checkin.times)
        return info.weekendsOn ? Text("At \(times), every day") : Text("At \(times), every weekday")
    }

    private var runNow: some View {
        VStack(alignment: .leading, spacing: 10) {
            CapsuleButton(title: Text("Run now"), busy: request == .inFlight, action: onRunNow)
                .disabled(request == .inFlight)
            if ran && request == nil {
                Label {
                    Text("Running now. What it finds will show up in Chat and Tasks.")
                } icon: {
                    DuetIcon(glyph: .done, size: noteSize + 3, tint: Palette.success)
                }
                .font(.system(size: noteSize))
                .foregroundStyle(Palette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
                .transition(.opacity)
            }
            if let reason = request?.failureReason {
                InlineFailure(reason: reason, onRetry: onRunNow)
                    .transition(.opacity)
            }
        }
    }

    private func historySection(_ copy: ScheduleCopy) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Run history"))
            if history.isEmpty {
                Text("No runs yet")
                    .font(.system(size: rowSize))
                    .foregroundStyle(Palette.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .cardSurface()
            } else {
                CardSection {
                    ForEach(history) { run in
                        historyRow(run, copy: copy)
                    }
                }
            }
        }
    }

    private func historyRow(_ run: RunRecord, copy: ScheduleCopy) -> some View {
        HStack(spacing: 10) {
            RunStatusDot(status: run.status)
            Group {
                if let date = ScheduleCopy.runDate(run) {
                    Text("\(copy.runDay(date)) · \(Text(run.status.word))")
                } else {
                    Text(run.status.word)
                }
            }
            .font(.system(size: rowSize))
            .foregroundStyle(Palette.primaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }
}

extension RunRecord.Status {
    /// The history line's status word (glossary: Resolved 已完成).
    var word: LocalizedStringResource {
        switch self {
        case .queued: "Queued"
        case .running: "Running"
        case .completed: "Posted"
        case .resolved: "Resolved"
        case .skipped: "Skipped"
        case .failed: "Failed"
        }
    }
}

/// A small dot in the run's colour: green done, blue running, grey skipped / queued, red failed.
private struct RunStatusDot: View {
    var status: RunRecord.Status

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }

    private var color: Color {
        switch status {
        case .completed, .resolved: Palette.success
        case .running: Palette.working
        case .queued, .skipped: Palette.secondaryText.opacity(0.6)
        case .failed: Palette.failure
        }
    }
}
