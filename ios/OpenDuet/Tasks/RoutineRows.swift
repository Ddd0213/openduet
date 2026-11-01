// M9 (contract §3): scheduled tasks the assistant set up with schedule_task ("routines") in Tasks >
// Scheduled. A row: the clock where a task row has its checkbox, the title, "Daily at 9:00 AM ·
// next run tomorrow at 9:00 AM" (or "Paused"), and the last run. Tap opens the routine sheet;
// long-press: Run now, Pause / Resume, Edit time, Delete (asks in place under the row). M10: the
// same menu from a trailing ⋯ (RowMoreButton), and the hand-drawn spinner while a change is out.
import SwiftUI

struct RoutineRow: View {
    var task: TaskSummary
    var routine: Routine
    var requests: ShellState.CardRequests
    var now: Date
    var onOpen: () -> Void
    var onEditTime: () -> Void
    var actions: TaskActions

    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var confirmingDelete = false
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = Metrics.taskRowTitle
    @ScaledMetric(relativeTo: .subheadline) private var detailSize: CGFloat = Metrics.taskStatusLine
    @ScaledMetric(relativeTo: .footnote) private var lastSize: CGFloat = 13

    private var request: CardRequest? { requests[ShellState.RequestKey.routine(task.id)] }
    private var deleteRequest: CardRequest? { requests[ShellState.RequestKey.deleteTask(task.id)] }

    var body: some View {
        let copy = ScheduleCopy(format: ChatDateFormat(locale: locale, now: now))
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 0) {
                rowButton(copy)
                // M10: the same menu as the long-press, from a quiet ⋯ (as on task rows).
                RowMoreButton { menu }
                    .padding(.top, 4)
                    .padding(.trailing, -10)
            }
            if let reason = request?.failureReason {
                InlineFailure(reason: reason, onRetry: onOpen)
                    .padding(.leading, Metrics.taskCheckbox + 12)
                    .transition(.opacity)
            }
            if confirmingDelete || deleteRequest == .inFlight {
                DeleteConfirmStrip(
                    question: Text("Delete this scheduled task? It stops running and its history goes."),
                    busy: deleteRequest == .inFlight, failure: deleteRequest?.failureReason,
                    onConfirm: { actions.delete(task.id) },
                    onCancel: { confirmingDelete = false }
                )
                .padding(.bottom, 8)
                .transition(.confirmReveal(reduceMotion: reduceMotion))
            }
        }
        .opacity(deleteRequest == .inFlight ? 0.6 : 1)
        .animation(.easeInOut(duration: 0.2), value: request)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.36, dampingFraction: 0.86), value: confirmingDelete)
        .sensoryFeedback(.warning, trigger: request) { _, new in new?.failureReason != nil }
    }

    /// The row itself: tap opens the routine sheet, long-press opens `menu`.
    private func rowButton(_ copy: ScheduleCopy) -> some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 12) {
                DuetIcon(glyph: .clock, size: Metrics.taskCheckbox, tint: routine.paused ? Palette.secondaryText.opacity(0.6) : Palette.secondaryText)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: task.title)
                        .font(.system(size: titleSize, weight: .medium))
                        .foregroundStyle(routine.paused ? Palette.secondaryText : Palette.primaryText)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Text(verbatim: copy.routineLine(task.schedule, routine))
                        .font(.system(size: detailSize))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                    // M22: paused by the fatigue rule (3 failed runs in a row) says so.
                    if let paused = TaskRowRules.pausedByFailures(routine) {
                        Text(verbatim: PhraseText.string(paused, locale: locale))
                            .font(.system(size: lastSize))
                            .foregroundStyle(Palette.failure)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let last = copy.lastRun(routine) {
                        Text(verbatim: last)
                            .font(.system(size: lastSize))
                            .foregroundStyle(routine.lastRunStatus == .failed ? Palette.failure : Palette.secondaryText)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if request == .inFlight {
                    // M10: the hand-drawn spinner.
                    SpinnerArc(size: 15, color: Palette.secondaryText, lineWidth: 1.8)
                        .padding(.top, 4)
                        .transition(.opacity)
                }
            }
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .cleanContextPreview()
        .contextMenu { menu }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(Text("Shows the times, past runs and Run now"))
        .accessibilityAction(named: Text("Run now")) { actions.runRoutine(task.id) }
        .accessibilityAction(named: routine.paused ? Text("Resume") : Text("Pause")) { actions.setRoutinePaused(task.id, !routine.paused) }
        .accessibilityAction(named: Text("Edit time")) { onEditTime() }
        .accessibilityAction(named: Text("Delete")) { confirmingDelete = true }
    }

    @ViewBuilder private var menu: some View {
        Button { actions.runRoutine(task.id) } label: {
            Label { Text("Run now") } icon: { Image(systemName: DuetGlyph.play.symbol) }
        }
        .disabled(request == .inFlight)
        Button { actions.setRoutinePaused(task.id, !routine.paused) } label: {
            if routine.paused {
                Label { Text("Resume") } icon: { Image(systemName: DuetGlyph.play.symbol) }
            } else {
                Label { Text("Pause") } icon: { Image(systemName: "pause") }
            }
        }
        .disabled(request == .inFlight)
        Button(action: onEditTime) {
            Label { Text("Edit time") } icon: { Image(systemName: DuetGlyph.clock.symbol) }
        }
        Divider()
        Button(role: .destructive) { confirmingDelete = true } label: {
            Label { Text("Delete") } icon: { Image(systemName: DuetGlyph.delete.symbol) }
        }
    }
}

