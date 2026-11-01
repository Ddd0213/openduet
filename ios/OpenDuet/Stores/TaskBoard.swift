// Everything M3 adds next to the main thread, as one value: the Tasks tab (TasksReducer), the
// task sessions (the open task detail, plus closed ones that still hold unsent replies) and
// the card requests (L182). It routes each event of the single GET /api/events stream (and of
// the POST answers) to the main thread, the list and the sessions, and turns the answers of
// card taps into card state. ChatStore does the I/O; this stays Foundation + models, so the
// Mac host tests drive it directly.
import Foundation

/// The thread a message, a pending reply or a card belongs to.
enum ThreadRef: Hashable, Sendable {
    /// the chat thread on screen (Everything or the selected channel)
    case main
    case task(String)
    /// a channel's thread by id: the one on screen, or one the side menu parked while its unsent
    /// messages still go out (M4, ParkedThreads)
    case channel(String)
}

/// What the store does after a card tap's answer.
enum CardFollowUp: Hashable, Sendable {
    case nothing
    /// fetch the newest page of this thread again and merge it (409 stale version, 410 expired)
    case reload(ThreadRef)
}

extension ShellState {
    /// cardRequests key of the + FAB sheet's Start (POST /api/tasks): the sheet shows the spinner
    /// while `.inFlight` and the reason with Retry on `.failed`; the entry disappears on success.
    static let createTaskRequest = "task:create"
}

struct TaskBoard: Sendable {
    var list = TasksReducer()
    /// Task sessions by task id: the open one, plus closed ones with replies still to send.
    private(set) var sessions: [String: TaskSession] = [:]
    private(set) var openTaskId: String?
    /// In-flight / failed taps by id: card message ids, task ids (Mark complete / Archive),
    /// suggestion ids (Up next Add / Hide) and ShellState.createTaskRequest.
    private(set) var cardRequests: ShellState.CardRequests = [:]
    /// M22: when the Tasks tab badge fetches GET /api/needs-you again (ChatStore+Tasks).
    var needsYouRefetch = NeedsYouRefetch()
    /// M22: suggestions started from a card row (duet://suggestions/<id>) -> their task.
    private(set) var startedSuggestions: [String: String] = [:]

    var openSession: TaskSession? { openTaskId.flatMap { sessions[$0] } }

    // MARK: - Events

    /// Applies one event everywhere it belongs. Returns true when the open task's detail should
    /// be fetched again (a new `task` event for it); each reducer dedups by event id on its own.
    @discardableResult
    mutating func route(_ event: DuetEvent, main: inout ThreadReducer) -> Bool {
        main.apply(event)
        if case .task(let summary) = event.body { list.apply(summary) }
        var refetch = false
        for id in Array(sessions.keys) {
            let changed = sessions[id]!.apply(event)
            if changed && id == openTaskId { refetch = true }
        }
        return refetch
    }

    // MARK: - Task detail

    /// Opens (or reopens) a task's detail; a session kept for its unsent replies is reused.
    mutating func open(_ taskId: String) {
        if let current = openTaskId, current != taskId { close() }
        openTaskId = taskId
        if sessions[taskId] == nil { sessions[taskId] = TaskSession(taskId: taskId) }
    }

    mutating func close() {
        openTaskId = nil
        prune()
    }

    /// Drops closed sessions with nothing left to send.
    mutating func prune() {
        for (id, session) in sessions where id != openTaskId && !session.hasPending {
            sessions[id] = nil
        }
    }

    /// Changes one session in place (no copy of its thread).
    mutating func updateSession(_ taskId: String, _ body: (inout TaskSession) -> Void) {
        guard sessions[taskId] != nil else { return }
        body(&sessions[taskId]!)
    }

    /// GET /api/tasks/:id (or a PATCH / POST answer): into its session and the list.
    mutating func detailLoaded(_ detail: TaskDetail) {
        updateSession(detail.id) { $0.applyDetail(detail) }
        list.apply(detail.summary)
    }

    /// Where a message is shown: the main thread, else the open task, else any kept session.
    func thread(containing messageId: String, main: ThreadReducer) -> ThreadRef? {
        if main.contains(messageId: messageId) { return .main }
        if let open = openSession, open.reducer.contains(messageId: messageId) { return .task(open.taskId) }
        return sessions.first { $0.value.reducer.contains(messageId: messageId) }.map { .task($0.key) }
    }

