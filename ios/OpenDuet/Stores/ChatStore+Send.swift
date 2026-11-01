// Sending (L184): an optimistic PendingMessage first, then POST SendMessageRequest and the
// run's SSE answer through route(). Offline, messages wait (clock badge) and go out in order
// once the server is back; rejected ones (usage limit, validation) are marked failed and can be
// retried with the same clientId. The same pipeline serves the main thread
// (POST /api/channels/:id/messages) and a task's own session (POST /api/tasks/:id/messages,
// "Reply to OpenDuet"); each thread's queue goes out in its own order.
import Foundation

extension ChatStore {
    /// `skill` (M6, L156): the /skill chosen in the composer, sent as SendMessageRequest.skill.
    /// `quoting` (M8): the composer's send carries its quote chip (replyTo) and clears it; chips
    /// that send text as the user (cards, "↪ Shorten") pass false and leave the chip alone.
    func send(text: String, attachmentIds: [UUID], skill: String? = nil, quoting: Bool = true) {
        guard !tornDown else { return }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let chosen = composer.attachments.filter { attachmentIds.contains($0.id) }
        let files: [ChannelFile] = chosen.compactMap {
            if case .uploaded(let file) = $0.upload { file } else { nil }
        }
        guard !body.isEmpty || !files.isEmpty else { return }
        let sentIds = Set(chosen.compactMap { attachment -> UUID? in
            if case .uploaded = attachment.upload { attachment.id } else { nil }
        })
        composer.attachments.removeAll { sentIds.contains($0.id) }
        sentIds.forEach { uploadSources[$0] = nil }
        let quote = quoting ? composer.replyTo : nil
        if quoting { composer.replyTo = nil }
        enqueue(text: body, files: files, quickReply: nil, skill: skill, replyTo: quote, to: .main)
    }

    /// "Reply to OpenDuet" in the open task detail: into the task's own session. M21 (review C19):
    /// with the files uploaded in its composer (TaskSession.attachments, uploaded to the task's
    /// channel); the ones sent leave the composer.
    func reply(text: String, attachmentIds: [UUID] = []) {
        guard !tornDown, let taskId = board.openTaskId else { return }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let chosen = (board.sessions[taskId]?.attachments ?? []).filter { attachmentIds.contains($0.id) }
        let files: [ChannelFile] = chosen.compactMap {
            if case .uploaded(let file) = $0.upload { file } else { nil }
        }
        guard !body.isEmpty || !files.isEmpty else { return }
        let sentIds = Set(chosen.compactMap { attachment -> UUID? in
            if case .uploaded = attachment.upload { attachment.id } else { nil }
        })
        var quote: ReplyQuote?
        board.updateSession(taskId) { session in
            quote = session.replyTo
            session.replyTo = nil
            session.attachments.removeAll { sentIds.contains($0.id) }
        }
        sentIds.forEach { uploadSources[$0] = nil; attachmentTaskIds[$0] = nil }
        enqueue(text: body, files: files, quickReply: nil, replyTo: quote, to: .task(taskId))
    }

    /// M8: the open task detail's quote chip (swipe right on an assistant bubble there; ✕ clears it).
    func setTaskReplyTo(_ quote: ReplyQuote?) {
        guard let taskId = board.openTaskId else { return }
        board.updateSession(taskId) { $0.replyTo = quote }
    }

    /// A quick-reply chip: its option text, sent with SendMessageRequest.quickReply, into the
    /// thread that shows the chips (the main thread or a task's session).
    func quickReply(messageId: String, option: String) {
        guard !tornDown else { return }
        let target = board.thread(containing: messageId, main: reducer) ?? .main
        enqueue(text: option, files: [], quickReply: .init(messageId: messageId, option: option), to: target)
    }

    /// A failed bubble's Retry: back in the queue with the same clientId (the server dedups it).
    func retryPending(_ clientId: String) {
        guard let target = board.thread(pending: clientId, main: reducer),
              pendingState(clientId, in: target) == .failed else { return }
        updateThread(target) { $0.retry(clientId) }
        pumpQueue()
    }

    /// M9: `form` = a form card's Submit (ChatStore+M9): the request carries `.form`, and its
    /// failures roll the card back instead of leaving a Retry bubble.
    func enqueue(text: String, files: [ChannelFile], quickReply: SendMessageRequest.QuickReply?, skill: String? = nil,
                 replyTo: ReplyQuote? = nil, form: FormSubmits.Entry? = nil, to target: ThreadRef) {
        let clientId = UUID().uuidString.lowercased()
        if let quickReply { quickReplies[clientId] = quickReply }
        if let skill { makeRuntime.pendingSkills[clientId] = skill }
        if let form { formSubmits.add(clientId: clientId, form) }
        // Only a message still in this thread can be quoted (the server answers 400 otherwise).
        var quote = replyTo
        updateThread(target) { reducer in
            if let id = quote?.messageId, !reducer.contains(messageId: id) { quote = nil }
            reducer.enqueue(PendingMessage(clientId: clientId, text: text, attachments: files, createdAt: .now, state: .waiting, replyTo: quote))
        }
        pumpQueue()
    }

    // MARK: - Threads

