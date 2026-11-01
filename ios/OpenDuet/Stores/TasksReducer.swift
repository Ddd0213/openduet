// The Tasks tab's state machine (L116-L120): GET /api/tasks pages, `task` events upserted by
// id, Mark complete / Archive applied optimistically until their PATCH answers (rolled back on
// failure), and the Up next suggestions. Keeps every task it has seen (any scope) for the
// Tasks tab badge; `state.tasks` is the current scope's open (not archived) tasks, newest
// update first. M9: optimistic Pin / Unpin and routine changes (TaskPatch), deletes that stay
// deleted, and the routines' run histories. M22: the list holds unfinished tasks and those
// resolved in the last 7 days; Done's "Earlier" pages and the server search keep their tasks
// aside (live, never in `state.tasks`), Reopen, the Needs you badge and when it refetches.
// Foundation + model types only, so it runs in the Mac host tests.
import Foundation

struct TasksReducer: Sendable {
    private(set) var state = TasksState()
    /// The server's latest copy of every task seen, by id.
    private var confirmed: [String: TaskSummary] = [:]
    /// Optimistic copies while their PATCH is in flight (Mark complete / Archive).
    private var overrides: [String: TaskSummary] = [:]
    /// M9: optimistic Pin / Unpin and routine changes (Pause / Resume, time, title), laid over
    /// the server's copy (and over a Mark complete / Archive override) until their PATCH answers.
    private var patches: [String: TaskPatch] = [:]
    /// M9: tasks deleted (DELETE answered, or task_deleted / channel_deleted): a late `task`
    /// event or list answer never brings them back.
    private var deleted = Set<String>()
    /// Tasks changed by events while a list request was out; that answer doesn't drop them.
    private var touched = Set<String>()
    private var loading = false
    /// M22: tasks known only from Done's "Earlier" pages or a search answer (resolved more than 7
    /// days ago, or not in the list yet): never in `state.tasks`; a reopened one joins the list.
    private var outside: [String: TaskSummary] = [:]
    /// M22: the "Earlier" pages' and the search answer's order, by id.
    private var olderIds: [String] = []
    private var searchIds: [String] = []
    /// M22: a Reopen of a task from `outside` in flight (it moved into the list; a failure moves it back).
    private var reopenedFromOutside = Set<String>()

    /// M9: the optimistic part of a pin / routine PATCH (nil = unchanged).
    struct TaskPatch: Hashable, Sendable {
        var pinned: Bool?
        var paused: Bool?
        var schedule: Schedule?
        var title: String?
    }

    /// The red badge on the Tasks tab. M22: GET /api/needs-you's count once it answered (tasks
    /// and the cards outside any task, counted once), less its tasks settled here since (checked,
    /// archived, deleted); before that, the tasks that need input or are ready for review, not
    /// archived, in any channel.
    var needingUser: Int {
        guard let needsYou = state.needsYou else {
            return displayed.filter { !$0.archived && ($0.status == .needsInput || $0.status == .readyForReview) }.count
        }
        return Self.badgeCount(needsYou) { id in
            deleted.contains(id) || task(id).map { $0.archived || $0.status == .resolved } == true
        }
    }

    /// M22: the Needs you count less the tasks in it that `settled` says are done with.
    static func badgeCount(_ needsYou: NeedsYou, settled: (String) -> Bool) -> Int {
        let gone = needsYou.items.reduce(0) { count, item in
            if case .task(let task) = item, settled(task.id) { return count + 1 }
            return count
        }
        return max(0, needsYou.count - gone)
    }

    /// Every known task as shown (the optimistic copy while an update is in flight).
    private var displayed: [TaskSummary] {
        confirmed.keys.compactMap { task($0) }
    }

    /// The server's copy: the list's, else (M22) an "Earlier" page's or a search answer's.
    private func stored(_ id: String) -> TaskSummary? {
        confirmed[id] ?? outside[id]
    }

    /// The displayed copy of a task (optimistic if an update is in flight).
    func task(_ id: String) -> TaskSummary? {
        guard let base = overrides[id] ?? stored(id) else { return nil }
        return patches[id].map { Self.patched(base, $0) } ?? base
    }

    func isUpdating(_ id: String) -> Bool {
        overrides[id] != nil
    }