/// The routine sheet (tap a routine row): the title (editable), its times with Change (the
/// schedule pickers), the quiet note, Pause / Resume and Run now, the run history (each run opens
/// its run details) and Delete. It closes itself when the routine goes away (deleted anywhere).
struct RoutineSheet: View {
    var task: TaskSummary
    var routine: Routine
    var runs: [RunRecord]?
    var requests: ShellState.CardRequests
    var actions: TaskActions
    /// opened from the long-press "Edit time": the pickers are open
    var editingTime: Bool
    var onClose: () -> Void

    private enum LastTap: Hashable { case run, pause, save }

    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var title = ""
    @State private var editing = false
    @State private var lastTap: LastTap?
    @State private var ran = false
    @State private var runPage: String?
    @FocusState private var titleFocused: Bool
    @ScaledMetric(relativeTo: .title) private var titleSize: CGFloat = 26
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var rowSize: CGFloat = 15
    @ScaledMetric(relativeTo: .subheadline) private var noteSize: CGFloat = 14

    private var request: CardRequest? { requests[ShellState.RequestKey.routine(task.id)] }
    private var runsRequest: CardRequest? { requests[ShellState.RequestKey.routineRuns(task.id)] }
    private var deleteRequest: CardRequest? { requests[ShellState.RequestKey.deleteTask(task.id)] }

