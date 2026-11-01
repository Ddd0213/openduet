// The signed-in shell's store: the main thread (M2) plus the Tasks tab, the task detail and the
// card requests (M3, held in a TaskBoard). It loads me, the channels and the newest messages,
// applies the live events of the single GET /api/events stream and of each send's own stream
// (route), queues messages while offline, uploads attachments, and publishes the ShellState
// the UI renders. Loading is in ChatStore+Load, sending in +Send, attachments in
// +Attachments, the Tasks tab in +Tasks, task detail in +TaskDetail, card taps in +Cards and
// the UI's action closures in +Actions.
import Foundation
import Observation
import OSLog

@MainActor
@Observable
final class ChatStore {
    var reducer: ThreadReducer
    /// M3: the Tasks tab, task sessions and card requests.
    var board = TaskBoard()
    var composer = ComposerState()
    var connection: ConnectionState
    private(set) var user: CurrentUser
    /// M4: the side menu (channels, selection, unread badge).
    var menu: ChannelMenu
    /// M4: the OpenDuet sheet, connectors, OAuth, profile, usage and their taps.
    var account = AccountBoard()
    /// M4: the tab on screen (as the UI reports it) and the last switch the store asked for.
    var tab: ShellTab = .chat
    var tabRequest: ShellTabRequest?
    /// M4: channel threads left with unsent messages (not rendered, so not observed).
    @ObservationIgnored var parked = ParkedThreads()
    /// M6: the assistant's computer and files (ChatStore+Computer), the Make tab and chat extras
    /// (ChatStore+Make). Boards are rendered; runtimes hold tasks, sockets and live frames.
    var computerBoard = ComputerBoard()
    var makeBoard = MakeBoard()
    @ObservationIgnored let computerRuntime = ComputerRuntime()
    @ObservationIgnored let makeRuntime = MakeRuntime()
    /// M8: run records (ChatStore+Runs), rendered through the environment's RunsContext.
    var runsBoard = RunsBoard()
    @ObservationIgnored var runListTasks: [RunScope: Task<Void, Never>] = [:]
    @ObservationIgnored var runPollTasks: [String: Task<Void, Never>] = [:]
    /// M8: the checkbox's undo window; the PATCH goes out when it ends (ChatStore+Tasks).
    @ObservationIgnored var completionUndoTask: Task<Void, Never>?
    /// The latest usage (GET /api/usage or a `usage` event).
    var usage: UsageState? { account.usageScreen.usage ?? reducer.usage }

    /// Everything the shell renders.
    var state: ShellState {
        var state = ShellState()
        state.userName = user.name
        // M12: the composer's "No model set up yet" follows Me.features.models.
        state.modelsConfigured = user.features.models
        state.status = reducer.status
        state.connection = connection
        state.unreadChannels = menu.unreadChannels
        state.tasksNeedingUser = board.list.needingUser
        state.thread = reducer.thread
        state.thread.context = menu.context
        // M21: a deep link's message, in the thread it names.
        state.thread.focus = routeFocus?.thread(channelId: reducer.channelId)
        // M16: the thread view takes a new identity per channel (fresh scroll state, at the bottom).
        state.threadChannelId = reducer.channelId
        state.composer = composer
        // M10: ■ while the assistant replies here; a failed stop's reason only in the thread it was for.
        state.composer.replying = reducer.isReplying
        state.composer.stopFailure = stopFailure.flatMap { $0.channelId == reducer.channelId ? $0.reason : nil }
        state.tasks = board.list.state
        state.tasks.undo = board.completionUndo
        // M9: an in-flight pin / routine change shows in the detail too.
        state.taskDetail = board.openDetailState
        if let taskId = state.taskDetail?.taskId { state.taskDetail?.thread.focus = routeFocus?.thread(taskId: taskId) }
        state.cardRequests = board.cardRequests.merging(account.requests) { _, m4 in m4 }
        state.menu = menu.state
        state.assistant = account.assistant
        state.connectorDetail = account.connectorDetail
        state.oauth = account.oauth
        state.profile = account.profile
        state.usageScreen = account.usageScreen
        state.usageScreen.usage = usage
        state.presented = account.presented
        state.tab = tab
        state.tabRequest = tabRequest
        state.computer = computerBoard.view
        state.computer.mode = user.features.computerMode
        state.computer.idleMinutes = user.features.computerIdleMinutes
        state.files = computerBoard.files
        state.make = makeBoard.state
        state.chatExtras = makeBoard.extras
        state.notice = notice
        return state
    }

