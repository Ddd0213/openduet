// The Tasks tab (prompt L116-L120, L184-L185): under the shared header, the big segmented
// title "Active" | "Up next" (~28 pt, selected primary, the other grey) with sort ⇅ and search
// on the right. Active groups the tasks with counts; search opens an inline field and highlights
// the match; pull to refresh. Up next lists "From your connectors" suggestions with Add, or the
// empty state with "Show me". Skeletons while loading, a grey reason + Retry on failure. M8: the
// checkbox resolves at once with a "Marked complete · Undo" toast for ~4 s; the PATCH goes out
// when it expires (TasksState.undo, the store's timer).
// M22 (plan §5 「任务列表分类」): Active is Pinned → Ready for review → Waiting on you (the Needs
// you cards outside any task first) → Failed → Working → Just done → Done (folded, 7 days, its
// last row "Earlier"); routines and the Morning brief / Check-in moved to Up next's "Coming up".
// A checked or reopened row stays ~0.45 s before it moves (TaskGrouping.checkHold). The search
// asks the server (debounced by the store), so tasks of any age are found.
import SwiftUI

/// Which update a row last asked for, so its Retry repeats the same one.
enum TaskRowAction: Hashable, Sendable { case complete, archive }

struct TasksTabView: View {
    var state: TasksState
    var requests: ShellState.CardRequests
    var actions: TaskActions
    /// Mark complete / Archive taps by task id (from the row or the task detail's ⋯).
    var rowActions: [String: TaskRowAction]
    /// Ids of the channels other than the main thread (MenuState.channels), for the tag line.
    var otherChannels: Set<String> = []
    /// M22: those channels' colours (MenuState.channels), for the dot before the label in Everything.
    var channelColors: [String: ChannelColor] = [:]
    @Binding var searchFocused: Bool
    var onMarkComplete: (String) -> Void
    var onArchive: (String) -> Void
    var onMessageAssistant: () -> Void
    /// M9: the title row's small "+" (next to sort and search) opens the New task sheet; it
    /// replaces the Tasks tab's floating + FAB. nil = no "+".
    var onNewTask: (() -> Void)? = nil

    enum Segment: Hashable { case active, upNext }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var segment: Segment = .active
    @State private var sort: TaskSort = .updated
    @State private var searching = false
    @State private var query = ""
    @State private var collapsed: Set<TaskGroupKind> = Set(TaskGroupKind.allCases.filter(\.startsCollapsed))
    /// M22: rows just checked (or reopened), kept in their group for TaskGrouping.checkHold.
    @State private var holding: [String: TaskGroupKind] = [:]
    /// Mirrors `state.refreshing` so the pull's async closure can wait for it.
    @State private var refreshing = false
    @FocusState private var fieldFocused: Bool
    /// The schedule sheet (Morning brief or Check-in) on screen.
    @State private var scheduleSheet: ScheduleSheetItem?
    @ScaledMetric(relativeTo: .body) private var fieldSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var noMatchSize: CGFloat = 15

    private struct ScheduleSheetItem: Identifiable, Hashable {
        var kind: RunNowRequest.Kind
        var id: String { kind.rawValue }
    }

    /// M9: a routine's sheet (tap a routine row, or its long-press "Edit time": the pickers open).
    private struct RoutineSheetItem: Identifiable, Hashable {
        var taskId: String
        var editingTime: Bool
        var id: String { taskId }
    }
    @State private var routineSheet: RoutineSheetItem?