    /// M9: a pin or routine PATCH of this task is in flight.
    func isPatching(_ id: String) -> Bool {
        patches[id] != nil
    }

    /// M9: whether DELETE (or a deleted event) removed this task in this session.
    func wasDeleted(_ id: String) -> Bool {
        deleted.contains(id)
    }

    private static func patched(_ task: TaskSummary, _ patch: TaskPatch) -> TaskSummary {
        var task = task
        if let pinned = patch.pinned { task.pinned = pinned }
        if let title = patch.title { task.title = title }
        if let schedule = patch.schedule {
            task.schedule = schedule
            // The next run is the server's to compute; until it answers the row says so.
            task.routine?.nextRunAt = nil
        }
        if let paused = patch.paused {
            task.routine?.paused = paused
            if paused { task.routine?.nextRunAt = nil }
        }
        return task
    }

    // MARK: - Loading

    /// A list request starts: the first one shows skeleton rows (phase), later ones `refreshing`.
    mutating func beginLoad() {
        loading = true
        touched = []
        if state.phase == .loaded {
            state.refreshing = true
        } else {
            state.phase = .loading
        }
    }

    /// GET /api/tasks answered for `scope` (nil = Everything): tasks of that scope it no longer
    /// lists are dropped (archived or gone) unless an event changed them meanwhile. M22: it lists
    /// unfinished tasks and those resolved in the last 7 days; `olderResolved` counts the rest.
    mutating func applyList(_ tasks: [TaskSummary], scope: String?, olderResolved: Int? = nil) {
        let listed = Set(tasks.map(\.id))
        for (id, task) in confirmed where Self.inScope(task, scope) && !listed.contains(id) && !touched.contains(id)
            && overrides[id] == nil && patches[id] == nil {
            confirmed[id] = nil
        }
        for task in tasks {
            // Seen first on an "Earlier" page or in a search: it belongs to the list now.
            if let known = outside.removeValue(forKey: task.id), confirmed[task.id] == nil { confirmed[task.id] = known }
            merge(task)
        }
        if let olderResolved, scope == state.scopeChannelId { state.olderResolved = olderResolved }
        endLoad()
        state.phase = .loaded
        rebuild()
    }

    /// The list request failed: the first load shows the reason inline with Retry; a refresh
    /// keeps the list on screen.
    mutating func failLoad(reason: String) {
        endLoad()
        if state.phase != .loaded { state.phase = .failed(reason: reason) }
    }

    /// The list request was cancelled by a newer one (or teardown).
    mutating func cancelLoad() {
        endLoad()
    }

    private mutating func endLoad() {
        loading = false
        touched = []
        state.refreshing = false
    }

    /// The scope (nil = Everything) changes; the caller reloads. M22: the "Earlier" pages and a
    /// search answer belonged to the old scope (a search still typed is asked again).
    mutating func setScope(_ channelId: String?) {
        if channelId != state.scopeChannelId {
            olderIds = []
            state.older = OlderTasksState()
            state.olderResolved = 0
            searchIds = []
            state.search.answered = nil
            state.search.phase = state.search.query.isEmpty ? .idle : .loading
            pruneOutside()
        }
        state.scopeChannelId = channelId
        rebuild()
    }

    mutating func setChannelNames(_ names: [String: String]) {
        guard names != state.channelNames else { return }
        state.channelNames = names
    }

    // MARK: - Live updates

    /// A `task` event, a created task, a task detail's summary: upsert by id (an older copy
    /// never wins); out-of-scope and archived tasks stay out of `state.tasks`.
    mutating func apply(_ task: TaskSummary) {
        if loading { touched.insert(task.id) }
        merge(task)
        rebuild()
    }

    private mutating func merge(_ task: TaskSummary) {
        guard !deleted.contains(task.id) else { return }
        // M22: a task known only from "Earlier" or a search stays there while it's resolved; once
        // it isn't (reopened, replied to) it joins the list.
        if confirmed[task.id] == nil, let known = outside[task.id] {
            guard known.updatedAt <= task.updatedAt else { return }
            if task.status == .resolved || task.archived {
                outside[task.id] = task
                return
            }
            outside[task.id] = nil
        }
        if let current = confirmed[task.id], current.updatedAt > task.updatedAt { return }
        confirmed[task.id] = task
    }