    /// For the notification rules: the chat thread's channel and the open task.
    var threadChannelId: String { reducer.channelId }
    var openTaskId: String? { board.openTaskId }
    /// GET /api/events is connected (a remote push then duplicates a local notification).
    var isStreamLive: Bool { stream?.isConnected == true }

    /// SessionStore keeps its user and the offline cache in step with GET /api/me.
    @ObservationIgnored var onUserRefreshed: ((CurrentUser, Data) -> Void)?

    @ObservationIgnored let client: APIClient
    @ObservationIgnored let cursor: EventCursor
    @ObservationIgnored var stream: EventStream?
    @ObservationIgnored var tornDown = false
    @ObservationIgnored var loadTask: Task<Void, Never>?
    @ObservationIgnored var olderTask: Task<Void, Never>?
    @ObservationIgnored var readTask: Task<Void, Never>?
    @ObservationIgnored var lastMarkedRead: Date?
    @ObservationIgnored var pumpTask: Task<Void, Never>?
    @ObservationIgnored var sendTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored var quickReplies: [String: SendMessageRequest.QuickReply] = [:]
    @ObservationIgnored var uploadSources: [UUID: PickedFile] = [:]
    @ObservationIgnored var uploadQueue: [UUID] = []
    @ObservationIgnored var uploadTask: (id: UUID, task: Task<Void, Never>)?
    /// M21: attachments picked in a task's "Reply to OpenDuet", by attachment id -> task id (the
    /// others belong to the chat composer).
    @ObservationIgnored var attachmentTaskIds: [UUID: String] = [:]
    // M3
    @ObservationIgnored var tasksLoadTask: Task<Void, Never>?
    @ObservationIgnored var detailLoadTask: Task<Void, Never>?
    @ObservationIgnored var detailRefetchTask: Task<Void, Never>?
    @ObservationIgnored var detailOlderTask: Task<Void, Never>?
    /// Card / row taps in flight by request id (ChatStore+Cards.runTap).
    @ObservationIgnored var cardTasks: [String: (token: UUID, task: Task<Void, Never>)] = [:]
    // M4
    @ObservationIgnored var menuTask: Task<Void, Never>?
    @ObservationIgnored var archivedTask: Task<Void, Never>?
    @ObservationIgnored var connectorsTask: Task<Void, Never>?
    @ObservationIgnored var searchTask: Task<Void, Never>?
    @ObservationIgnored var connectorDetailTask: Task<Void, Never>?
    @ObservationIgnored var profileTask: Task<Void, Never>?
    @ObservationIgnored var memoryTask: Task<Void, Never>?
    @ObservationIgnored var usageTask: Task<Void, Never>?
    @ObservationIgnored var scheduleTask: Task<Void, Never>?
    @ObservationIgnored var upNextTask: Task<Void, Never>?
    @ObservationIgnored var runDoneTask: Task<Void, Never>?
    @ObservationIgnored var scanPollTask: Task<Void, Never>?
    /// A read receipt is waiting for its debounce (flushed at once when the chat switches threads).
    @ObservationIgnored var readPending = false
    // M9
    /// The Usage panel's GET /api/usage/stats per range (ChatStore+M9).
    @ObservationIgnored var usageStatsTasks: [UsageRange: Task<Void, Never>] = [:]
    /// Form cards submitted and not yet echoed, by the pending message's clientId.
    @ObservationIgnored var formSubmits = FormSubmits()
    /// The floating "Task deleted" / "Channel deleted" line, and the timer that clears it.
    var notice: ShellNotice?
    @ObservationIgnored var noticeTask: Task<Void, Never>?
    /// `notification` events, handed to NotificationsCoordinator by SessionStore.
    @ObservationIgnored var onNotification: ((DuetEvent, DuetEvent.Notification) -> Void)?
    /// M21: approval events, for NotificationsCoordinator (a decided one's notification goes).
    @ObservationIgnored var onApproval: ((Approval) -> Void)?
    /// M29: the Tasks tab badge after each GET /api/needs-you answer, for the app icon badge.
    @ObservationIgnored var onWaitingOnYou: ((Int) -> Void)?
    /// M21: the message a channel / task link named (?message=), until its thread scrolled to it
    /// (ChatStore+TaskDetail, Routes).
    var routeFocus: RouteFocus?
    // M10 (ChatStore+Stop)
    /// The chat thread's last failed stop (shown by its composer for a moment).
    var stopFailure: ThreadStopFailure?
    /// Stop requests in flight and the timers that clear a failure's line, by "ch:<id>" / "task:<id>".
    @ObservationIgnored var stopTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored var stopFailureTasks: [String: Task<Void, Never>] = [:]
    // M13 (ChatStore+Calls)
    /// SSE `call` cues, for the app's CallSession (it's not thread state).
    @ObservationIgnored var onCallCue: ((CallCue) -> Void)?
    /// The app is in the foreground; a call holds GET /api/events open in the background too.
    @ObservationIgnored var foregroundActive = false
    @ObservationIgnored var callHoldsStream = false

