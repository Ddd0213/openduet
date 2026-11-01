// The Tasks tab (L116-L120): GET /api/tasks for the current scope together with GET /api/up-next
// (at launch for the badge, when the tab appears, on pull to refresh), Mark complete / Archive
// (optimistic PATCH, rolled back with the reason on failure), the + FAB sheet's Start and Up
// next's Add / hide. Live changes arrive as `task` events through route().
import Foundation

/// M22: cardTasks keys of the Tasks tab's own requests (not taps: nothing in cardRequests).
private let tasksOlderKey = "tasks:older"
private let tasksSearchKey = "tasks:search"
private let needsYouWaitKey = "tasks:needs-you:wait"
private let needsYouFetchKey = "tasks:needs-you"
/// M23: the composer's Up next suggestion: the quiet wait after events, and its GET /api/up-next.
private let upNextWaitKey = "tasks:up-next:wait"
private let upNextFetchKey = "tasks:up-next"
/// M22: the search field waits this long after the last keystroke before asking the server.
private let tasksSearchDebounce: Duration = .milliseconds(300)

extension ChatStore {
    /// TaskActions.refresh: the first load shows skeleton rows (phase .loading); a reload of a
    /// loaded list sets `refreshing` until both answers are in. M19: Up next is written only when
    /// it changes (every observed write re-renders the shell).
    func refreshTasks() {
        guard !tornDown else { return }
        tasksLoadTask?.cancel()
        board.list.beginLoad()
        if board.list.state.upNext.phase != .loaded && board.list.state.upNext.phase != .loading {
            board.list.beginUpNext()
        }
        // M4: the Scheduled rows come with every Tasks refresh.
        refreshSchedule()
        // M22: the badge (GET /api/needs-you) and a search that is open (asked again at once).
        refreshNeedsYou()
        if !board.list.state.search.query.isEmpty { searchTasks(board.list.state.search.query, immediately: true) }
        let scope = board.list.state.scopeChannelId
        tasksLoadTask = Task { [client] in
            async let tasks = Self.result { try await client.tasks(channelId: scope) }
            async let upNext = Self.result { try await client.upNext() }
            let (taskResult, upNextResult) = await (tasks, upNext)
            guard !Task.isCancelled, !tornDown else {
                if !tornDown { board.list.cancelLoad() }
                return
            }
            switch taskResult {
            case .success(let list):
                board.list.applyList(list.tasks, scope: scope, olderResolved: list.olderResolved)
                markOnline()
            case .failure(let error):
                noteFailure(error)
                board.list.failLoad(reason: TaskBoard.reason(for: error))
            }
            switch upNextResult {
            case .success(let upNext):
                let shown = board.list.state.upNext
                if shown.phase != .loaded || shown.suggestions != upNext.suggestions || shown.scanning != upNext.scanning {
                    board.list.applyUpNext(upNext)
                }
                // A scan already running (the first-day scan, another device's "Show me").
                if upNext.scanning { pollScan() }
            case .failure(let error):
                if board.list.state.upNext.phase != .loaded { board.list.failUpNext(reason: TaskBoard.reason(for: error)) }
            }
        }
    }

    /// Back online: lists that failed to load try again.
    func retryFailedTaskLoads() {
        if case .failed = board.list.state.phase { refreshTasks() }
        if let session = board.openSession, case .failed = session.phase { loadTaskSession(session.taskId) }
    }

    // MARK: - Mark complete / Archive

    func markTaskComplete(_ taskId: String) {
        commitCompletion()
        updateTask(taskId, UpdateTaskRequest(status: .resolved, archived: nil))
    }

    func archiveTask(_ taskId: String) {
        commitCompletion()
        updateTask(taskId, UpdateTaskRequest(status: nil, archived: true))
    }

    // MARK: - Checkbox with undo (M8)