    /// Which thread holds a pending message.
    func thread(pending clientId: String, main: ThreadReducer) -> ThreadRef? {
        if main.isPending(clientId) { return .main }
        return sessions.first { $0.value.reducer.isPending(clientId) }.map { .task($0.key) }
    }

    // MARK: - Card requests

    /// Marks a tap in flight; false when one is already running for this id.
    mutating func beginRequest(_ id: String) -> Bool {
        guard cardRequests[id] != .inFlight else { return false }
        cardRequests[id] = .inFlight
        return true
    }

    mutating func clearRequest(_ id: String) {
        cardRequests[id] = nil
    }

    mutating func failRequest(_ id: String, _ error: any Error) {
        cardRequests[id] = .failed(reason: Self.reason(for: error))
    }

    /// M11: a failure with a reason of the caller's own (a connection card's 400 shows the server's words).
    mutating func failRequest(_ id: String, reason: String) {
        cardRequests[id] = .failed(reason: reason)
    }

    /// The answer of Approve / Not now for the card `messageId`. Success writes the approval into
    /// the card (main thread and task sessions); 409 stale version and 410 expired clear the
    /// request and ask for the card's thread to be fetched again (410 also shows Expired at
    /// once); anything else leaves the inline reason with Retry.
    mutating func answerApproval(messageId: String, approvalId: String, _ result: Result<Approval, any Error>, main: inout ThreadReducer) -> CardFollowUp {
        switch result {
        case .success(let approval):
            cardRequests[messageId] = nil
            applyApproval(approval, main: &main)
            return .nothing
        case .failure(let error) where error is CancellationError:
            cardRequests[messageId] = nil
            return .nothing
        case .failure(let error as APIError) where error == .staleVersion || error == .expired:
            cardRequests[messageId] = nil
            let where_ = thread(containing: messageId, main: main) ?? .main
            if error == .expired { markExpired(approvalId, main: &main) }
            return .reload(where_)
        case .failure(let error):
            failRequest(messageId, error)
            return .nothing
        }
    }

    /// The answer of a card action (POST /api/messages/:id/action): the updated card is upserted
    /// in the thread that owns it.
    mutating func answerAction(messageId: String, _ result: Result<Message, any Error>, main: inout ThreadReducer) {
        switch result {
        case .success(let message):
            cardRequests[messageId] = nil
            accept(message, main: &main)
        case .failure(let error) where error is CancellationError:
            cardRequests[messageId] = nil
        case .failure(let error):
            failRequest(messageId, error)
        }
    }

    /// An approval (decision answer) written into every thread that shows its card.
    mutating func applyApproval(_ approval: Approval, main: inout ThreadReducer) {
        main.applyApproval(approval)
        for id in Array(sessions.keys) { sessions[id]!.reducer.applyApproval(approval) }
    }

    /// A message from outside the event streams (a card action's answer), upserted where it belongs.
    mutating func accept(_ message: Message, main: inout ThreadReducer) {
        main.accept(message)
        for id in Array(sessions.keys) { sessions[id]!.reducer.accept(message) }
    }

    private mutating func markExpired(_ approvalId: String, main: inout ThreadReducer) {
        main.markExpired(approvalId: approvalId)
        for id in Array(sessions.keys) { sessions[id]!.reducer.markExpired(approvalId: approvalId) }
    }

    // MARK: - Checkbox with undo (M8)

    /// The checkbox's "Marked complete · Undo" window: the row is resolved on screen, the PATCH
    /// waits for the window to end.
    private(set) var completionUndo: CompletionUndo?
    /// How long "Marked complete · Undo" stays before the PATCH goes out (M8 brief: ~4 s).
    static let completionUndoSeconds: Double = 4

    /// A checkbox tap: resolved at once (the optimistic copy), no request yet. Nil when the task
    /// is unknown, already updating or already resolved; the caller commits an earlier window first.
    mutating func beginCompletion(_ taskId: String) -> CompletionUndo? {
        guard completionUndo == nil, cardRequests[taskId] != .inFlight, list.task(taskId)?.status != .resolved,
              list.beginUpdate(taskId, UpdateTaskRequest(status: .resolved, archived: nil)) else { return nil }
        // A failure from an earlier try goes away with the new tap.
        cardRequests[taskId] = nil
        let undo = CompletionUndo(taskId: taskId, id: UUID())
        completionUndo = undo
        return undo
    }

