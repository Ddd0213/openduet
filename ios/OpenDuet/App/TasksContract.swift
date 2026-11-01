// M3 additions to the data <-> UI seam (see ShellContract.swift): the Tasks tab, task detail and
// the approval / card request states. Owned by the main agent; change it only through a handoff
// request. The stores fill these from the server (GET /api/tasks, task and approval events); the
// UI only renders them and calls TaskActions / CardActions.
import Foundation

// MARK: - Tasks tab (L116-L120)

struct TasksState: Hashable, Sendable {
    enum Phase: Hashable, Sendable {
        /// first load: skeleton rows
        case loading
        case loaded
        /// first load failed: inline grey line with the reason + Retry
        case failed(reason: String)
    }
    var phase: Phase = .loading
    /// newest update first, as GET /api/tasks returns them; the UI groups them by status
    /// (Ready for review, Needs input, Working, Scheduled, Resolved) and filters by search text
    var tasks: [TaskSummary] = []
    /// nil = Everything; otherwise the channel the tab is scoped to (M4's side menu sets it)
    var scopeChannelId: String?
    /// channel names for the "outside the scope" tag line, by channel id
    var channelNames: [String: String] = [:]
    /// pull to refresh in progress (L185)
    var refreshing = false
    /// the newest updatedAt among the tasks ("Updated 1 min. ago" next to Ready for review)
    var updatedAt: Date?
    /// "Up next" segment (L119); M4 fills it from check-ins and scans
    var upNext = UpNextState()
    /// "Scheduled" group's Morning brief and Check-in rows (L118, M4: GET /api/schedule)
    var schedule = ScheduleState()
    /// M8: a checkbox tap waiting out its "Marked complete · Undo" toast; the row already shows
    /// resolved, and the PATCH goes out only when the toast expires. nil = no toast.
    var undo: CompletionUndo?
    /// M9: a routine's run history (GET /api/tasks/:id/runs), by task id; filled by
    /// TaskActions.loadRoutineRuns when its sheet opens, refreshed after Run now
    var routineRuns: [String: [RunRecord]] = [:]
    // M22 (W3)
    /// resolved tasks older than the 7-day window (GET /api/tasks olderResolved): Done's last row
    /// is "Earlier" while this is above 0
    var olderResolved = 0
    /// the "Earlier" pages loaded so far (GET /api/tasks?resolved=older&cursor=), newest first
    var older = OlderTasksState()
    /// the search field's server answer (GET /api/tasks?q=)
    var search = TaskSearchState()
    /// GET /api/needs-you (nil until it answered): its cards outside any task head Waiting on you
    var needsYou: NeedsYou?
}

/// M22: Done's "Earlier" pages: resolved tasks older than the 7-day window, newest first.
struct OlderTasksState: Hashable, Sendable {
    enum Phase: Hashable, Sendable { case idle, loading, failed(reason: String) }
    var tasks: [TaskSummary] = []
    /// the next page's cursor; nil with `loaded` = the last page came
    var cursor: String?
    /// at least one page came
    var loaded = false
    var phase: Phase = .idle

    /// "Earlier" (or "Show more") still has something to load.
    var hasMore: Bool { !loaded || cursor != nil }
}

/// M22: the search field's server answer. `query` is what was asked last (trimmed; "" = no
/// search); `answered` is the query `tasks` belongs to (nil before the first answer).
struct TaskSearchState: Hashable, Sendable {
    enum Phase: Hashable, Sendable { case idle, loading, loaded, failed(reason: String) }
    var query = ""
    var answered: String?
    var phase: Phase = .idle
    var tasks: [TaskSummary] = []

    /// The server's answer for what the field says now.
    func results(for query: String) -> [TaskSummary]? {
        answered == query && !query.isEmpty ? tasks : nil
    }
}

/// The checkbox's undo window (M8): which task, and the toast's identity (a new tap = a new id).
struct CompletionUndo: Hashable, Sendable {
    var taskId: String
    var id: UUID
}

struct UpNextState: Hashable, Sendable {
    var phase: TasksState.Phase = .loading
    var suggestions: [Suggestion] = []
    /// a scan is running ("Show me"); M4
    var scanning = false
    /// M22 (review-ux §14): when the running scan began (the "taking a while" line after 60 s)
    var scanStartedAt: Date?
    /// M22: the last scan ended with Up next still empty ("Nothing new right now.")
    var scanFoundNothing = false
}

// MARK: - Task detail (L121)