    /// M22: an "Earlier" page's or a search answer's task: into the list's copy when the list has
    /// it, else kept aside (never in `state.tasks`).
    private mutating func keepAside(_ task: TaskSummary) {
        guard !deleted.contains(task.id) else { return }
        if confirmed[task.id] != nil { return merge(task) }
        if let current = outside[task.id], current.updatedAt > task.updatedAt { return }
        outside[task.id] = task
    }

    /// M22: drops the tasks kept aside that no page or search answer shows any more.
    private mutating func pruneOutside() {
        let kept = Set(olderIds).union(searchIds)
        for id in Array(outside.keys) where !kept.contains(id) && overrides[id] == nil && patches[id] == nil {
            outside[id] = nil
        }
    }

    // MARK: - M22: Done's "Earlier" pages

    /// "Earlier" (or "Show more") tapped: false while a page is loading or none is left.
    mutating func beginOlder() -> Bool {
        guard state.older.phase != .loading, state.older.hasMore else { return false }
        state.older.phase = .loading
        return true
    }

    /// A page of older resolved tasks, newest first; `nextCursor` nil = the last one.
    mutating func applyOlder(_ page: TaskList) {
        let known = Set(olderIds)
        for task in page.tasks {
            keepAside(task)
            if !known.contains(task.id) { olderIds.append(task.id) }
        }
        state.older.cursor = page.nextCursor
        state.older.loaded = true
        state.older.phase = .idle
        rebuild()
    }

    mutating func failOlder(reason: String) {
        state.older.phase = .failed(reason: reason)
    }

    /// Cancelled (a newer scope, teardown): nothing changes but the spinner.
    mutating func cancelOlder() {
        if state.older.phase == .loading { state.older.phase = .idle }
    }

    // MARK: - M22: Server search

    /// The field's text changed (trimmed): an empty one ends the search.
    mutating func beginSearch(_ query: String) {
        state.search.query = query
        state.search.phase = query.isEmpty ? .idle : .loading
        if query.isEmpty {
            state.search.answered = nil
            searchIds = []
            pruneOutside()
            rebuild()
        }
    }

    /// GET /api/tasks?q= answered; an answer for an older query (the field moved on) is dropped.
    mutating func applySearch(_ tasks: [TaskSummary], query: String) {
        guard query == state.search.query, !query.isEmpty else { return }
        tasks.forEach { keepAside($0) }
        searchIds = tasks.map(\.id)
        state.search.answered = query
        state.search.phase = .loaded
        pruneOutside()
        rebuild()
    }

    mutating func failSearch(reason: String, query: String) {
        guard query == state.search.query else { return }
        state.search.phase = .failed(reason: reason)
    }

    // MARK: - M22: Needs you

    /// GET /api/needs-you answered: the badge's count and the cards outside any task.
    mutating func applyNeedsYou(_ needsYou: NeedsYou) {
        guard state.needsYou != needsYou else { return }
        state.needsYou = needsYou
    }

    /// M22: Save for Up next answered: the kept suggestion heads Up next at once.
    mutating func insertSuggestion(_ suggestion: Suggestion) {
        state.upNext.suggestions.removeAll { $0.id == suggestion.id }
        state.upNext.suggestions.insert(suggestion, at: 0)
        state.upNext.scanFoundNothing = false
        state.upNext.phase = .loaded
    }

    // MARK: - M9: Pin and routine changes

    /// Pin / Unpin at once; false when the task is unknown, deleted or already patching.
    mutating func beginPin(_ id: String, _ pinned: Bool) -> Bool {
        beginPatch(id, TaskPatch(pinned: pinned))
    }

    /// A routine's Pause / Resume, new time or title at once; false when the task isn't a
    /// routine or a change is already in flight.
    mutating func beginRoutineChange(_ id: String, paused: Bool? = nil, schedule: Schedule? = nil, title: String? = nil) -> Bool {
        guard task(id)?.routine != nil else { return false }
        return beginPatch(id, TaskPatch(paused: paused, schedule: schedule, title: title))
    }

    /// M10: Rename any task at once (the title already trimmed and checked); false when the task
    /// is unknown, deleted, already patching or already called that.
    mutating func beginRename(_ id: String, title: String) -> Bool {
        guard task(id)?.title != title else { return false }
        return beginPatch(id, TaskPatch(title: title))
    }