    var body: some View {
        PushContainer(page: $runPage) {
            TimelineView(.everyMinute) { timeline in
                let copy = ScheduleCopy(format: ChatDateFormat(locale: locale, now: timeline.date))
                VStack(spacing: 0) {
                    SheetHeader(title: nil, leading: .close, onLeading: onClose)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 22) {
                            header(copy)
                            timeSection(copy)
                            controls
                            historySection(copy)
                            CardSection {
                                InlineConfirm(
                                    title: Text("Delete scheduled task"),
                                    question: Text("Delete this scheduled task? It stops running and its history goes."),
                                    confirmTitle: Text("Delete"),
                                    busy: deleteRequest == .inFlight, failure: deleteRequest?.failureReason
                                ) { actions.delete(task.id) }
                            }
                        }
                        .padding(.horizontal, 20)
                        .padding(.bottom, 40)
                    }
                    .scrollIndicators(.hidden)
                    .scrollDismissesKeyboard(.interactively)
                }
            }
        } destination: { runId in
            RunDetailPage(runId: runId, leading: .back) { runPage = nil }
        }
        .animation(.easeInOut(duration: 0.25), value: request)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.38, dampingFraction: 0.86), value: editing)
        .onAppear {
            title = task.title
            editing = editingTime
            actions.loadRoutineRuns(task.id)
        }
        .onChange(of: task.title) { _, new in if !titleFocused { title = new } }
        .onChange(of: titleFocused) { _, focused in if !focused { saveTitle() } }
        .onChange(of: request) { old, new in
            guard old == .inFlight, new == nil else { return }
            switch lastTap {
            case .run: ran = true
            case .save: editing = false
            case .pause, nil: break
            }
        }
        .sensoryFeedback(.success, trigger: ran) { _, new in new }
        .sensoryFeedback(.warning, trigger: request) { _, new in new?.failureReason != nil }
    }

    // MARK: Header

    private func header(_ copy: ScheduleCopy) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            DuetIconTile(glyph: .clock, size: 48)
            TextField(text: $title, axis: .vertical) { Text("Name this scheduled task") }
                .font(Typography.serifTitle(titleSize))
                .foregroundStyle(Palette.primaryText)
                .lineLimit(1...3)
                .focused($titleFocused)
                .submitLabel(.done)
                .onSubmit { titleFocused = false }
                .accessibilityLabel(Text("Title"))
            Text(verbatim: copy.routineLine(task.schedule, routine))
                .font(.system(size: bodySize - 1))
                .foregroundStyle(Palette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.opacity)
            if routine.quiet {
                Text("Quiet: OpenDuet posts only when something needs you.")
                    .font(.system(size: noteSize))
                    .foregroundStyle(Palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func saveTitle() {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != task.title else {
            title = task.title
            return
        }
        lastTap = .save
        actions.updateRoutine(task.id, nil, trimmed)
    }

    // MARK: Time

    @ViewBuilder private func timeSection(_ copy: ScheduleCopy) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Time"))
            CardSection {
                if editing {
                    ScheduleEditor(
                        schedule: task.schedule, busy: request == .inFlight && lastTap == .save,
                        onSave: { schedule in
                            lastTap = .save
                            actions.updateRoutine(task.id, schedule, nil)
                        },
                        onCancel: { editing = false }
                    )
                    .transition(.opacity)
                } else {
                    HStack(spacing: 12) {
                        Text(verbatim: task.schedule.map(copy.schedule) ?? "")
                            .font(.system(size: rowSize))
                            .foregroundStyle(Palette.primaryText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button { editing = true } label: {
                            Text("Change")
                                .font(.system(size: rowSize, weight: .semibold))
                                .foregroundStyle(Palette.accent)
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(PressableButtonStyle(scale: 0.95))
                        .accessibilityLabel(Text("Edit time"))
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 4)
                    .transition(.opacity)
                }
            }
        }
    }

    // MARK: Pause / Resume, Run now

    private var controls: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                CapsuleButton(
                    title: routine.paused ? Text("Resume") : Text("Pause"), style: .outline,
                    busy: request == .inFlight && lastTap == .pause
                ) {
                    lastTap = .pause
                    actions.setRoutinePaused(task.id, !routine.paused)
                }
                CapsuleButton(title: Text("Run now"), busy: request == .inFlight && lastTap == .run) {
                    lastTap = .run
                    ran = false
                    actions.runRoutine(task.id)
                }
            }
            .disabled(request == .inFlight)
            if ran && request == nil {
                Label {
                    Text("Running now. What it finds will show up in Chat and Tasks.")
                } icon: {
                    DuetIcon(glyph: .done, size: 16, tint: Palette.success)
                }
                .font(.system(size: noteSize))
                .foregroundStyle(Palette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
                .transition(.opacity)
            }
            if let reason = request?.failureReason {
                InlineFailure(reason: reason, onRetry: retry)
                    .transition(.opacity)
            }
        }
    }

    private func retry() {
        switch lastTap {
        case .run: actions.runRoutine(task.id)
        case .pause: actions.setRoutinePaused(task.id, !routine.paused)
        case .save, nil: editing = true
        }
    }

    // MARK: History

    private func historySection(_ copy: ScheduleCopy) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Run history"))
            if let runs, !runs.isEmpty {
                CardSection(dividerInset: 16 + 18 + 10) {
                    ForEach(runs) { run in historyRow(run, copy: copy) }
                }
                if let reason = runsRequest?.failureReason {
                    InlineFailure(reason: reason) { actions.loadRoutineRuns(task.id) }
                        .padding(.top, 8)
                }
            } else if let reason = runsRequest?.failureReason {
                InlineRetryLine(reason: reason) { actions.loadRoutineRuns(task.id) }
                    .cardSurface()
            } else if runs == nil {
                RunRowsSkeleton(rows: 3)
            } else {
                Text("No runs yet")
                    .font(.system(size: rowSize))
                    .foregroundStyle(Palette.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .cardSurface()
            }
        }
        .animation(.easeInOut(duration: 0.25), value: runs?.map(\.id))
    }

    private func historyRow(_ run: RunRecord, copy: ScheduleCopy) -> some View {
        Button { runPage = run.id } label: {
            HStack(spacing: 10) {
                DuetIcon(glyph: Self.glyph(run.status), size: 18, tint: Self.tint(run.status))
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
                RowChevron()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("Opens its run details"))
    }

    static func glyph(_ status: RunRecord.Status) -> DuetGlyph {
        switch status {
        case .completed, .resolved: .done
        case .failed: .failed
        case .queued, .running, .skipped: .pending
        }
    }

    static func tint(_ status: RunRecord.Status) -> Color {
        switch status {
        case .completed, .resolved: Palette.success
        case .running: Palette.working
        case .queued, .skipped: Palette.secondaryText
        case .failed: Palette.failure
        }
    }
}

/// A routine's time pickers: how often (every day, weekdays, a weekday, every hour, once), then
/// the time (or the minute past the hour, or the date and time), Cancel | Save.
struct ScheduleEditor: View {
    var schedule: Schedule?
    var busy: Bool
    var onSave: (Schedule) -> Void
    var onCancel: () -> Void