    static let log = Logger(subsystem: "dev.openduet.OpenDuet", category: "chat")

    init(client: APIClient, user: CurrentUser, cursor: EventCursor, offline: Bool) {
        self.client = client
        self.user = user
        self.cursor = cursor
        self.connection = offline ? .offline : .online
        self.reducer = ThreadReducer(channelId: user.mainChannelId)
        self.menu = ChannelMenu(mainChannelId: user.mainChannelId)
        account.setUser(user)
    }

    // MARK: - Lifecycle

    func start() {
        stream = EventStream(client: client, cursor: cursor) { [weak self] signal in
            self?.handle(signal)
        }
        loadThread()
        // The Tasks tab badge counts from launch, before the tab is opened.
        refreshTasks()
    }

    /// Foreground keeps GET /api/events open; background closes it (L184). M13: a voice call
    /// keeps it open in the background too (its cues come through it; ChatStore+Calls).
    func setActive(_ active: Bool) {
        guard !tornDown else { return }
        foregroundActive = active
        if active || callHoldsStream { stream?.start() } else { stream?.stop() }
        // M22: back in the foreground, the badge asks GET /api/needs-you again.
        if active { refreshNeedsYou() }
    }

    /// Sign-out or a new session: stop everything this store started.
    func teardown() {
        tornDown = true
        stream?.stop()
        stream = nil
        for task in [loadTask, olderTask, readTask, pumpTask, tasksLoadTask, detailLoadTask, detailRefetchTask, detailOlderTask] {
            task?.cancel()
        }
        for task in [menuTask, archivedTask, connectorsTask, searchTask, connectorDetailTask, profileTask, memoryTask,
                     usageTask, scheduleTask, upNextTask, runDoneTask, scanPollTask] {
            task?.cancel()
        }
        onNotification = nil
        onApproval = nil
        onWaitingOnYou = nil
        sendTasks.values.forEach { $0.cancel() }
        sendTasks = [:]
        cardTasks.values.forEach { $0.task.cancel() }
        cardTasks = [:]
        uploadTask?.task.cancel()
        uploadTask = nil
        uploadQueue = []
        teardownComputer()
        teardownMake()
        teardownRuns()
        completionUndoTask?.cancel()
        completionUndoTask = nil
        // M9
        usageStatsTasks.values.forEach { $0.cancel() }
        usageStatsTasks = [:]
        formSubmits.removeAll()
        noticeTask?.cancel()
        noticeTask = nil
        // M10
        stopTasks.values.forEach { $0.cancel() }
        stopFailureTasks.values.forEach { $0.cancel() }
        stopTasks = [:]
        stopFailureTasks = [:]
        // M13
        onCallCue = nil
        callHoldsStream = false
        // M16: no channel's messages stay in memory past the session (parked and cached threads).
        parked.removeAll()
    }