    private mutating func beginPatch(_ id: String, _ patch: TaskPatch) -> Bool {
        guard patches[id] == nil, stored(id) != nil, !deleted.contains(id) else { return false }
        patches[id] = patch
        rebuild()
        return true
    }

    /// The PATCH answered: the server's copy replaces the optimistic one (also when its
    /// updatedAt didn't move, as a pin doesn't change the task's content time); a newer event
    /// that already landed wins. M22: a task kept aside (Earlier, search) stays there.
    mutating func finishPatch(_ task: TaskSummary) {
        patches[task.id] = nil
        guard !deleted.contains(task.id) else { return rebuild() }
        merge(task)
        rebuild()
    }

    /// The PATCH failed: back to the server's copy.
    mutating func failPatch(_ id: String) {
        patches[id] = nil
        rebuild()
    }

    // MARK: - M9: Deletes

    /// DELETE answered or task_deleted: the task leaves every list for good. False when it was
    /// already gone.
    @discardableResult
    mutating func remove(_ id: String) -> Bool {
        let known = stored(id) != nil
        deleted.insert(id)
        confirmed[id] = nil
        overrides[id] = nil
        patches[id] = nil
        touched.remove(id)
        state.routineRuns[id] = nil
        // M22: out of the "Earlier" pages and the search answer too.
        outside[id] = nil
        olderIds.removeAll { $0 == id }
        searchIds.removeAll { $0 == id }
        reopenedFromOutside.remove(id)
        rebuild()
        return known
    }

    /// channel_deleted: the channel's tasks go with it. Returns their ids.
    @discardableResult
    mutating func removeChannel(_ channelId: String) -> [String] {
        let ids = (Array(confirmed.values) + Array(outside.values)).filter { $0.channelId == channelId }.map(\.id)
        ids.forEach { remove($0) }
        state.channelNames[channelId] = nil
        return ids
    }

    // MARK: - M9: Routine runs

    /// GET /api/tasks/:id/runs answered (newest first).
    mutating func applyRoutineRuns(_ runs: [RunRecord], taskId: String) {
        guard !deleted.contains(taskId) else { return }
        state.routineRuns[taskId] = ScheduleCopy.history(runs, limit: 30)
    }

    /// Run now accepted: the queued run heads the history until the next GET.
    mutating func noteRoutineRun(_ run: RunRecord, taskId: String) {
        guard !deleted.contains(taskId) else { return }
        var runs = state.routineRuns[taskId] ?? []
        runs.removeAll { $0.id == run.id }
        runs.insert(run, at: 0)
        state.routineRuns[taskId] = runs
    }

    /// Routines whose loaded history still has a queued or running run (refetched after `done`).
    var routinesWithOpenRuns: [String] {
        let open: Set<RunRecord.Status> = [.queued, .running]
        return state.routineRuns.filter { $0.value.contains { open.contains($0.status) } }.map(\.key).sorted()
    }

    /// Whether a run that just ended (`done`) may have been a routine's, so the list (next run,
    /// last status) is worth fetching again: an unpaused routine was due, or its history still
    /// shows a run in progress.
    func routineMayHaveRun(now: Date) -> Bool {
        let due = displayed.contains { task in
            guard let routine = task.routine, !routine.paused, !task.archived, let next = routine.nextRunAt else { return false }
            return next <= now
        }
        return due || !routinesWithOpenRuns.isEmpty
    }

    // MARK: - Mark complete / Archive

    /// Applies the change optimistically; false when the task is unknown or already updating.
    /// M22: a task resolved here counts as resolved `now` (Just done) until the server answers.
    mutating func beginUpdate(_ id: String, _ change: UpdateTaskRequest, now: Date = Date()) -> Bool {
        guard overrides[id] == nil, var task = stored(id) else { return false }
        if change.status == .resolved {
            task.status = .resolved
            task.resolvedAt = now
        }
        if let archived = change.archived { task.archived = archived }
        overrides[id] = task
        rebuild()
        return true
    }

    // MARK: - M22: Reopen