    /// Changes the chat thread, a parked channel thread or a task session's thread in place.
    func updateThread(_ target: ThreadRef, _ body: (inout ThreadReducer) -> Void) {
        switch target {
        case .main: body(&reducer)
        case .channel(let id) where id == reducer.channelId: body(&reducer)
        case .channel(let id): parked.update(id, body)
        case .task(let id): board.updateSession(id) { body(&$0.reducer) }
        }
    }

    private func pendingState(_ clientId: String, in target: ThreadRef) -> PendingMessage.State? {
        switch target {
        case .main: reducer.pendingState(clientId)
        case .channel(let id) where id == reducer.channelId: reducer.pendingState(clientId)
        case .channel(let id): parked.pendingState(clientId, in: id)
        case .task(let id): board.sessions[id]?.reducer.pendingState(clientId)
        }
    }

    private func isPending(_ clientId: String, in target: ThreadRef) -> Bool {
        pendingState(clientId, in: target) != nil
    }

    // MARK: - Queue

    /// Sends the next waiting message of each thread while online; one at a time per thread so
    /// the order holds.
    func pumpQueue() {
        guard !tornDown, connection == .online else { return }
        let targets: [ThreadRef] = [.main] + parked.channelIds.map { .channel($0) } + board.sessions.keys.sorted().map { .task($0) }
        for target in targets {
            var next: PendingMessage?
            updateThread(target) { next = $0.nextToSend() }
            if let next { deliver(next, to: target) }
        }
    }

    func schedulePump(after seconds: Double) {
        pumpTask?.cancel()
        pumpTask = Task {
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            pumpQueue()
        }
    }

    private func deliver(_ pending: PendingMessage, to requested: ThreadRef) {
        // Pin the chat thread to its channel, so a side-menu switch mid-send still settles the
        // message in the thread it was typed in (parked meanwhile).
        let target: ThreadRef = requested == .main ? .channel(reducer.channelId) : requested
        let clientId = pending.clientId
        let request = SendMessageRequest(
            text: pending.text,
            clientId: clientId,
            fileIds: pending.attachments.isEmpty ? nil : pending.attachments.map(\.id),
            skill: makeRuntime.pendingSkills[clientId],
            quickReply: quickReplies[clientId],
            replyTo: pending.replyTo?.messageId,
            form: formSubmits.submission(clientId)
        )
        let stream = switch target {
        case .main: client.sendMessage(channelId: reducer.channelId, request)
        case .channel(let channelId): client.sendMessage(channelId: channelId, request)
        case .task(let taskId): client.sendTaskMessage(taskId: taskId, request)
        }
        sendTasks[clientId] = Task {
            var settled = false
            do {
                for try await item in stream {
                    switch item {
                    case .opened: markOnline()
                    case .activity: break
                    case .event(let event): route(event)
                    }
                    // The server echoed our message (here or on /api/events): the next one may go.
                    if !settled && !isPending(clientId, in: target) {
                        settled = true
                        accepted(clientId)
                    }
                }
                if !settled {
                    settled = true
                    if formSubmits.entry(clientId) != nil {
                        // M9: a form's answer may have landed anyway; the card's thread tells.
                        formRefused(clientId, in: target, .reload)
                    } else {
                        // The stream ended without the echo; let the user retry.
                        if isPending(clientId, in: target) { updateThread(target) { $0.setPending(clientId, .failed) } }
                        pumpQueue()
                    }
                }
            } catch {
                if !settled { rejected(clientId, in: target, error) } else { noteFailure(error) }
            }
            sendTasks[clientId] = nil
        }
    }

    private func accepted(_ clientId: String) {
        quickReplies[clientId] = nil
        makeRuntime.pendingSkills[clientId] = nil
        // M9: the form's answer is in; the card's own update arrives as a message event.
        if let form = formSubmits.finish(clientId) { board.endForm(form.messageId, failure: nil) }
        // A closed task's session (or a parked channel thread) was kept only for this reply.
        board.prune()
        parked.prune()
        pumpQueue()
    }

    private func rejected(_ clientId: String, in target: ThreadRef, _ error: any Error) {
        guard isPending(clientId, in: target) else {
            formSubmits.finish(clientId)
            return pumpQueue()
        }
        if formSubmits.entry(clientId) != nil {
            // M9: a refused form answer opens the card again (or reloads it on 409).
            noteFailure(error)
            return formRefused(clientId, in: target, FormSubmits.outcome(for: error))
        }
        let api = error as? APIError
        if api == .staleVersion, quickReplies[clientId] != nil {
            // M21: the options were already answered (another device, or an earlier turn's):
            // the bubble goes and the thread loads again, showing the server's choice.
            quickReplies[clientId] = nil
            updateThread(target) { $0.removePending(clientId) }
            reloadCardThread(target)
            return pumpQueue()
        }
        if error is CancellationError || api?.isConnectivity == true || api == .unauthorized {
            // Offline (or signing out): keep it waiting with the clock badge.
            updateThread(target) { $0.setPending(clientId, .waiting) }
            noteFailure(error)
        } else {
            // usage_limited, validation_failed ...: failed, Retry sends it again.
            updateThread(target) { $0.setPending(clientId, .failed) }
            pumpQueue()
        }
    }
}
