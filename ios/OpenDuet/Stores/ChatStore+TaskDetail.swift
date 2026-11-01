// Task detail (L121): open loads GET /api/tasks/:id and the first page of the task's own
// session; `task` events for the open task refetch the detail (bursts coalesce into one
// request); status / typing of its runs drive the detail through its task-scoped reducer.
// Replies go through the send pipeline (ChatStore+Send, target .task).
import Foundation

extension ChatStore {
    /// TaskActions.open (a row, a task_spawn chip, a duet://tasks/<id> link). Opening the task
    /// that is already open reloads it (the detail's Retry).
    func openTask(_ taskId: String) {
        guard !tornDown, !taskId.isEmpty else { return }
        if board.openTaskId != taskId { cancelDetailWork() }
        // M21: a link's focus on another task is left behind.
        if case .task(let id)? = routeFocus?.target, id != taskId { routeFocus = nil }
        // M21: the reply's attachments belong to the task they were picked in.
        if let open = board.openTaskId, open != taskId { discardTaskAttachments(open) }
        board.open(taskId)
        loadTaskSession(taskId)
    }

    /// TaskActions.close: the detail goes away; a session with unsent replies is kept until they
    /// go out. M21: files picked in its reply and not sent are dropped (and deleted on the server).
    func closeTask() {
        cancelDetailWork()
        if case .task? = routeFocus?.target { routeFocus = nil }
        if let open = board.openTaskId { discardTaskAttachments(open) }
        board.close()
    }

    private func cancelDetailWork() {
        for task in [detailLoadTask, detailRefetchTask, detailOlderTask] { task?.cancel() }
        detailLoadTask = nil
        detailRefetchTask = nil
        detailOlderTask = nil
    }

    /// GET /api/tasks/:id and the session's newest page, side by side.
    func loadTaskSession(_ taskId: String) {
        detailLoadTask?.cancel()
        board.updateSession(taskId) { session in
            if session.phase != .loaded { session.phase = .loading }
            if session.reducer.thread.phase != .loaded { session.reducer.thread.phase = .loading }
        }
        detailLoadTask = Task { [client] in
            async let detail = Self.result { try await client.task(id: taskId) }
            async let page = Self.result { try await client.taskMessages(taskId: taskId, before: nil) }
            let (detailResult, pageResult) = await (detail, page)
            guard !Task.isCancelled, !tornDown else { return }
            switch detailResult {
            case .success(let detail):
                board.detailLoaded(detail)
                markOnline()
            case .failure(let error) where TaskSession.isGone(error):
                // M14: a link to a task that was deleted: say so instead of a Retry that can't work.
                markOnline()
                board.updateSession(taskId) { $0.markGone() }
            case .failure(let error):
                noteFailure(error)
                board.updateSession(taskId) { $0.failDetail(reason: TaskBoard.reason(for: error)) }
            }
            switch pageResult {
            case .success(let page):
                board.updateSession(taskId) { $0.reducer.applyFirstPage(page) }
                settleRouteFocus(.task(taskId), messages: board.sessions[taskId]?.reducer.thread.messages ?? [])
                pumpQueue()
            case .failure(let error):
                board.updateSession(taskId) { session in
                    if session.phase == .gone || (TaskSession.isGone(error) && session.phase != .loaded) {
                        session.markGone()
                    } else if session.reducer.thread.phase != .loaded {
                        session.reducer.thread.phase = .failed(reason: TaskBoard.reason(for: error))
                    }
                }
                // M21: a deleted task has no message to scroll to (another failure keeps the
                // focus for the detail's Retry).
                if board.sessions[taskId]?.phase == .gone { settleRouteFocus(.task(taskId), messages: []) }
            }
        }
    }

    /// A `task` event for the open task: fetch the detail again shortly; more events in the
    /// meantime wait for the same request.
    func scheduleDetailRefetch() {
        guard detailRefetchTask == nil, let taskId = board.openTaskId else { return }
        detailRefetchTask = Task { [client] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            detailRefetchTask = nil
            let result = await Self.result { try await client.task(id: taskId) }
            guard !Task.isCancelled, !tornDown else { return }
            switch result {
            case .success(let detail): board.detailLoaded(detail)
            // Deleted elsewhere (another device) while open here.
            case .failure(let error) where TaskSession.isGone(error): board.updateSession(taskId) { $0.markGone() }
            case .failure(let error): noteFailure(error)
            }
        }
    }

    /// Older messages of the open task's session (?before=<oldest id>).
    func loadOlderTaskMessages() {
        guard !tornDown, let session = board.openSession else { return }
        let thread = session.reducer.thread
        guard thread.phase == .loaded, thread.hasMoreBefore, !thread.loadingOlder,
              let oldest = thread.messages.first?.id else { return }
        let taskId = session.taskId
        board.updateSession(taskId) { $0.reducer.thread.loadingOlder = true }
        detailOlderTask = Task { [client] in
            let result = await Self.result { try await client.taskMessages(taskId: taskId, before: oldest) }
            guard !Task.isCancelled, !tornDown else { return }
            switch result {
            case .success(let page):
                board.updateSession(taskId) { $0.reducer.applyOlderPage(page) }
                markOnline()
            case .failure(let error):
                board.updateSession(taskId) { $0.reducer.thread.loadingOlder = false }
                noteFailure(error)
            }
        }
    }

