// M9 on the store side (contract §2-§5): Pin / Unpin and Delete on tasks (M10: and Rename), the routine sheet's
// history, Run now, Pause / Resume and new times, task_deleted / channel_deleted from any device
// (the open detail or selected channel closes with a short notice), the form card's Submit and
// Skip, and the Usage panel's per-range stats. The state changes are TaskBoard / TasksReducer /
// ThreadReducer / ChannelMenu / AccountBoard / FormSubmits (host-tested); this file does the I/O.
import Foundation

extension ChatStore {
    // MARK: - Tasks: pin, delete

    /// TaskActions.setPinned: the row moves at once; a failure puts it back with the reason
    /// (cardRequests[RequestKey.pinTask(id)]).
    func setTaskPinned(_ taskId: String, _ pinned: Bool) {
        guard !tornDown, board.beginPin(taskId, pinned) else { return }
        let key = ShellState.RequestKey.pinTask(taskId)
        let body = UpdateTaskRequest(status: nil, archived: nil, pinned: pinned)
        runTap(key, { [client] in try await client.patchTask(id: taskId, body) }) { store, result in
            store.board.answerPatch(taskId, key: key, result)
        }
    }

    /// TaskActions.delete, after the in-place confirmation. The row (and an open detail) goes
    /// once the server answers; task_deleted from the stream does the same.
    func deleteTask(_ taskId: String) {
        guard !tornDown, board.beginDelete(taskId) else { return }
        runTap(ShellState.RequestKey.deleteTask(taskId), { [client] in try await client.deleteTask(id: taskId) }) { store, result in
            if store.board.answerDelete(taskId, result) { store.closeDeletedDetail() }
        }
    }

    /// task_deleted: the row, its session and its routine history go; an open detail closes.
    func taskDeleted(_ taskId: String) {
        if board.removeTask(taskId) { closeDeletedDetail() }
    }

    /// The open task was deleted: its loads stop, the detail closes and the notice says why.
    private func closeDeletedDetail() {
        closeTask()
        postNotice(.taskDeleted)
    }

    // MARK: - Channels: channel_deleted

    /// channel_deleted (or the DELETE answer): the channel leaves the menu and the Archived list,
    /// its tasks and parked thread go, and a selected channel falls back to Everything.
    func channelDeleted(_ channelId: String) {
        guard !tornDown, channelId != menu.mainChannelId else { return }
        let selected = menu.state.selectedChannelId == channelId
        if selected {
            // Its read receipt has nowhere to go.
            readTask?.cancel()
            readTask = nil
            readPending = false
        }
        if let selection = menu.remove(channelId) { applySelection(selection) }
        parked.drop(channelId)
        reducer.forgetChannel(channelId)
        syncChannelNames()
        let closedDetail = board.removeChannel(channelId)
        if closedDetail { closeTask() }
        if computerBoard.files.channelSheet?.channelId == channelId { closeChannelSheet() }
        if selected || closedDetail { postNotice(selected ? .channelDeleted : .taskDeleted) }
    }

    // MARK: - Notices