    /// Undo: the row goes back to the server's copy and nothing is sent.
    mutating func undoCompletion() {
        guard let undo = completionUndo else { return }
        completionUndo = nil
        list.failUpdate(undo.taskId)
    }

    /// The window ended (or another tap replaced it): the PATCH goes out now, in flight like
    /// ⋯ Mark complete, and answers through answerTaskUpdate. Returns the task to PATCH.
    mutating func commitCompletion() -> String? {
        guard let undo = completionUndo else { return nil }
        completionUndo = nil
        cardRequests[undo.taskId] = .inFlight
        return undo.taskId
    }

    // MARK: - Mark complete / Archive

    /// Optimistic Mark complete / Archive; false when the task is unknown or already updating.
    mutating func beginTaskUpdate(_ taskId: String, _ change: UpdateTaskRequest) -> Bool {
        guard cardRequests[taskId] != .inFlight, list.beginUpdate(taskId, change) else { return false }
        cardRequests[taskId] = .inFlight
        return true
    }

    /// The PATCH answer: success keeps the change (the server's copy), failure rolls the row
    /// back and leaves the reason under it.
    mutating func answerTaskUpdate(_ taskId: String, _ result: Result<TaskDetail, any Error>) {
        switch result {
        case .success(let detail):
            cardRequests[taskId] = nil
            list.finishUpdate(detail.summary)
            updateSession(taskId) { $0.applyDetail(detail) }
        case .failure(let error):
            list.failUpdate(taskId)
            if error is CancellationError { cardRequests[taskId] = nil } else { failRequest(taskId, error) }
        }
    }

    // MARK: - Reasons

    /// The inline reason under a failed card or row (APIError's localized line).
    static func reason(for error: any Error) -> String {
        (error as? APIError)?.localizedReason ?? String(localized: "Something went wrong.")
    }
}

// MARK: - M9: pins, routines, deletes, form cards

/// A PATCH /api/tasks/:id answer: the TaskDetail docs/API.md describes, or `{ task }` (the M9
/// contract comment); APIClient.patchTask accepts both.
struct TaskPatchAnswer: Hashable, Sendable {
    var summary: TaskSummary
    var detail: TaskDetail?

    init(detail: TaskDetail) {
        self.summary = detail.summary
        self.detail = detail
    }

    init(summary: TaskSummary) {
        self.summary = summary
        self.detail = nil
    }
}

/// `{ "task": TaskSummary }`
struct TaskEnvelope: Decodable, Sendable {
    var task: TaskSummary
}

extension TaskBoard {
    /// The open detail as shown: an in-flight pin / routine change shows there too.
    var openDetailState: TaskDetailState? {
        guard var state = openSession?.state else { return nil }
        if list.isPatching(state.taskId), let shown = list.task(state.taskId), var task = state.task {
            task.summary.pinned = shown.pinned
            task.summary.title = shown.title
            task.summary.schedule = shown.schedule
            task.summary.routine = shown.routine
            state.task = task
        }
        return state
    }

    /// Long-press / ⋯ Pin or Unpin: at once, in flight under RequestKey.pinTask(id).
    mutating func beginPin(_ taskId: String, _ pinned: Bool) -> Bool {
        let key = ShellState.RequestKey.pinTask(taskId)
        guard cardRequests[key] != .inFlight, list.beginPin(taskId, pinned) else { return false }
        cardRequests[key] = .inFlight
        return true
    }

    /// M10: Rename (any task that isn't a routine; the title trimmed and checked): at once, in
    /// flight under RequestKey.renameTask(id); answered by `answerPatch`.
    mutating func beginRename(_ taskId: String, title: String) -> Bool {
        let key = ShellState.RequestKey.renameTask(taskId)
        guard cardRequests[key] != .inFlight, list.beginRename(taskId, title: title) else { return false }
        cardRequests[key] = .inFlight
        return true
    }