    @Environment(\.locale) private var locale
    @State private var cadence: Schedule.Cadence = .daily
    @State private var time = Date()
    @State private var weekday = 1
    @State private var minute = 0
    @State private var loaded = false
    @ScaledMetric(relativeTo: .subheadline) private var labelSize: CGFloat = 15

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            row(Text("Repeats")) {
                Picker(selection: $cadence) {
                    ForEach(Self.cadences, id: \.self) { cadence in
                        Text(Self.title(cadence)).tag(cadence)
                    }
                } label: {
                    Text("Repeats")
                }
                .pickerStyle(.menu)
                .tint(Palette.accent)
            }
            switch cadence {
            case .weekly:
                row(Text("Day")) {
                    Picker(selection: $weekday) {
                        ForEach(0..<7, id: \.self) { day in
                            Text(verbatim: weekdayName(day)).tag(day)
                        }
                    } label: {
                        Text("Day")
                    }
                    .pickerStyle(.menu)
                    .tint(Palette.accent)
                }
                timeRow
            case .hourly:
                row(Text("Minute past the hour")) {
                    Picker(selection: $minute) {
                        ForEach(Array(stride(from: 0, to: 60, by: 5)), id: \.self) { value in
                            Text(verbatim: String(format: ":%02d", value)).tag(value)
                        }
                    } label: {
                        Text("Minute past the hour")
                    }
                    .pickerStyle(.menu)
                    .tint(Palette.accent)
                }
            case .once:
                DatePicker(selection: $time, in: Date()..., displayedComponents: [.date, .hourAndMinute]) {
                    Text("When").font(.system(size: labelSize)).foregroundStyle(Palette.primaryText)
                }
                .tint(Palette.accent)
            case .daily, .weekdays:
                timeRow
            }
            HStack(spacing: 10) {
                CapsuleButton(title: Text("Cancel"), style: .outline, action: onCancel)
                    .disabled(busy)
                CapsuleButton(title: Text("Save"), busy: busy) { onSave(built) }
                    .disabled(busy || built == schedule)
            }
            .padding(.top, 4)
        }
        .padding(16)
        .onAppear(perform: load)
    }

    private var timeRow: some View {
        DatePicker(selection: $time, displayedComponents: .hourAndMinute) {
            Text("Time").font(.system(size: labelSize)).foregroundStyle(Palette.primaryText)
        }
        .tint(Palette.accent)
    }

    private func row<Content: View>(_ label: Text, @ViewBuilder content: () -> Content) -> some View {
        HStack {
            label.font(.system(size: labelSize)).foregroundStyle(Palette.primaryText)
            Spacer(minLength: 8)
            content()
        }
        .frame(minHeight: 44)
    }

    private static let cadences: [Schedule.Cadence] = [.daily, .weekdays, .weekly, .hourly, .once]

    static func title(_ cadence: Schedule.Cadence) -> LocalizedStringResource {
        switch cadence {
        case .daily: "Every day"
        case .weekdays: "Weekdays"
        case .weekly: "Every week"
        case .hourly: "Every hour"
        case .once: "Once"
        }
    }

    private func weekdayName(_ day: Int) -> String {
        ScheduleCopy(format: ChatDateFormat(locale: locale)).weekdayName(day)
    }

    /// The pickers start at the routine's current time (9:00 AM daily when it has none).
    private func load() {
        guard !loaded else { return }
        loaded = true
        let current = schedule ?? Schedule(cadence: .daily, hour: 9, minute: 0, weekday: nil, at: nil)
        cadence = current.cadence
        weekday = current.weekday ?? 1
        minute = (current.minute / 5) * 5
        let calendar = Calendar.current
        if current.cadence == .once, let at = current.at, at > .now {
            time = at
        } else {
            let base = current.cadence == .once ? calendar.date(byAdding: .day, value: 1, to: .now) ?? .now : .now
            time = calendar.date(bySettingHour: current.hour, minute: current.minute, second: 0, of: base) ?? .now
        }
    }

    /// The schedule the pickers show, in the iPhone's time zone (the server's user zone).
    var built: Schedule {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: time)
        let hour = parts.hour ?? 9, mins = parts.minute ?? 0
        switch cadence {
        case .daily, .weekdays: return Schedule(cadence: cadence, hour: hour, minute: mins, weekday: nil, at: nil)
        case .weekly: return Schedule(cadence: .weekly, hour: hour, minute: mins, weekday: weekday, at: nil)
        case .hourly: return Schedule(cadence: .hourly, hour: schedule?.hour ?? 0, minute: minute, weekday: nil, at: nil)
        case .once: return Schedule(cadence: .once, hour: hour, minute: mins, weekday: nil, at: time)
        }
    }
}