struct TaskDetailState: Hashable, Sendable {
    /// `gone`: the server answered 404 (the task was deleted, e.g. an old link in the chat).
    enum Phase: Hashable, Sendable { case loading, loaded, failed(reason: String), gone }
    var taskId: String
    var phase: Phase = .loading
    /// nil until loaded; updated live from `task` events and refetched on change
    var task: TaskDetail?
    /// the task's own session ("Reply to OpenDuet"); context is .task
    var thread = ThreadState(context: .task)
    var composer = ComposerState()
    /// live status of the task's run (pill under the centre capsule)
    var status: StatusKey?
}

// MARK: - Card requests (L182)

/// The in-flight / failed state of a tap on a card, by message id (approval cards, suggestion
/// Start/Hide, plate actions). Success is read from the card's own payload once the server's
/// message event arrives (e.g. approval.status == .approved and result.ok).
enum CardRequest: Hashable, Sendable {
    /// spinner inside the tapped button, both buttons disabled
    case inFlight
    /// inline reason with Retry (and Edit on approval cards)
    case failed(reason: String)
}

extension ShellState {
    /// Keys: a card's message id (approvals, suggestion Start / Hide, plate Done); a task id for
    /// Mark complete / Archive on a row; a suggestion id for Up next Add / hide; and
    /// `ShellState.createTaskRequest` for the + FAB sheet's Start.
    typealias CardRequests = [String: CardRequest]
}

// MARK: - Actions the UI calls

@MainActor
struct TaskActions {
    /// the Tasks tab appeared or the user pulled to refresh
    var refresh: () -> Void = {}
    /// ⋯ Mark complete and a failed row's Retry (only the user resolves a task): PATCH at once
    var markComplete: (_ taskId: String) -> Void = { _ in }
    /// M8: the row's checkbox. The row shows resolved at once with TasksState.undo set; the
    /// PATCH goes out when the toast expires (~4 s). `undoComplete` cancels it.
    var completeWithUndo: (_ taskId: String) -> Void = { _ in }
    var undoComplete: () -> Void = {}
    /// M8: the task detail composer's quote (swipe right on an assistant bubble in the task's thread)
    var setReplyTo: (_ quote: ReplyQuote?) -> Void = { _ in }
    var archive: (_ taskId: String) -> Void = { _ in }
    /// the + FAB sheet's Start (one text field); the new task opens in the list
    var create: (_ prompt: String) -> Void = { _ in }
    /// tap a row, a task_spawn chip or a duet://tasks/<id> link
    var open: (_ taskId: String) -> Void = { _ in }
    var close: () -> Void = {}
    /// "Reply to OpenDuet" in task detail (goes into the task's own session; M21: with the uploaded
    /// attachments of its composer, TaskDetailState.composer.attachments)
    var reply: (_ text: String, _ attachmentIds: [UUID]) -> Void = { _, _ in }
    /// M21: files picked in task detail's "Reply to OpenDuet" (uploaded to the task's channel;
    /// remove / retry go through ShellActions like the chat composer's)
    var addAttachments: (_ files: [PickedFile]) -> Void = { _ in }
    /// task detail scrolled near the top of its thread: load the page before the oldest message
    var loadOlder: () -> Void = {}
    /// Up next: Add (creates a task) and hide
    var addSuggestion: (_ suggestionId: String) -> Void = { _ in }
    var hideSuggestion: (_ suggestionId: String) -> Void = { _ in }
    /// M4: Up next's empty-state "Show me" (POST /api/up-next/scan; upNext.scanning while it
    /// runs, results arrive as events) and the Check-in sheet's "Run now"
    /// (cardRequests[ShellState.RequestKey.runNow(kind)])
    var scan: () -> Void = {}
    var runNow: (_ kind: RunNowRequest.Kind) -> Void = { _ in }
    // M9
    /// long-press Pin / Unpin (cardRequests[RequestKey.pinTask(id)]); optimistic, rolls back on failure
    var setPinned: (_ taskId: String, _ pinned: Bool) -> Void = { _, _ in }
    /// long-press / ⋯ Delete after the in-place confirmation (cardRequests[RequestKey.deleteTask(id)]);
    /// the row leaves on task_deleted, an open detail closes
    var delete: (_ taskId: String) -> Void = { _ in }
    /// a routine's sheet: history, Run now, Pause / Resume, a new time (cardRequests[RequestKey.routine(id)])
    var loadRoutineRuns: (_ taskId: String) -> Void = { _ in }
    var runRoutine: (_ taskId: String) -> Void = { _ in }
    var setRoutinePaused: (_ taskId: String, _ paused: Bool) -> Void = { _, _ in }
    var updateRoutine: (_ taskId: String, _ schedule: Schedule?, _ title: String?) -> Void = { _, _, _ in }
    // M22 (W3)
    /// a failed row's "Try again" (POST /api/tasks/:id/retry; cardRequests[RequestKey.retryTask(id)])
    var retry: (_ taskId: String) -> Void = { _ in }
    /// a resolved row's check tapped again (POST /api/tasks/:id/reopen; RequestKey.reopenTask(id));
    /// inside the checkbox's undo window it is the toast's Undo
    var reopen: (_ taskId: String) -> Void = { _ in }
    /// the + sheet's "Save for Up next" (POST /api/up-next; cardRequests[RequestKey.saveForLater]);
    /// the suggestion shows in Up next at once
    var saveForLater: (_ prompt: String) -> Void = { _ in }
    /// Done's "Earlier": the next page of older resolved tasks (TasksState.older)
    var loadOlderResolved: () -> Void = {}
    /// the search field's text (debounced by the store, the previous request cancelled; "" ends
    /// the search); the answer is TasksState.search
    var search: (_ query: String) -> Void = { _ in }
    /// a Needs you card row (duet://channels/<id>?message=<id>), as ShellActions.openRoute
    var openRoute: (_ url: URL) -> Void = { _ in }
}