    /// 409 stale version / 410 expired: the card's thread fetches its newest page again and
    /// merges it (the new version glows its changedFields through ThreadState.edits).
    func reloadCardThread(_ requested: ThreadRef) {
        guard !tornDown else { return }
        // The chat thread is pinned to its channel, so a side-menu switch meanwhile can't merge
        // the page into another channel's thread.
        let target: ThreadRef = requested == .main ? .channel(reducer.channelId) : requested
        Task { [client] in
            let result: Result<MessagePage, any Error> = switch target {
            case .main, .channel:
                await Self.result { [channelId = Self.channelId(of: target)] in try await client.messages(channelId: channelId, before: nil) }
            case .task(let taskId): await Self.result { try await client.taskMessages(taskId: taskId, before: nil) }
            }
            guard !tornDown else { return }
            switch result {
            case .success(let page):
                updateThread(target) { $0.mergePage(page) }
                markOnline()
            case .failure(let error):
                noteFailure(error)
            }
        }
    }

    /// The channel id of a pinned chat-thread target ("" otherwise).
    nonisolated static func channelId(of target: ThreadRef) -> String {
        if case .channel(let id) = target { id } else { "" }
    }

    // MARK: - Routes

    /// ShellActions.openRoute (in-app links, notification taps): duet://tasks/<id> opens the task
    /// over the current tab; duet://channels/<id> closes any task detail, switches the chat to
    /// that channel (the main channel = Everything) and asks the UI for the Chat tab. Artifacts,
    /// files and the computer are M5 / M6. M21: `?message=<id>` scrolls the thread to that
    /// message once its fresh page has it (routeFocus); without it, or when the page doesn't
    /// have it, the thread opens as before. M29: a channel thread pages back for it first
    /// (settleRouteFocus), and the thread scrolls once it is on screen (ThreadView).
    func openRoute(_ url: URL) {
        let route = DuetRoute(url)
        if let wanted = route?.tab, wanted != tab {
            tabRequest = ShellTabRequest(id: UUID(), tab: wanted)
        }
        routeFocus = RouteFocus(url)
        switch route {
        case .task(let id)?: openTask(id)
        case .channel(let id)?:
            if board.openTaskId != nil { closeTask() }
            let shown = reducer.channelId
            selectChannel(id)
            // Already on screen (no switch, so no page load): its newest page again, which may
            // have the line a push named while the stream was closed.
            if reducer.channelId == shown, routeFocus?.thread(channelId: shown) != nil, case .loaded = reducer.thread.phase {
                loadThreadPage()
            }
        // M6: the viewers open over whatever is on screen.
        case .file(let id)?: openFile(id)
        case .computer?: openComputer()
        case .artifact(let id)?: openArtifact(id)
        // M22 (W3): a show_tasks card row's suggestion starts, then its task opens (ChatStore+Tasks).
        case .suggestion(let id)?: startSuggestionRoute(id)
        // M22 (W4): Setup's fixes open that Everything page (ChatStore+Settings).
        case .settings(let page)?: openSettings(page)
        case nil: Self.log.info("openRoute: not an in-app link \(url.absoluteString, privacy: .private)")
        }
    }

    /// M21: a page of a thread came (`target`): a link's focus on it stays only when the loaded
    /// messages have the message; otherwise the thread just opens as before. M29: a channel
    /// thread first pages back for it (RouteFocus.step, at most maxOlderPages) through loadOlder,
    /// whose answer comes back here. `hasMoreBefore` false (task threads, a failed older page)
    /// decides on what is loaded.
    func settleRouteFocus(_ target: RouteFocus.Target, messages: [Message], hasMoreBefore: Bool = false) {
        guard let focus = routeFocus, focus.target == target else { return }
        switch focus.step(messages, hasMoreBefore: hasMoreBefore) {
        case .found:
            return
        case .loadOlder:
            // Only the chat thread's channel pages back here (step: channel targets only).
            guard target == .channel(reducer.channelId) else { return }
            // Already loading one (the thread's own scroll near the top): its answer settles it.
            guard !reducer.thread.loadingOlder else { return }
            routeFocus?.olderPages += 1
            Self.log.info("openRoute: looking for the linked message on an older page (\(focus.olderPages + 1, privacy: .public))")
            loadOlder()
            // loadOlder refused (nothing to load from): decide on what is loaded.
            if !reducer.thread.loadingOlder { settleRouteFocus(target, messages: messages) }
        case .giveUp:
            Self.log.info("openRoute: the linked message isn't on the loaded pages")
            routeFocus = nil
        }
    }

    /// ShellActions.focusShown: the thread scrolled to the link's message.
    func routeFocusShown(_ token: UUID) {
        if routeFocus?.token == token { routeFocus = nil }
    }
}