    /// A routine's Pause / Resume / time / title: at once, in flight under RequestKey.routine(id).
    mutating func beginRoutineChange(_ taskId: String, paused: Bool? = nil, schedule: Schedule? = nil, title: String? = nil) -> Bool {
        let key = ShellState.RequestKey.routine(taskId)
        guard cardRequests[key] != .inFlight,
              list.beginRoutineChange(taskId, paused: paused, schedule: schedule, title: title) else { return false }
        cardRequests[key] = .inFlight
        return true
    }

    /// A pin / routine PATCH answered under `key`: success keeps the server's copy, failure rolls
    /// the row back and leaves the reason.
    mutating func answerPatch(_ taskId: String, key: String, _ result: Result<TaskPatchAnswer, any Error>) {
        switch result {
        case .success(let answer):
            cardRequests[key] = nil
            list.finishPatch(answer.summary)
            updateSession(taskId) { session in
                if let detail = answer.detail { session.applyDetail(detail) } else { session.applySummary(answer.summary) }
            }
        case .failure(let error):
            list.failPatch(taskId)
            if error is CancellationError { cardRequests[key] = nil } else { failRequest(key, error) }
        }
    }

    /// Delete after the in-place confirmation, in flight under RequestKey.deleteTask(id).
    mutating func beginDelete(_ taskId: String) -> Bool {
        let key = ShellState.RequestKey.deleteTask(taskId)
        guard cardRequests[key] != .inFlight, !list.wasDeleted(taskId) else { return false }
        cardRequests[key] = .inFlight
        return true
    }

    /// DELETE answered. Success (or 404: already gone) removes the task like task_deleted;
    /// returns true when that closed the open detail.
    mutating func answerDelete(_ taskId: String, _ result: Result<Void, any Error>) -> Bool {
        let key = ShellState.RequestKey.deleteTask(taskId)
        switch result {
        case .success:
            cardRequests[key] = nil
            return removeTask(taskId)
        case .failure(let error as APIError) where error == .notFound:
            cardRequests[key] = nil
            return removeTask(taskId)
        case .failure(let error):
            if error is CancellationError { cardRequests[key] = nil } else { failRequest(key, error) }
            return false
        }
    }

    /// task_deleted (or a DELETE answer): the row, its session, its requests and a pending
    /// checkbox undo go. Returns true when its detail was open (it closes; the shell says why).
    @discardableResult
    mutating func removeTask(_ taskId: String) -> Bool {
        list.remove(taskId)
        if completionUndo?.taskId == taskId { completionUndo = nil }
        for key in [taskId, ShellState.RequestKey.pinTask(taskId), ShellState.RequestKey.routine(taskId),
                    ShellState.RequestKey.routineRuns(taskId), ShellState.RequestKey.renameTask(taskId)] {
            cardRequests[key] = nil
        }
        let wasOpen = openTaskId == taskId
        if wasOpen { openTaskId = nil }
        // Its unsent replies have nowhere to go any more.
        sessions[taskId] = nil
        return wasOpen
    }

    /// channel_deleted: every task of the channel goes (the list's and any session of it).
    /// Returns true when the open detail was one of them.
    @discardableResult
    mutating func removeChannel(_ channelId: String) -> Bool {
        var ids = Set(list.removeChannel(channelId))
        for (id, session) in sessions where session.task?.summary.channelId == channelId { ids.insert(id) }
        var closed = false
        for id in ids where removeTask(id) { closed = true }
        return closed
    }

    // MARK: Routine sheet

    /// GET /api/tasks/:id/runs starts (RequestKey.routineRuns(id)); false while one runs.
    mutating func beginRoutineRuns(_ taskId: String) -> Bool {
        let key = ShellState.RequestKey.routineRuns(taskId)
        guard cardRequests[key] != .inFlight, !list.wasDeleted(taskId) else { return false }
        cardRequests[key] = .inFlight
        return true
    }

    mutating func answerRoutineRuns(_ taskId: String, _ result: Result<[RunRecord], any Error>) {
        let key = ShellState.RequestKey.routineRuns(taskId)
        switch result {
        case .success(let runs):
            cardRequests[key] = nil
            list.applyRoutineRuns(runs, taskId: taskId)
        case .failure(let error):
            if error is CancellationError { cardRequests[key] = nil } else { failRequest(key, error) }
        }
    }