    /// M10: the task whose Rename sheet is open (from its ⋯, long-press or the failure's Retry).
    private struct RenameSheetItem: Identifiable, Hashable {
        var taskId: String
        var id: String { taskId }
    }
    @State private var renameSheet: RenameSheetItem?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                titleRow
                    .padding(.bottom, 8)
                if searching && segment == .active {
                    searchField
                        .padding(.bottom, 12)
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
                }
                switch segment {
                case .active: active.transition(.opacity)
                case .upNext: upNext.transition(.opacity)
                }
            }
            .padding(.horizontal, Metrics.threadInset + 4)
            .padding(.bottom, 24)
            .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.38, dampingFraction: 0.86), value: segment)
            .animation(.easeInOut(duration: 0.25), value: searching)
        }
        .scrollDismissesKeyboard(.immediately)
        .refreshable { await pullToRefresh() }
        .overlay(alignment: .bottom) {
            if let undo = state.undo {
                CompletionUndoToast(onUndo: actions.undoComplete)
                    .id(undo.id)
                    .padding(.bottom, 12)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.38, dampingFraction: 0.86), value: state.undo)
        .onAppear { actions.refresh() }
        .onChange(of: state.refreshing, initial: true) { _, now in refreshing = now }
        .onChange(of: fieldFocused) { _, focused in searchFocused = focused }
        .onChange(of: searchFocused) { _, focused in if !focused { fieldFocused = false } }
        // M22: the server search follows the field (the store debounces and cancels).
        .onChange(of: query) { _, text in actions.search(searching ? text : "") }
        .sensoryFeedback(.selection, trigger: segment)
        .sheet(item: $scheduleSheet) { item in
            if let info = state.schedule.info {
                ScheduleSheet(
                    kind: item.kind, info: info,
                    request: requests[ShellState.RequestKey.runNow(item.kind)],
                    onRunNow: { actions.runNow(item.kind) },
                    onClose: { scheduleSheet = nil }
                )
                .duetSheetChrome()
                .presentationDetents([.medium, .large])
            }
        }
        .sheet(item: $routineSheet) { item in
            if let task = findTask(item.taskId), let routine = task.routine {
                RoutineSheet(
                    task: task, routine: routine, runs: state.routineRuns[task.id], requests: requests,
                    actions: actions, editingTime: item.editingTime,
                    onClose: { routineSheet = nil }
                )
                .duetSheetChrome()
                .presentationDetents([.large])
            }
        }
        // The sheet closes when its routine goes away (deleted here or anywhere else).
        .onChange(of: routineSheet.flatMap { findTask($0.taskId)?.routine } != nil) { _, present in
            if !present, routineSheet != nil { routineSheet = nil }
        }
        .sheet(item: $renameSheet) { item in
            if let task = findTask(item.taskId) {
                RenameTaskSheet(
                    task: task,
                    request: requests[ShellState.RequestKey.renameTask(task.id)],
                    busyElsewhere: requests[ShellState.RequestKey.pinTask(task.id)] == .inFlight,
                    onSave: { actions.rename(task.id, $0) },
                    onClose: { renameSheet = nil }
                )
                .duetSheetChrome()
                .presentationDetents([.height(280), .medium])
            }
        }
        // M10: likewise the Rename sheet when its task goes away.
        .onChange(of: renameSheet.flatMap { findTask($0.taskId) } != nil) { _, present in
            if !present, renameSheet != nil { renameSheet = nil }
        }
    }

    /// M22: a task from the list, an "Earlier" page or the search answer.
    private func findTask(_ id: String) -> TaskSummary? {
        state.tasks.first { $0.id == id } ?? state.older.tasks.first { $0.id == id } ?? state.search.tasks.first { $0.id == id }
    }

    // MARK: - Title row

    private var titleRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            segmentButton(.active, title: Text("Active"))
            segmentButton(.upNext, title: Text("Up next"))
            Spacer(minLength: 8)
            HStack(spacing: 0) {
                if segment == .active {
                    sortMenu
                        .transition(.opacity)
                    Button { toggleSearch() } label: {
                        DuetIcon(glyph: searching ? .close : .search, size: 20, tint: Palette.primaryText)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel(searching ? Text("Close search") : Text("Search tasks"))
                    .transition(.opacity)
                }
                // M9: the small "+" replaces the Tasks tab's floating + (both segments).
                if let onNewTask {
                    Button(action: onNewTask) {
                        DuetIcon(glyph: .add, size: 21, tint: Palette.primaryText)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel(Text("New task"))
                    .transition(.opacity)
                }
            }
            .buttonStyle(PressableButtonStyle(scale: 0.9))
            // The 44 pt buttons centre on the title's capitals, not on its baseline.
            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + Metrics.tasksTitle * 0.36 }
        }
        .padding(.top, 4)
    }

    private func segmentButton(_ value: Segment, title: Text) -> some View {
        Button {
            guard segment != value else { return }
            segment = value
        } label: {
            title
                .font(.system(size: Metrics.tasksTitle, weight: .bold))
                .foregroundStyle(segment == value ? Palette.primaryText : Palette.secondaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .buttonStyle(PressableButtonStyle(scale: 0.96))
        .accessibilityAddTraits(segment == value ? [.isSelected, .isHeader] : [])
    }

    private var sortMenu: some View {
        Menu {
            Picker(selection: $sort) {
                Text("Last updated").tag(TaskSort.updated)
                Text("Date created").tag(TaskSort.created)
            } label: {
                Text("Sort")
            }
        } label: {
            DuetIcon(glyph: .sort, size: 20, tint: Palette.primaryText)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(Text("Sort"))
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            DuetIcon(glyph: .search, size: fieldSize + 2, tint: Palette.secondaryText)
            TextField(text: $query) { Text("Search tasks") }
                .focused($fieldFocused)
                .submitLabel(.search)
                .autocorrectionDisabled()
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.secondaryText)
                        .frame(minWidth: 32, minHeight: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Clear search"))
            }
        }
        .font(.system(size: fieldSize))
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Capsule().fill(Palette.cardSurface).strokeBorder(Palette.cardBorder, lineWidth: Metrics.hairline))
    }

    private func toggleSearch() {
        searching.toggle()
        if searching {
            fieldFocused = true
        } else {
            query = ""
            fieldFocused = false
            // M22: back to the normal list (onChange(of: query) doesn't fire for an empty field).
            actions.search("")
        }
    }

    /// M22: what the search field asks for (trimmed); "" while it's closed or empty.
    private var needle: String { searching ? TaskGrouping.normalized(query) : "" }

    // MARK: - Active

    @ViewBuilder
    private var active: some View {
        switch state.phase {
        case .loading where state.tasks.isEmpty:
            TaskRowsSkeleton().padding(.top, 8)
        case .failed(let reason) where state.tasks.isEmpty:
            InlineRetryLine(reason: reason, onRetry: actions.refresh)
        default:
            TimelineView(.everyMinute) { timeline in
                if needle.isEmpty {
                    activeList(now: timeline.date)
                } else {
                    searchList(now: timeline.date)
                }
            }
        }
    }

    /// The normal list; with nothing in it, the empty state.
    @ViewBuilder
    private func activeList(now: Date) -> some View {
        let groups = activeGroups(now: now)
        if groups.isEmpty {
            EmptyStateView(
                systemImage: "checklist",
                message: "Tasks you give OpenDuet show up here.",
                actionTitle: "Message OpenDuet",
                action: onMessageAssistant
            )
            .frame(minHeight: 360)
        } else {
            VStack(alignment: .leading, spacing: 18) {
                ForEach(groups) { group in
                    groupView(group, now: now, searching: false)
                }
            }
        }
    }

    /// M22: Active's groups; Waiting on you also for Needs you cards alone, Done also for "Earlier"
    /// alone (no task of the last 7 days, older ones on the server).
    private func activeGroups(now: Date) -> [TaskGroup] {
        var groups = TaskGrouping.groups(state.tasks, sort: sort, now: now, holding: holding, running: running)
        if !cards.isEmpty { groups = TaskGrouping.ensuring(.needsInput, in: groups) }
        if state.olderResolved > 0 || !state.older.tasks.isEmpty { groups = TaskGrouping.ensuring(.done, in: groups) }
        return groups
    }

    /// M22: a search: the server's answer (title or prompt, any age, routines in "Coming up");
    /// until it comes, the list's own titles that match, with "Searching…".
    @ViewBuilder
    private func searchList(now: Date) -> some View {
        let search = state.search
        let answered = search.results(for: needle)
        let groups = answered.map { TaskGrouping.groups($0, sort: sort, now: now, holding: holding, searching: true) }
            ?? TaskGrouping.groups(state.tasks, sort: sort, query: needle, now: now, holding: holding, running: running, searching: true)
        VStack(alignment: .leading, spacing: 18) {
            ForEach(groups) { group in
                groupView(group, now: now, searching: true)
            }
            if answered == nil, search.phase == .loading {
                searchingLine(alone: groups.isEmpty)
            } else if case .failed(let reason) = search.phase {
                InlineFailure(reason: reason) { actions.search(needle) }
            } else if groups.isEmpty {
                Text("No tasks match \u{201C}\(needle)\u{201D}")
                    .font(.system(size: noMatchSize))
                    .foregroundStyle(Palette.secondaryText)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: search.phase)
    }

    private func searchingLine(alone: Bool) -> some View {
        HStack(spacing: 8) {
            SpinnerArc(size: noMatchSize - 2, color: Palette.secondaryText, lineWidth: 1.6)
            Text("Searching…")
        }
        .font(.system(size: noMatchSize))
        .foregroundStyle(Palette.secondaryText)
        .frame(maxWidth: .infinity, alignment: alone ? .center : .leading)
        .padding(.vertical, alone ? 40 : 4)
        .accessibilityElement(children: .combine)
        .transition(.opacity)
    }

    // MARK: - Groups

    private func groupView(_ group: TaskGroup, now: Date, searching: Bool) -> some View {
        let isCollapsed = collapsed.contains(group.kind) && !searching
        // M22: Waiting on you starts with the Needs you cards; Done ends with "Earlier"'s pages.
        let groupCards = group.kind == .needsInput && !searching ? cards : []
        let older = group.kind == .done && !searching ? state.older.tasks : []
        let tasks = group.tasks + older
        let showsEarlier = group.kind == .done && !searching
            && (state.olderResolved > 0 || !state.older.tasks.isEmpty) && (state.older.hasMore || Self.isFailed(state.older.phase))
        let ids = groupCards.map(\.messageId) + tasks.map(\.id)
        return VStack(alignment: .leading, spacing: 0) {
            TaskGroupHeader(
                kind: group.kind, count: groupCards.count + tasks.count, updatedAt: state.updatedAt, now: now,
                collapsed: isCollapsed
            ) {
                withAnimation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.35, dampingFraction: 0.86)) {
                    if collapsed.contains(group.kind) { collapsed.remove(group.kind) } else { collapsed.insert(group.kind) }
                }
            }
            if !isCollapsed {
                ForEach(Array(groupCards.enumerated()), id: \.element.messageId) { index, card in
                    if index > 0 { divider }
                    NeedsYouCardRow(
                        card: card, channelTag: channelTag(card.channelId), channelColor: dotColor(card.channelId),
                        onOpen: { if let url = URL(string: card.route) { actions.openRoute(url) } }
                    )
                    .transition(.opacity)
                }
                ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                    if index > 0 || !groupCards.isEmpty { divider }
                    row(task, in: group.kind, now: now, searching: searching)
                        .transition(.opacity)
                }
                if showsEarlier {
                    if !tasks.isEmpty { divider }
                    DoneEarlierRow(older: state.older, onLoad: actions.loadOlderResolved)
                }
            }
        }
        // M22: rows change group without a slide under Reduce Motion (a short fade only).
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .easeInOut(duration: 0.25), value: ids)
    }

    private var divider: some View {
        Divider().overlay(Palette.cardBorder).padding(.leading, Metrics.taskCheckbox + 12)
    }

    @ViewBuilder
    private func row(_ task: TaskSummary, in kind: TaskGroupKind, now: Date, searching: Bool) -> some View {
        if let routine = task.routine, task.status != .resolved {
            // M9: a scheduled task the assistant runs on its schedule (contract §3); in Active only while
            // a run of it is going or stopped for you (M22).
            RoutineRow(
                task: task, routine: routine, requests: requests, now: now,
                onOpen: { routineSheet = RoutineSheetItem(taskId: task.id, editingTime: false) },
                onEditTime: { routineSheet = RoutineSheetItem(taskId: task.id, editingTime: true) },
                actions: actions
            )
        } else {
            TaskRow(
                task: task, channelTag: channelTag(task.channelId), query: searching ? needle : "",
                request: requests[task.id], now: now,
                onOpen: { actions.open(task.id) },
                // M8: resolved at once with "Marked complete · Undo"; PATCH when it expires. M22: the
                // row stays in its group for a moment so the tick is seen.
                onComplete: {
                    hold(task.id, in: kind)
                    actions.completeWithUndo(task.id)
                },
                onRetry: { retry(task.id) },
                menu: rowMenu(task),
                channelColor: dotColor(task.channelId),
                tryAgainRequest: requests[ShellState.RequestKey.retryTask(task.id)],
                onTryAgain: { actions.retry(task.id) },
                reopenRequest: requests[ShellState.RequestKey.reopenTask(task.id)],
                onReopen: {
                    hold(task.id, in: kind)
                    actions.reopen(task.id)
                }
            )
        }
    }

    // MARK: - Up next and Coming up (M22)

    private var upNext: some View {
        TimelineView(.everyMinute) { timeline in
            VStack(alignment: .leading, spacing: 18) {
                UpNextList(state: state.upNext, requests: requests, actions: actions)
                ComingUpSection(
                    routines: TaskGrouping.comingUp(state.tasks, now: timeline.date, running: running),
                    schedule: showsSchedule ? state.schedule.info : nil,
                    scheduleFailure: scheduleFailure,
                    requests: requests, actions: actions, now: timeline.date,
                    onOpenRoutine: { id, editing in routineSheet = RoutineSheetItem(taskId: id, editingTime: editing) },
                    onOpenSchedule: { scheduleSheet = ScheduleSheetItem(kind: $0) }
                )
            }
        }
    }

    /// Morning brief and Check-in (L118) in Everything once GET /api/schedule has answered (or
    /// failed). M9: only when the server runs them (ScheduleInfo.builtins).
    private var showsSchedule: Bool {
        guard state.scopeChannelId == nil else { return false }
        if let info = state.schedule.info { return info.builtins }
        return false
    }

    private var scheduleFailure: String? {
        guard state.scopeChannelId == nil, state.schedule.info == nil, case .failed(let reason) = state.schedule.phase else { return nil }
        return reason
    }

    // MARK: - Helpers

    /// M22: the Needs you cards outside any task (this scope's).
    private var cards: [NeedsYouItem.Card] {
        TaskGrouping.needsYouCards(state.needsYou, scope: state.scopeChannelId)
    }

    /// M22: routines a run is going for (their loaded histories).
    private var running: Set<String> {
        TaskGrouping.runningRoutines(state.routineRuns)
    }

    /// "#name" when the task lives outside the tab's scope (L117): in Everything, a task of
    /// another channel than the main thread; in a channel's scope, a task of any other channel.
    private func channelTag(_ channelId: String) -> String? {
        if let scope = state.scopeChannelId {
            guard channelId != scope else { return nil }
        } else {
            guard otherChannels.contains(channelId) else { return nil }
        }
        return state.channelNames[channelId]
    }

    /// M22: the channel's colour dot, in Everything only (review-ux §13).
    private func dotColor(_ channelId: String) -> ChannelColor? {
        state.scopeChannelId == nil ? channelColors[channelId] : nil
    }

    private static func isFailed(_ phase: OlderTasksState.Phase) -> Bool {
        if case .failed = phase { true } else { false }
    }

    /// M22: a checked or reopened row stays in `kind` for TaskGrouping.checkHold, then moves.
    private func hold(_ taskId: String, in kind: TaskGroupKind) {
        holding[taskId] = kind
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(TaskGrouping.checkHold))
            withAnimation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.38, dampingFraction: 0.86)) {
                holding[taskId] = nil
            }
        }
    }

    /// M9: the row's long-press menu (Pin / Unpin, Mark complete, Archive, Copy link, Delete).
    /// M10: also behind the row's ⋯, with Discuss and Rename.
    private func rowMenu(_ task: TaskSummary) -> TaskRowMenu {
        TaskRowMenu(
            pinRequest: requests[ShellState.RequestKey.pinTask(task.id)],
            deleteRequest: requests[ShellState.RequestKey.deleteTask(task.id)],
            onPin: { actions.setPinned(task.id, $0) },
            onArchive: { onArchive(task.id) },
            onDelete: { actions.delete(task.id) },
            renameRequest: requests[ShellState.RequestKey.renameTask(task.id)],
            onRename: { renameSheet = RenameSheetItem(taskId: task.id) }
        )
    }

    private func retry(_ taskId: String) {
        switch rowActions[taskId] ?? .complete {
        case .complete: onMarkComplete(taskId)
        case .archive: onArchive(taskId)
        }
    }

    // MARK: - Pull to refresh (L185)

    private func pullToRefresh() async {
        actions.refresh()
        // The store sets `refreshing` while the reload runs; wait for it to start and finish.
        let start = Date()
        while !refreshing, Date().timeIntervalSince(start) < 0.6 {
            try? await Task.sleep(for: .milliseconds(50))
        }
        while refreshing, Date().timeIntervalSince(start) < 15 {
            try? await Task.sleep(for: .milliseconds(100))
        }
    }
}
