// One task's detail (L121): GET /api/tasks/:id plus its own session (a task-scoped
// ThreadReducer: only this task's messages, status and typing). A `task` event for it updates
// the summary at once and asks for a refetch of the full detail (steps, updates, resources).
// M8: the composer's quote chip, and the typing dots while the task is `working` (also after
// reopening it, not only from live `typing` events) until an assistant message streams in.
// Foundation + model types only, so it runs in the Mac host tests.
import Foundation

struct TaskSession: Sendable {
    let taskId: String
    var phase: TaskDetailState.Phase = .loading
    private(set) var task: TaskDetail?
    var reducer: ThreadReducer
    /// M8: the "Reply to OpenDuet" composer's quote (swipe right on an assistant bubble here).
    var replyTo: ReplyQuote?
    /// M8: an assistant message with text arrived while the task works: the dots step aside for it
    /// (live `typing` events still bring them back). Reset when the task leaves `working`.
    private var assistantSpoke = false
    /// M10: ■ was tapped here. The working dots stay hidden until the task leaves `working` (the
    /// stopped turn's `task` event) or a newer turn starts typing; a failed stop clears it.
    private(set) var stopRequested = false
    /// M10: why the last stop didn't go through (shown by the composer); nil = nothing to say.
    var stopFailure: String?
    /// M21 (review C19): files picked in "Reply to OpenDuet" (uploaded to the task's channel; the
    /// next reply takes the uploaded ones).
    var attachments: [ComposerAttachment] = []

    init(taskId: String) {
        self.taskId = taskId
        self.reducer = ThreadReducer(taskId: taskId)
    }

    var state: TaskDetailState {
        var state = TaskDetailState(taskId: taskId)
        state.phase = phase
        state.task = task
        state.thread = reducer.thread
        state.thread.typing = reducer.thread.typing || workingDots
        state.status = reducer.status
        state.composer.replyTo = replyTo
        state.composer.replying = isReplying
        state.composer.stopFailure = stopFailure
        state.composer.attachments = attachments
        return state
    }

    /// The task works but no live event says so (reopened mid-run): the three dots still show.
    var workingDots: Bool {
        task?.summary.status == .working && !assistantSpoke && !stopRequested
    }

    /// M10: the assistant is replying in this task's session: ■ instead of the empty waveform.
    var isReplying: Bool { reducer.isReplying || workingDots }

    /// M10: ■ in "Reply to OpenDuet": the live runs and the working dots hide at once. Returns the
    /// runs hidden, for `resumeStop`.
    @discardableResult
    mutating func beginStop() -> Set<String> {
        stopFailure = nil
        stopRequested = true
        return reducer.beginStop()
    }

    /// The stop failed (not a 409): the reply shows as running again, with the reason.
    mutating func resumeStop(_ runIds: Set<String>, failure: String) {
        stopRequested = false
        reducer.resumeStop(runIds)
        stopFailure = failure
    }

    /// Something is still waiting to go out ("Reply to OpenDuet" typed offline, or a failed reply
    /// the user may retry): the session outlives a close so the reply isn't lost.
    var hasPending: Bool { !reducer.thread.pending.isEmpty }

    /// Applies one event to this task's session; true when it was a new `task` event for this
    /// task, so the full detail should be fetched again.
    mutating func apply(_ event: DuetEvent) -> Bool {
        let spoke = Self.assistantText(event, taskId: taskId)
        let wasTyping = reducer.thread.typing
        guard reducer.apply(event) else { return false }
        if spoke { assistantSpoke = true }
        // M10: a newer turn (queued behind the stopped one) started typing: it shows as usual.
        if stopRequested, !wasTyping, reducer.thread.typing { stopRequested = false }
        guard case .task(let summary) = event.body, summary.id == taskId else { return false }
        if var current = task, summary.updatedAt >= current.summary.updatedAt {
            current.summary = summary
            task = current
            noteStatus(summary.status)
        }
        return true
    }

    /// GET /api/tasks/:id (or a PATCH / POST answer) arrived; an older copy never replaces a newer one.
    mutating func applyDetail(_ detail: TaskDetail) {
        guard detail.id == taskId else { return }
        if let current = task, current.summary.updatedAt > detail.summary.updatedAt { return }
        task = detail
        phase = .loaded
        noteStatus(detail.summary.status)
    }

    /// M9: a PATCH answered with the summary only (pin, routine changes): the loaded detail takes
    /// it unless it already shows a newer copy.
    mutating func applySummary(_ summary: TaskSummary) {
        guard summary.id == taskId, var current = task, summary.updatedAt >= current.summary.updatedAt else { return }
        current.summary = summary
        task = current
        noteStatus(summary.status)
    }

    mutating func failDetail(reason: String) {
        if phase != .loaded && phase != .gone { phase = .failed(reason: reason) }
    }

    /// 404 not_found on a task route: the task no longer exists.
    static func isGone(_ error: any Error) -> Bool {
        (error as? APIError) == .notFound
    }

    /// M14: 404 on the detail or its session: the task was deleted. The header says so (no
    /// Retry), the thread stays empty and nothing can be sent here. Final for this session.
    mutating func markGone() {
        phase = .gone
        task = nil
        replyTo = nil
        attachments = []
        reducer.thread.phase = .loaded
    }

    /// Leaving `working` ends the dots for this stretch; the next one starts fresh.
    private mutating func noteStatus(_ status: TaskStatus) {
        if status != .working {
            assistantSpoke = false
            stopRequested = false
        }
    }

    /// A `message` event of this task with the assistant's text (an empty, just-started reply doesn't count).
    private static func assistantText(_ event: DuetEvent, taskId: String) -> Bool {
        guard case .message(let message) = event.body, message.taskId == taskId, message.role == .assistant else { return false }
        return !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