    /// Run now (RequestKey.routine(id), shared with Pause / Resume and time changes).
    mutating func beginRoutineRun(_ taskId: String) -> Bool {
        let key = ShellState.RequestKey.routine(taskId)
        guard cardRequests[key] != .inFlight, list.task(taskId)?.routine != nil else { return false }
        cardRequests[key] = .inFlight
        return true
    }

    /// Run now answered: the queued run heads the history; 409 (one is already running) says so.
    mutating func answerRoutineRun(_ taskId: String, _ result: Result<RunRecord, any Error>) {
        let key = ShellState.RequestKey.routine(taskId)
        switch result {
        case .success(let run):
            cardRequests[key] = nil
            list.noteRoutineRun(run, taskId: taskId)
        case .failure(let error as APIError) where error.isConflict:
            cardRequests[key] = .failed(reason: String(localized: "It's already running."))
        case .failure(let error):
            if error is CancellationError { cardRequests[key] = nil } else { failRequest(key, error) }
        }
    }

    // MARK: Form cards

    /// Submit / Skip on a form card: in flight under its message id.
    mutating func beginForm(_ messageId: String) -> Bool {
        beginRequest(messageId)
    }

    /// The form request ended: success clears it, a reason stays for the card's red line.
    mutating func endForm(_ messageId: String, failure: String?) {
        cardRequests[messageId] = failure.map { .failed(reason: $0) }
    }
}

// MARK: - M22: Try again, Reopen, suggestion links

extension TaskBoard {
    /// A failed row's "Try again" (only while its failure is retryable): in flight under
    /// RequestKey.retryTask(id). The row stays as it is until the server answers.
    mutating func beginRetry(_ taskId: String) -> Bool {
        let key = ShellState.RequestKey.retryTask(taskId)
        guard cardRequests[key] != .inFlight, list.task(taskId)?.failure?.retryable == true else { return false }
        cardRequests[key] = .inFlight
        return true
    }

    /// POST /retry answered: the task runs again (working, failure cleared); a 409 says why.
    mutating func answerRetry(_ taskId: String, _ result: Result<TaskDetail, any Error>) {
        let key = ShellState.RequestKey.retryTask(taskId)
        switch result {
        case .success(let detail):
            cardRequests[key] = nil
            detailLoaded(detail)
        case .failure(APIError.server(status: 409, code: "task_running")):
            cardRequests[key] = .failed(reason: String(localized: "It's already running."))
        case .failure(APIError.server(status: 409, code: "not_retryable")):
            cardRequests[key] = .failed(reason: String(localized: "Running it again won't help. Open the task to see why."))
        case .failure(let error):
            if error is CancellationError { cardRequests[key] = nil } else { failRequest(key, error) }
        }
    }

    /// A resolved row's check tapped again: needs input at once, in flight under
    /// RequestKey.reopenTask(id). False while the row is busy.
    mutating func beginReopen(_ taskId: String) -> Bool {
        let key = ShellState.RequestKey.reopenTask(taskId)
        guard cardRequests[key] != .inFlight, cardRequests[taskId] != .inFlight, completionUndo?.taskId != taskId,
              list.beginReopen(taskId) else { return false }
        cardRequests[key] = .inFlight
        return true
    }

    /// POST /reopen answered: the server's copy; a failure puts the row back with the reason.
    mutating func answerReopen(_ taskId: String, _ result: Result<TaskDetail, any Error>) {
        let key = ShellState.RequestKey.reopenTask(taskId)
        switch result {
        case .success(let detail):
            cardRequests[key] = nil
            list.finishReopen(detail.summary)
            updateSession(taskId) { $0.applyDetail(detail) }
        case .failure(let error):
            list.failReopen(taskId)
            if error is CancellationError { cardRequests[key] = nil } else { failRequest(key, error) }
        }
    }

    /// A duet://suggestions/<id> row started (POST /api/up-next/:id/add answered): the new task
    /// joins the list and the suggestion leaves Up next. `startedSuggestions` lets a second tap
    /// on the same card row open the task instead of starting it again.
    mutating func suggestionStarted(_ suggestionId: String, task: TaskSummary) {
        cardRequests[ShellState.RequestKey.startSuggestion(suggestionId)] = nil
        startedSuggestions[suggestionId] = task.id
        _ = list.removeSuggestion(suggestionId)
        list.apply(task)
    }
}