    /// A resolved row's check tapped again: back to needs input at once (POST /reopen answers
    /// through finishReopen / failReopen). False when it isn't resolved or an update is in flight.
    /// A task from "Earlier" or a search joins the list meanwhile.
    mutating func beginReopen(_ id: String) -> Bool {
        guard overrides[id] == nil, !deleted.contains(id), var task = stored(id), task.status == .resolved else { return false }
        if confirmed[id] == nil, let known = outside.removeValue(forKey: id) {
            confirmed[id] = known
            reopenedFromOutside.insert(id)
        }
        task.status = .needsInput
        task.resolvedAt = nil
        overrides[id] = task
        rebuild()
        return true
    }

    /// POST /reopen answered: the server's copy (needs input, nextStep reply).
    mutating func finishReopen(_ task: TaskSummary) {
        reopenedFromOutside.remove(task.id)
        if loading { touched.insert(task.id) }
        finishUpdate(task)
    }

    /// POST /reopen failed: the row goes back to resolved, and back to "Earlier" or the search
    /// answer when it came from there (unless an event moved it on meanwhile).
    mutating func failReopen(_ id: String) {
        overrides[id] = nil
        if reopenedFromOutside.remove(id) != nil, let task = confirmed[id], task.status == .resolved {
            confirmed[id] = nil
            outside[id] = task
        }
        rebuild()
    }

    /// The PATCH answered: the server's copy replaces the optimistic one.
    mutating func finishUpdate(_ task: TaskSummary) {
        overrides[task.id] = nil
        merge(task)
        rebuild()
    }

    /// The PATCH failed: back to the server's latest copy (including events that came meanwhile).
    mutating func failUpdate(_ id: String) {
        overrides[id] = nil
        rebuild()
    }

    // MARK: - Up next

    mutating func beginUpNext() {
        if state.upNext.phase != .loaded { state.upNext.phase = .loading }
    }

    /// M22: a scan that ends with Up next still empty leaves `scanFoundNothing` (until the next
    /// Show me or a suggestion); a running scan keeps its start (one already running at launch
    /// starts now).
    mutating func applyUpNext(_ upNext: UpNext, now: Date = .now) {
        let ended = state.upNext.scanning && !upNext.scanning
        state.upNext.suggestions = upNext.suggestions
        state.upNext.scanning = upNext.scanning
        if upNext.scanning {
            if state.upNext.scanStartedAt == nil { state.upNext.scanStartedAt = now }
        } else {
            state.upNext.scanStartedAt = nil
        }
        if !upNext.suggestions.isEmpty {
            state.upNext.scanFoundNothing = false
        } else if ended {
            state.upNext.scanFoundNothing = true
        }
        state.upNext.phase = .loaded
    }

    mutating func failUpNext(reason: String) {
        if state.upNext.phase != .loaded { state.upNext.phase = .failed(reason: reason) }
    }

    /// Takes a suggestion out of the list (Add succeeded, or Hide optimistically); returns it
    /// with its index so a failed Hide can put it back.
    mutating func removeSuggestion(_ id: String) -> (index: Int, suggestion: Suggestion)? {
        guard let index = state.upNext.suggestions.firstIndex(where: { $0.id == id }) else { return nil }
        return (index, state.upNext.suggestions.remove(at: index))
    }

    mutating func restoreSuggestion(_ suggestion: Suggestion, at index: Int) {
        guard !state.upNext.suggestions.contains(where: { $0.id == suggestion.id }) else { return }
        state.upNext.suggestions.insert(suggestion, at: min(index, state.upNext.suggestions.count))
    }

    /// "Show me" started (POST /api/up-next/scan accepted, or about to be sent).
    mutating func beginScan(now: Date = .now) {
        state.upNext.scanning = true
        state.upNext.scanStartedAt = now
        state.upNext.scanFoundNothing = false
    }

    /// The scan couldn't start.
    mutating func failScan() {
        state.upNext.scanning = false
        state.upNext.scanStartedAt = nil
    }

    // MARK: - Scheduled (M4, L118)

    mutating func beginSchedule() {
        if state.schedule.phase != .loaded { state.schedule.phase = .loading }
    }

    mutating func applySchedule(_ info: ScheduleInfo) {
        state.schedule.info = info
        state.schedule.phase = .loaded
    }

