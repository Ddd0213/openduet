// Loading the main thread: me, then the channels (the one with isMain), then the newest page;
// older pages on demand; debounced read receipts.
import Foundation

extension ChatStore {
    /// First load and "Retry"/reload. The skeleton only shows while nothing is on screen.
    func loadThread() {
        guard !tornDown else { return }
        loadTask?.cancel()
        if reducer.thread.phase != .loaded { reducer.thread.phase = .loading }
        loadTask = Task { await performLoad() }
    }

    private func performLoad() async {
        do {
            let (me, json) = try await client.me()
            refreshUser(me, json: json)
            let channels = try await client.channels()
            try Task.checkCancellation()
            // Everything: the main channel may be another id than first assumed. A selected
            // channel (M4 side menu) keeps its thread.
            if menu.state.selectedChannelId == nil, let main = channels.first(where: \.isMain) { reducer.retarget(to: main.id) }
            reducer.setChannels(channels)
            syncChannelNames()
            if let selection = menu.setChannels(channels) {
                // The selected channel is gone (or a pending one arrived): that switch loads its own page.
                applySelection(selection)
                return
            }
            let channelId = reducer.channelId
            let page = try await client.messages(channelId: channelId, before: nil)
            try Task.checkCancellation()
            guard channelId == reducer.channelId else { return }
            reducer.applyFirstPage(page)
            settleRouteFocus(.channel(channelId), messages: reducer.thread.messages, hasMoreBefore: reducer.thread.hasMoreBefore)
            markOnline()
        } catch is CancellationError {
            return
        } catch {
            noteFailure(error)
            if reducer.thread.phase != .loaded {
                reducer.thread.phase = .failed(reason: (error as? APIError)?.localizedReason ?? String(localized: "Something went wrong."))
            }
        }
    }

    /// The page before the oldest message (?before=<id>).
    func loadOlder() {
        let thread = reducer.thread
        guard !tornDown, thread.phase == .loaded, thread.hasMoreBefore, !thread.loadingOlder,
              let oldest = thread.messages.first?.id else { return }
        reducer.thread.loadingOlder = true
        let channelId = reducer.channelId
        olderTask = Task {
            do {
                let page = try await client.messages(channelId: channelId, before: oldest)
                guard channelId == reducer.channelId else { return }
                reducer.applyOlderPage(page)
                markOnline()
                // M29: a link's message may be on this page (or the search goes on, or gives up).
                settleRouteFocus(.channel(channelId), messages: reducer.thread.messages, hasMoreBefore: reducer.thread.hasMoreBefore)
            } catch {
                reducer.thread.loadingOlder = false
                noteFailure(error)
                // M29: a link still looking for its message stops at what is loaded.
                if channelId == reducer.channelId { settleRouteFocus(.channel(channelId), messages: reducer.thread.messages) }
            }
        }
    }

    /// The thread is on screen (M21: anywhere in it, not only at the bottom) and the app is in the
    /// foreground: POST /api/channels/:id/read, debounced. M21: the receipt names the newest
    /// message (`messageId`), so the server reads up to that message's own time.
    func markRead() {
        guard !tornDown else { return }
        readTask?.cancel()
        readPending = true
        readTask = Task {
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            await flushRead()
        }
    }

    /// M21: the chat thread is what the user sees (Chat tab, app in front, nothing over it): the
    /// same rule as ThreadView's isActive, for `channel` events that arrive meanwhile.
    var threadOnScreen: Bool {
        foregroundActive && tab == .chat && board.openTaskId == nil
            && makeBoard.state.viewer == nil && makeBoard.state.build == nil
    }

    /// M21: a `channel` event for the thread on screen with unread messages (the assistant posted while
    /// the user is in it): read it now, even when a receipt for the newest message already went
    /// out (the server's count is the truth).
    func readOnScreenChannel(_ channel: Channel) {
        guard ReadReceiptRule.readsNow(channel, threadChannelId: reducer.channelId, onScreen: threadOnScreen),
              reducer.thread.phase == .loaded else { return }
        lastMarkedRead = nil
        markRead()
    }

    private func flushRead() async {
        readPending = false
        let channelId = reducer.channelId
        guard let newest = reducer.thread.messages.last,
              ReadReceiptRule.isDue(newest: newest.createdAt, lastMarked: lastMarkedRead) else { return }
        do {
            try await client.markRead(channelId: channelId, at: newest.createdAt, messageId: newest.id)
            if channelId == reducer.channelId { lastMarkedRead = newest.createdAt }
            menu.markedRead(channelId, at: newest.createdAt)
            markOnline()
        } catch {
            noteFailure(error)
        }
    }

    /// The chat is about to leave this thread: a read receipt still in its debounce goes out now
    /// for this channel, so the read state follows the user (M4).
    func flushPendingRead() {
        readTask?.cancel()
        readTask = nil
        guard readPending else { return }
        readPending = false
        let channelId = reducer.channelId
        guard let newest = reducer.thread.messages.last,
              ReadReceiptRule.isDue(newest: newest.createdAt, lastMarked: lastMarkedRead) else { return }
        let messageId = newest.id, at = newest.createdAt
        Task { [client] in
            do {
                try await client.markRead(channelId: channelId, at: at, messageId: messageId)
                menu.markedRead(channelId, at: at)
            } catch {
                noteFailure(error)
            }
        }
    }

    /// The newest page of the chat thread after a side-menu switch (no me / channels round trip).
    /// M16: a cached thread (ParkedThreads.recent) is already loaded, so it stays on screen with
    /// no skeleton and the page merges into it; only a channel never loaded this session shows
    /// the skeleton. A channel the server no longer has (404) sends the chat back to Everything.
    func loadThreadPage() {
        guard !tornDown else { return }
        loadTask?.cancel()
        if reducer.thread.phase != .loaded { reducer.thread.phase = .loading }
        let channelId = reducer.channelId
        loadTask = Task { [client] in
            do {
                let page = try await client.messages(channelId: channelId, before: nil)
                try Task.checkCancellation()
                guard channelId == reducer.channelId else { return }
                // M19: merged on a copy; the observed reducer is written only when the page
                // changed something (an unchanged page used to re-render the whole thread while
                // the side menu's close spring was still running).
                var refreshed = reducer
                if refreshed.applyRefreshedPage(page) { reducer = refreshed }
                // M21: a link's message that the loaded pages don't have: M29 pages back for it
                // (up to RouteFocus.maxOlderPages), else the thread opens as before.
                settleRouteFocus(.channel(channelId), messages: reducer.thread.messages, hasMoreBefore: reducer.thread.hasMoreBefore)
                markOnline()
            } catch is CancellationError {
                return
            } catch {
                guard channelId == reducer.channelId else { return }
                if case APIError.notFound = error, channelId != menu.mainChannelId {
                    if let selection = menu.select(nil) { applySelection(selection) }
                    // Leaving it cached it; it can't be shown again.
                    parked.dropCached(channelId)
                    refreshMenu()
                    return
                }
                noteFailure(error)
                if reducer.thread.phase != .loaded {
                    reducer.thread.phase = .failed(reason: TaskBoard.reason(for: error))
                }
            }
        }
    }
}