extension ShellState.RequestKey {
    /// M22: a failed row's Try again, a resolved row's Reopen, the + sheet's Save for Up next
    static func retryTask(_ taskId: String) -> String { "task:retry:\(taskId)" }
    static func reopenTask(_ taskId: String) -> String { "task:reopen:\(taskId)" }
    static let saveForLater = "task:save-for-later"
    /// M22: a show_tasks card row's duet://suggestions/<id> (start it, then open the task)
    static func startSuggestion(_ suggestionId: String) -> String { "suggestion:start:\(suggestionId)" }
}

// M10: Rename any task (contract §3: PATCH title, trimmed, 1-200 characters). It goes through
// the existing title path, `updateRoutine(id, nil, title)`: the store sends a routine's title as
// before and, for any other task, a plain title PATCH (ChatStore.renameTask; in flight under
// cardRequests[RequestKey.renameTask(id)], the row rolls back with the reason on failure). No new
// seam is needed in ChatStore+Actions.
extension TaskActions {
    func rename(_ taskId: String, _ title: String) {
        updateRoutine(taskId, nil, title)
    }
}

extension ShellState.RequestKey {
    /// M10: Rename on a task row (the rename sheet shows the spinner and the reason)
    static func renameTask(_ taskId: String) -> String { "task:rename:\(taskId)" }
}

@MainActor
struct CardActions {
    /// Approve / Send / Pay carries the version the card shows; a stale version (409) reloads the
    /// card to the latest one, which then glows its changedFields.
    var approve: (_ messageId: String, _ approvalId: String, _ version: Int) -> Void = { _, _, _ in }
    /// M20: Approve and remember "Always" for the card's `always` scope (one recipient, or one
    /// site and kind of browser click); only offered when Approval.always is set
    var approveAlways: (_ messageId: String, _ approvalId: String, _ version: Int) -> Void = { _, _, _ in }
    var decline: (_ messageId: String, _ approvalId: String, _ version: Int) -> Void = { _, _, _ in }
    /// POST /api/messages/:id/action: suggestion Start / Hide, plate item Done
    var action: (_ messageId: String, _ action: MessageActionRequest.Action, _ itemId: String?) -> Void = { _, _, _ in }
    /// chips that send text as the user (plate "Draft" / "Book", "↪ Shorten", "Ask again")
    var sendText: (_ text: String) -> Void = { _ in }
    /// alert cards: open_connector (OpenDuet sheet / connector detail, M4) and open_url
    var openAlert: (_ action: AlertPayload.Action) -> Void = { _ in }
    /// M9: a form card's Submit (cardRequests[messageId]). `summary` is the readable
    /// "label: answer" lines the user's bubble shows; it goes out as SendMessageRequest.text with
    /// .form in the thread the card is in (main / channel / task) and jumps to the bottom.
    var submitForm: (_ messageId: String, _ answers: [FormAnswer], _ summary: String) -> Void = { _, _, _ in }
    /// M9: a form card's "Skip" (POST /api/messages/:id/action dismiss)
    var dismissForm: (_ messageId: String) -> Void = { _ in }
    /// M12: a model_error card's Retry (modelId nil) or Switch model (the picked ModelEntry.id):
    /// POST /api/messages/:id/action retry; cardRequests[messageId] while it runs
    var retry: (_ messageId: String, _ modelId: String?) -> Void = { _, _ in }
}