    mutating func failSchedule(reason: String) {
        if state.schedule.phase != .loaded { state.schedule.phase = .failed(reason: reason) }
    }

    /// Whether a run that just ended (`done`) may have been a scheduled one, so the Scheduled
    /// rows (next run, history) are worth fetching again: a run is due or still queued / running.
    func scheduleMayHaveRun(now: Date) -> Bool {
        // M9: with the built-ins off the brief / check-in times mean nothing.
        guard let info = state.schedule.info, info.builtins else { return false }
        if info.brief.nextRunAt <= now || info.checkin.nextRunAt <= now { return true }
        let open: Set<RunRecord.Status> = [.queued, .running]
        return (info.brief.history + info.checkin.history).contains { open.contains($0.status) }
    }

    // MARK: - Derived list

    private static func inScope(_ task: TaskSummary, _ scope: String?) -> Bool {
        scope == nil || task.channelId == scope
    }

    private mutating func rebuild() {
        let scope = state.scopeChannelId
        let visible = displayed.filter { !$0.archived && Self.inScope($0, scope) }
        // M9: pinned first (contract §4), then newest update first.
        state.tasks = visible.sorted { a, b in
            if a.pinned != b.pinned { return a.pinned }
            return (a.updatedAt, a.createdAt, a.id) > (b.updatedAt, b.createdAt, b.id)
        }
        state.updatedAt = state.tasks.map(\.updatedAt).max()
        // M22: the "Earlier" pages and the search answer as shown (live copies, in their order);
        // an "Earlier" task that's in the list again (reopened, or resolved anew) shows there only.
        let listed = Set(state.tasks.map(\.id))
        state.older.tasks = olderIds.compactMap { id in
            guard !listed.contains(id), let task = task(id), !task.archived, task.status == .resolved, Self.inScope(task, scope) else { return nil }
            return task
        }
        state.search.tasks = searchIds.compactMap { id in
            guard let task = task(id), !task.archived else { return nil }
            return task
        }
    }
}

// MARK: - M22: when the Tasks tab badge asks GET /api/needs-you again

/// The badge follows GET /api/needs-you, fetched again after the events that can change what
/// waits on the user: a task changing or going, an approval decided, a card (approval, form,
/// sign-in, connection, spend) posted, changed or deleted, a resync. A burst (a turn posting a
/// card and its task changing twice) is one fetch: it goes out once the events have been quiet
/// for `quiet`, at most `maxWait` after the first; one fetch at a time, and events during it ask
/// for one more after it. Pure (host-tested); ChatStore+Tasks runs the timer and the request.
struct NeedsYouRefetch: Hashable, Sendable {
    static let quiet: TimeInterval = 0.8
    static let maxWait: TimeInterval = 3

    /// The first event since the last fetch went out (nil = nothing waiting).
    private(set) var pendingSince: Date?
    private(set) var inFlight = false
    /// Events came while the request was out.
    private(set) var again = false

    /// Whether an event can change Needs you.
    static func isRelevant(_ body: DuetEvent.Body) -> Bool {
        switch body {
        case .task, .taskDeleted, .approval, .channelDeleted, .messageDeleted, .resync: return true
        case .message(let message): return isCard(message.content)
        default: return false
        }
    }

    /// The kinds of message that can wait on the user.
    static func isCard(_ content: MessageContent) -> Bool {
        switch content {
        case .approval, .form, .signIn, .connectionRequest, .spendRequest: true
        default: false
        }
    }

    /// A relevant event at `now`: when the fetch should go out (the timer is replaced; if a
    /// request is out when it fires, `begin` asks for one more after it).
    mutating func note(at now: Date) -> Date {
        let first = pendingSince ?? now
        pendingSince = first
        return min(now.addingTimeInterval(Self.quiet), first.addingTimeInterval(Self.maxWait))
    }

    /// The timer fired (or a refresh asks now): true = send the request; false = one is out
    /// already (it fetches once more when it ends).
    mutating func begin() -> Bool {
        pendingSince = nil
        if inFlight {
            again = true
            return false
        }
        inFlight = true
        again = false
        return true
    }

    /// The request ended: true = events came meanwhile, fetch once more now.
    mutating func end() -> Bool {
        inFlight = false
        defer { again = false }
        return again
    }
}