    /// The row's checkbox: resolved on screen at once with the undo toast; the PATCH is sent
    /// only when the toast expires (TaskBoard.completionUndoSeconds). A second tap meanwhile
    /// sends the first one right away.
    func completeWithUndo(_ taskId: String) {
        guard !tornDown else { return }
        commitCompletion()
        guard let undo = board.beginCompletion(taskId) else { return }
        completionUndoTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(TaskBoard.completionUndoSeconds))
            guard !Task.isCancelled, let self, self.board.completionUndo?.id == undo.id else { return }
            self.commitCompletion()
        }
    }

    /// The toast's Undo: the row goes back and nothing is sent.
    func undoTaskCompletion() {
        completionUndoTask?.cancel()
        completionUndoTask = nil
        board.undoCompletion()
    }

    /// Ends the undo window now: its PATCH goes out (answered like ⋯ Mark complete).
    func commitCompletion() {
        completionUndoTask?.cancel()
        completionUndoTask = nil
        guard !tornDown, let taskId = board.commitCompletion() else { return }
        let change = UpdateTaskRequest(status: .resolved, archived: nil)
        runTap(taskId, { [client] in try await client.updateTask(id: taskId, change) }) { store, result in
            store.board.answerTaskUpdate(taskId, result)
        }
    }

    /// The row changes at once and shows `.inFlight` in cardRequests[taskId]; a failure puts it
    /// back and leaves `.failed(reason:)` there until the next try.
    private func updateTask(_ taskId: String, _ change: UpdateTaskRequest) {
        guard !tornDown, board.beginTaskUpdate(taskId, change) else { return }
        runTap(taskId, { [client] in try await client.updateTask(id: taskId, change) }) { store, result in
            store.board.answerTaskUpdate(taskId, result)
        }
    }

    // MARK: - Create

    /// The + FAB sheet's Start: POST /api/tasks in the current scope (the main channel for
    /// Everything); the new task goes into the list. State in cardRequests[ShellState.createTaskRequest].
    func createTask(prompt: String) {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = ShellState.createTaskRequest
        guard !tornDown, !text.isEmpty, board.beginRequest(key) else { return }
        let request = CreateTaskRequest(prompt: text, channelId: board.list.state.scopeChannelId ?? reducer.channelId)
        runTap(key, { [client] in try await client.createTask(request) }) { store, result in
            switch result {
            case .success(let detail):
                store.board.clearRequest(key)
                store.board.list.apply(detail.summary)
            case .failure(let error):
                if error is CancellationError { store.board.clearRequest(key) } else { store.board.failRequest(key, error) }
            }
        }
    }

    // MARK: - Up next

    /// Add: `.inFlight` on cardRequests[suggestionId]; success removes the suggestion and puts the
    /// new task in the list; failure leaves the reason.
    func addSuggestion(_ suggestionId: String) {
        guard !tornDown, board.beginRequest(suggestionId) else { return }
        runTap(suggestionId, { [client] in try await client.addSuggestion(id: suggestionId) }) { store, result in
            switch result {
            case .success(let task):
                store.board.clearRequest(suggestionId)
                _ = store.board.list.removeSuggestion(suggestionId)
                store.board.list.apply(task)
            case .failure(let error):
                if error is CancellationError { store.board.clearRequest(suggestionId) } else { store.board.failRequest(suggestionId, error) }
            }
        }
    }

    /// Hide: the suggestion leaves at once (in flight meanwhile); a failure puts it back with the reason.
    func hideSuggestion(_ suggestionId: String) {
        guard !tornDown, board.cardRequests[suggestionId] != .inFlight,
              let removed = board.list.removeSuggestion(suggestionId) else { return }
        _ = board.beginRequest(suggestionId)
        runTap(suggestionId, { [client] in try await client.hideSuggestion(id: suggestionId) }) { store, result in
            store.board.clearRequest(suggestionId)
            if case .failure(let error) = result {
                store.board.list.restoreSuggestion(removed.suggestion, at: removed.index)
                if !(error is CancellationError) { store.board.failRequest(suggestionId, error) }
            }
        }
    }

    // MARK: - M22: Try again, Reopen, Save for Up next

    /// A failed row's "Try again": POST /api/tasks/:id/retry; the task runs again.
    func retryTask(_ taskId: String) {
        guard !tornDown, board.beginRetry(taskId) else { return }
        runTap(ShellState.RequestKey.retryTask(taskId), { [client] in try await client.retryTask(id: taskId) }) { store, result in
            store.board.answerRetry(taskId, result)
        }
    }

    /// A resolved row's check tapped again. Inside the checkbox's undo window (nothing sent yet)
    /// it is the toast's Undo; otherwise POST /api/tasks/:id/reopen with the row back at once.
    func reopenTask(_ taskId: String) {
        guard !tornDown else { return }
        if board.completionUndo?.taskId == taskId { return undoTaskCompletion() }
        commitCompletion()
        guard board.beginReopen(taskId) else { return }
        runTap(ShellState.RequestKey.reopenTask(taskId), { [client] in try await client.reopenTask(id: taskId) }) { store, result in
            store.board.answerReopen(taskId, result)
        }
    }

    /// The + sheet's "Save for Up next": POST /api/up-next in the current scope (the main channel
    /// for Everything); the suggestion heads Up next at once. State in RequestKey.saveForLater.
    func saveForLater(prompt: String) {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = ShellState.RequestKey.saveForLater
        guard !tornDown, !text.isEmpty, board.beginRequest(key) else { return }
        let request = CreateTaskRequest(prompt: text, channelId: board.list.state.scopeChannelId ?? reducer.channelId)
        runTap(key, { [client] in try await client.saveForLater(request) }) { store, result in
            switch result {
            case .success(let suggestion):
                store.board.clearRequest(key)
                store.board.list.insertSuggestion(suggestion)
            case .failure(let error):
                if error is CancellationError { store.board.clearRequest(key) } else { store.board.failRequest(key, error) }
            }
        }
    }

    /// A show_tasks card row's duet://suggestions/<id>: POST /api/up-next/:id/add, then the new
    /// task opens; a failure leaves a grey line under the row (RequestKey.startSuggestion). A row
    /// already started opens its task.
    func startSuggestionRoute(_ suggestionId: String) {
        guard !tornDown else { return }
        if let taskId = board.startedSuggestions[suggestionId] { return openTask(taskId) }
        let key = ShellState.RequestKey.startSuggestion(suggestionId)
        guard board.beginRequest(key) else { return }
        runTap(key, { [client] in try await client.addSuggestion(id: suggestionId) }) { store, result in
            switch result {
            case .success(let task):
                store.board.suggestionStarted(suggestionId, task: task)
                store.openTask(task.id)
            case .failure(let error as APIError) where error == .notFound:
                store.board.failRequest(key, reason: String(localized: "This suggestion isn't there any more."))
            case .failure(let error):
                if error is CancellationError { store.board.clearRequest(key) } else { store.board.failRequest(key, error) }
            }
        }
    }

    // MARK: - M22: Done's "Earlier" and the server search

    /// "Earlier" / "Show more": the next page of resolved tasks older than the 7-day window.
    func loadOlderResolved() {
        guard !tornDown, board.list.beginOlder() else { return }
        let scope = board.list.state.scopeChannelId
        let cursor = board.list.state.older.cursor
        runTap(tasksOlderKey, { [client] in try await client.olderResolvedTasks(channelId: scope, cursor: cursor) }) { store, result in
            // The scope changed meanwhile: that page belongs to the old one.
            guard store.board.list.state.scopeChannelId == scope else { return store.board.list.cancelOlder() }
            switch result {
            case .success(let page): store.board.list.applyOlder(page)
            case .failure(let error) where error is CancellationError: store.board.list.cancelOlder()
            case .failure(let error): store.board.list.failOlder(reason: TaskBoard.reason(for: error))
            }
        }
    }

    /// The search field's text: GET /api/tasks?q= ~300 ms after the last keystroke (the request
    /// before it is cancelled), so tasks of any age are found; "" ends the search at once.
    func searchTasks(_ query: String, immediately: Bool = false) {
        guard !tornDown else { return }
        let text = TaskGrouping.normalized(query)
        let shown = board.list.state.search
        if text.isEmpty && shown.query.isEmpty && shown.phase == .idle { return }
        if !immediately, text == shown.query, shown.phase != .idle, !Self.failed(shown.phase) { return }
        cardTasks[tasksSearchKey]?.task.cancel()
        board.list.beginSearch(text)
        guard !text.isEmpty else { return }
        let scope = board.list.state.scopeChannelId
        runTap(tasksSearchKey, { [client] in
            if !immediately { try await Task.sleep(for: tasksSearchDebounce) }
            return try await client.searchTasks(text, channelId: scope)
        }) { store, result in
            guard store.board.list.state.scopeChannelId == scope else { return }
            switch result {
            case .success(let tasks): store.board.list.applySearch(tasks, query: text)
            case .failure(let error) where error is CancellationError: break
            case .failure(let error): store.board.list.failSearch(reason: TaskBoard.reason(for: error), query: text)
            }
        }
    }

    private static func failed(_ phase: TaskSearchState.Phase) -> Bool {
        if case .failed = phase { true } else { false }
    }

    // MARK: - M22: the Needs you badge

    /// Every routed event: one that can change what waits on the user (NeedsYouRefetch.isRelevant)
    /// fetches GET /api/needs-you again once the burst is over.
    func noteNeedsYouEvent(_ body: DuetEvent.Body) {
        // M23: the composer's Up next suggestion follows the same events (route() calls this one).
        noteUpNextEvent(body)
        guard !tornDown, NeedsYouRefetch.isRelevant(body) else { return }
        let fire = board.needsYouRefetch.note(at: Date())
        cardTasks[needsYouWaitKey]?.task.cancel()
        let token = UUID()
        let wait = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, fire.timeIntervalSinceNow)))
            guard !Task.isCancelled, let self, !self.tornDown else { return }
            if self.cardTasks[needsYouWaitKey]?.token == token { self.cardTasks[needsYouWaitKey] = nil }
            self.fetchNeedsYou()
        }
        cardTasks[needsYouWaitKey] = (token, wait)
    }

    /// Launch, every Tasks refresh and the app coming to the foreground: at once.
    func refreshNeedsYou() {
        guard !tornDown else { return }
        cardTasks[needsYouWaitKey]?.task.cancel()
        cardTasks[needsYouWaitKey] = nil
        fetchNeedsYou()
    }

    private func fetchNeedsYou() {
        guard !tornDown, board.needsYouRefetch.begin() else { return }
        runTap(needsYouFetchKey, { [client] in try await client.needsYou() }) { store, result in
            if case .success(let needsYou) = result {
                store.board.list.applyNeedsYou(needsYou)
                // M29: the app icon badge shows the same number as the Tasks tab.
                store.onWaitingOnYou?(store.board.list.needingUser)
            }
            // A failure keeps the last count; the next event or foreground asks again.
            if store.board.needsYouRefetch.end() { store.fetchNeedsYou() }
        }
    }

    // MARK: - M23: the Up next suggestion above the composer

    /// A card answered elsewhere (its Start / Hide here, in Tasks or on another device) takes its
    /// Up next row away at once; a new suggestion card, an unknown task, a run's end or a delete
    /// asks GET /api/up-next again once things are quiet (UpNextRefresh). Start / Hide on the
    /// composer's card are Up next's own addSuggestion / hideSuggestion.
    func noteUpNextEvent(_ body: DuetEvent.Body) {
        guard !tornDown else { return }
        let shown = board.list.state.upNext.suggestions
        for id in UpNextRefresh.answeredIds(body) where shown.contains(where: { $0.id == id }) {
            _ = board.list.removeSuggestion(id)
        }
        let tasks = board.list.state.tasks
        guard UpNextRefresh.isRelevant(body, knowsTask: { id in tasks.contains { $0.id == id } }) else { return }
        cardTasks[upNextWaitKey]?.task.cancel()
        let token = UUID()
        let wait = Task { [weak self] in
            try? await Task.sleep(for: UpNextRefresh.quiet)
            guard !Task.isCancelled, let self, !self.tornDown else { return }
            if self.cardTasks[upNextWaitKey]?.token == token { self.cardTasks[upNextWaitKey] = nil }
            self.refetchUpNextQuietly()
        }
        cardTasks[upNextWaitKey] = (token, wait)
    }

    /// GET /api/up-next, written only when it changed (every observed write re-renders the shell).
    /// A row whose Start or Hide is still in flight here stays out until that answer lands.
    private func refetchUpNextQuietly() {
        cardTasks[upNextFetchKey]?.task.cancel()
        runTap(upNextFetchKey, { [client] in try await client.upNext() }) { store, result in
            guard case .success(var upNext) = result else { return }
            let shown = store.board.list.state.upNext
            let shownIds = Set(shown.suggestions.map(\.id))
            upNext.suggestions.removeAll { store.board.cardRequests[$0.id] == .inFlight && !shownIds.contains($0.id) }
            if shown.phase != .loaded || shown.suggestions != upNext.suggestions || shown.scanning != upNext.scanning {
                store.board.list.applyUpNext(upNext)
            }
            if upNext.scanning { store.pollScan() }
        }
    }

    // MARK: - Helpers

    /// Runs a request and captures its outcome (for concurrent requests and pure answer handlers).
    nonisolated static func result<T: Sendable>(_ body: @Sendable () async throws -> T) async -> Result<T, any Error> {
        do {
            return .success(try await body())
        } catch {
            return .failure(error)
        }
    }
}