    func refreshUser(_ user: CurrentUser, json: Data) {
        self.user = user
        account.setUser(user)
        onUserRefreshed?(user, json)
    }

    // MARK: - Events

    private func handle(_ signal: EventStream.Signal) {
        switch signal {
        case .live:
            markOnline()
            schedulePump(after: StreamTiming.replayGrace)
        case .event(let event):
            route(event)
        case .lost:
            markOffline()
        }
    }

    /// One event from either stream: the main thread, the Tasks tab, the task sessions and the
    /// approval cards all take it from here (one GET /api/events for everything).
    func route(_ event: DuetEvent) {
        // M29: the header mascot reacts to what just happened live (a task done, a new card).
        var previousTask: TaskSummary?
        if case .task(let task) = event.body { previousTask = board.list.task(task.id) }
        if board.route(event, main: &reducer) { scheduleDetailRefetch() }
        MascotCues.shared.note(event, previousTask: previousTask)
        // M22: the Tasks tab badge (GET /api/needs-you) follows, debounced (ChatStore+Tasks).
        noteNeedsYouEvent(event.body)
        parked.apply(event)
        routeComputer(event)
        routeMake(event)
        switch event.body {
        case .channel(let channel):
            syncChannelNames()
            if let selection = menu.apply(channel) { applySelection(selection) }
            // M21: the assistant posted in the thread the user is looking at: it's read already.
            readOnScreenChannel(channel)
        case .resync:
            resync()
        case .usage(let usage):
            account.usageEvent(usage)
        case .done:
            noteRunDone()
            // M9: tokens moved; the Usage panel's cached ranges load again when next shown.
            account.usageStatsStale()
        case .notification(let notification):
            onNotification?(event, notification)
        case .approval(let approval):
            onApproval?(approval)
        // M9 (contract §4): DELETE /api/tasks/:id and /api/channels/:id, from any device.
        case .taskDeleted(let taskId):
            taskDeleted(taskId)
        case .channelDeleted(let channelId):
            channelDeleted(channelId)
        // M13: what the voice should say goes to the call (the session checks the call's id).
        case .call(let cue):
            onCallCue?(cue)
        default:
            break
        }
    }

    /// M21 `resync`: the stream skipped what it would have had to replay (the reducers already
    /// forgot their runs). Everything on screen loads again: the channels, the open thread (its
    /// activeRun brings back a turn still running), the tasks, the open task and, when it was
    /// loaded, the Make gallery; approvals are cards in those threads. The stream itself goes on
    /// (EventStream took the envelope's id as its cursor).
    func resync() {
        guard !tornDown else { return }
        refreshMenu()
        if case .loaded = reducer.thread.phase { loadThreadPage() } else { loadThread() }
        refreshTasks()
        if let taskId = board.openTaskId { loadTaskSession(taskId) }
        // An edit's or refresh's end may have been skipped: its next event says it again.
        makeBoard.state.forgetWork()
        if makeBoard.state.phase == .loaded { refreshMake() }
    }

    /// Channel names for the Tasks tab's "outside the scope" tag line.
    func syncChannelNames() {
        board.list.setChannelNames(reducer.channels.mapValues(\.name))
    }

    // MARK: - Connection

    func markOnline() {
        guard connection != .online else { return }
        connection = .online
        if case .failed = reducer.thread.phase { loadThread() }
        retryFailedTaskLoads()
    }

    func markOffline() {
        connection = .offline
    }

    /// A request failed: connectivity marks the app offline and has the stream retry.
    func noteFailure(_ error: any Error) {
        guard let api = error as? APIError else { return }
        if api.isConnectivity {
            markOffline()
            stream?.reconnect()
        }
    }
}