    /// Floats "Task deleted" / "Channel deleted" for ShellNotice.seconds.
    func postNotice(_ kind: ShellNotice.Kind) {
        let notice = ShellNotice(kind: kind)
        self.notice = notice
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(ShellNotice.seconds))
            guard !Task.isCancelled, let self, self.notice?.id == notice.id else { return }
            self.notice = nil
        }
    }

    // MARK: - Routines

    /// The routine sheet opened (or its Retry): GET /api/tasks/:id/runs into
    /// TasksState.routineRuns[id] (cardRequests[RequestKey.routineRuns(id)] while in flight).
    func loadRoutineRuns(_ taskId: String) {
        guard !tornDown, board.beginRoutineRuns(taskId) else { return }
        runTap(ShellState.RequestKey.routineRuns(taskId), { [client] in try await client.routineRuns(taskId: taskId) }) { store, result in
            store.board.answerRoutineRuns(taskId, result)
        }
    }

    /// Run now: POST /api/tasks/:id/run; the queued run heads the history, 409 says it's running.
    func runRoutine(_ taskId: String) {
        guard !tornDown, board.beginRoutineRun(taskId) else { return }
        runTap(ShellState.RequestKey.routine(taskId), { [client] in try await client.runRoutine(taskId: taskId) }) { store, result in
            store.board.answerRoutineRun(taskId, result)
        }
    }

    /// Pause / Resume at once (the row says "Paused"); a failure puts it back with the reason.
    func setRoutinePaused(_ taskId: String, _ paused: Bool) {
        guard !tornDown, board.beginRoutineChange(taskId, paused: paused) else { return }
        patchRoutine(taskId, UpdateTaskRequest(status: nil, archived: nil, paused: paused))
    }

    /// A new time and / or title from the routine sheet (nil = unchanged). M10: a title alone for
    /// a task that isn't a routine is a Rename (TaskActions.rename).
    func updateRoutine(_ taskId: String, schedule: Schedule?, title: String?) {
        if schedule == nil, let title, board.list.task(taskId)?.routine == nil {
            renameTask(taskId, title: title)
            return
        }
        let title = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let newTitle = (title?.isEmpty ?? true) ? nil : title
        guard !tornDown, schedule != nil || newTitle != nil,
              board.beginRoutineChange(taskId, schedule: schedule, title: newTitle) else { return }
        patchRoutine(taskId, UpdateTaskRequest(status: nil, archived: nil, schedule: schedule, title: newTitle))
    }

    /// M10: Rename any task (contract §3): the row shows the new title at once; PATCH {title}
    /// (trimmed, 1-200 characters); a failure puts the old title back and leaves the reason
    /// (cardRequests[RequestKey.renameTask(id)]). The `task` event updates chips elsewhere.
    func renameTask(_ taskId: String, title: String) {
        guard !tornDown, let title = TaskTitleRule.cleaned(title), board.beginRename(taskId, title: title) else { return }
        let key = ShellState.RequestKey.renameTask(taskId)
        let body = UpdateTaskRequest(status: nil, archived: nil, title: title)
        runTap(key, { [client] in try await client.patchTask(id: taskId, body) }) { store, result in
            store.board.answerPatch(taskId, key: key, result)
        }
    }

    private func patchRoutine(_ taskId: String, _ body: UpdateTaskRequest) {
        let key = ShellState.RequestKey.routine(taskId)
        runTap(key, { [client] in try await client.patchTask(id: taskId, body) }) { store, result in
            store.board.answerPatch(taskId, key: key, result)
        }
    }

    /// A run ended: routines whose loaded history still had a queued / running run fetch it again.
    func refreshOpenRoutineRuns() {
        for id in board.list.routinesWithOpenRuns { loadRoutineRuns(id) }
    }

    // MARK: - Form cards (contract §2)

    /// CardActions.submitForm: the card turns submitted with the answers and a pending bubble
    /// shows `summary` at once; the summary goes out with `.form` in the card's own thread
    /// (cardRequests[messageId] until the server echoes it).
    func submitForm(messageId: String, answers: [FormAnswer], summary: String) {
        guard !tornDown, formSubmits.clientId(for: messageId) == nil,
              let found = board.thread(containing: messageId, main: reducer) else { return }
        // The chat thread is pinned to its channel, so a side-menu switch meanwhile still rolls
        // back the right card.
        let thread: ThreadRef = found == .main ? .channel(reducer.channelId) : found
        guard board.beginForm(messageId) else { return }
        var before: FormSnapshot?
        updateThread(thread) { before = $0.setFormState(messageId, .submitted, answers: answers) }
        guard let before else {
            // Not an open form card any more (already answered elsewhere).
            board.endForm(messageId, failure: nil)
            return
        }
        let entry = FormSubmits.Entry(messageId: messageId, answers: answers, before: before, thread: thread)
        let text = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        enqueue(text: text, files: [], quickReply: nil, form: entry, to: thread)
    }

    /// A form answer that didn't go through (ChatStore+Send.rejected): wait offline, fetch the
    /// card's thread again (409, or no echo), or open the card again with the reason.
    func formRefused(_ clientId: String, in target: ThreadRef, _ outcome: FormSubmits.Outcome) {
        guard let entry = formSubmits.entry(clientId) else { return pumpQueue() }
        switch outcome {
        case .wait:
            // Like any message typed offline: the bubble waits with its clock badge.
            updateThread(target) { $0.setPending(clientId, .waiting) }
            board.endForm(entry.messageId, failure: nil)
        case .reload:
            formSubmits.finish(clientId)
            updateThread(target) { $0.removePending(clientId) }
            updateThread(entry.thread) { $0.restoreForm(entry.messageId, entry.before) }
            board.endForm(entry.messageId, failure: nil)
            reloadCardThread(entry.thread)
            pumpQueue()
        case .rollBack(let reason):
            formSubmits.finish(clientId)
            updateThread(target) { $0.removePending(clientId) }
            updateThread(entry.thread) { $0.restoreForm(entry.messageId, entry.before) }
            board.endForm(entry.messageId, failure: reason)
            pumpQueue()
        }
    }

    /// CardActions.dismissForm ("Skip"): the card shows skipped at once; POST action dismiss. A
    /// refusal opens it again with the reason; 409 fetches its thread again.
    func dismissForm(messageId: String) {
        guard !tornDown, formSubmits.clientId(for: messageId) == nil,
              let found = board.thread(containing: messageId, main: reducer) else { return }
        let thread: ThreadRef = found == .main ? .channel(reducer.channelId) : found
        guard board.beginForm(messageId) else { return }
        var before: FormSnapshot?
        updateThread(thread) { before = $0.setFormState(messageId, .dismissed, answers: nil) }
        guard let before else {
            board.endForm(messageId, failure: nil)
            return
        }
        let body = MessageActionRequest(action: .dismiss, itemId: nil)
        runTap(messageId, { [client] in try await client.messageAction(messageId: messageId, body) }) { store, result in
            switch result {
            case .success(let message):
                store.board.endForm(messageId, failure: nil)
                store.board.accept(message, main: &store.reducer)
            case .failure(let error):
                store.updateThread(thread) { $0.restoreForm(messageId, before) }
                switch FormSubmits.outcome(for: error) {
                case .reload:
                    store.board.endForm(messageId, failure: nil)
                    store.reloadCardThread(thread)
                case .wait where error is CancellationError:
                    store.board.endForm(messageId, failure: nil)
                case .wait:
                    store.board.endForm(messageId, failure: TaskBoard.reason(for: error))
                case .rollBack(let reason):
                    store.board.endForm(messageId, failure: reason)
                }
            }
        }
    }

    // MARK: - Usage panel (contract §5)

    /// AccountActions.loadUsageStats: the panel shows `range`; GET /api/usage/stats?range= when
    /// it isn't cached (or the cache went stale). A cached range keeps showing meanwhile.
    func loadUsageStats(_ range: UsageRange) {
        guard !tornDown, account.beginUsageStats(range) else { return }
        usageStatsTasks[range]?.cancel()
        usageStatsTasks[range] = Task { [client] in
            let result = await Self.result { try await client.usageStats(range: range) }
            guard !Task.isCancelled, !tornDown else { return }
            usageStatsTasks[range] = nil
            switch result {
            case .success(let stats):
                account.applyUsageStats(stats, range: range)
                markOnline()
            case .failure(let error):
                noteFailure(error)
                account.failUsageStats(range, error)
            }
        }
    }
}
