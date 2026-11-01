// The side menu and channels (L124, L125): GET /api/channels for the rows and the ≡ badge,
// selecting Everything or a channel (the chat thread, its read receipts and the Tasks scope
// move together), the Archived list, New channel and Archive / Unarchive. Live changes arrive as
// `channel` events through route().
import Foundation

extension ChatStore {
    /// MenuActions.refresh (the menu opened). M19: the answer usually lands while the menu slides
    /// in and usually matches what is shown: only what changed is written, so an unchanged list
    /// doesn't redraw the shell (every observed write re-renders it) during the slide.
    func refreshMenu() {
        guard !tornDown else { return }
        menuTask?.cancel()
        menuTask = Task { [client] in
            do {
                let channels = try await client.channels()
                try Task.checkCancellation()
                // Names and lastReadAt for the threads; the open thread's "New" divider stays put.
                for channel in channels where reducer.channels[channel.id] != channel {
                    reducer.noteChannel(channel)
                }
                let names = reducer.channels.mapValues(\.name)
                if names != board.list.state.channelNames { syncChannelNames() }
                var next = menu
                let selection = next.setChannels(channels)
                if next != menu { menu = next }
                if let selection { applySelection(selection) }
                markOnline()
            } catch is CancellationError {
                return
            } catch {
                noteFailure(error)
            }
        }
    }

    /// MenuActions.select, duet://channels/<id> and notification taps. nil or the main channel =
    /// Everything. A channel the menu doesn't know yet is picked once GET /api/channels lists it.
    func selectChannel(_ id: String?) {
        guard !tornDown else { return }
        if let selection = menu.select(id) {
            applySelection(selection)
        } else if menu.pendingSelection != nil {
            refreshMenu()
        }
    }

    /// Moves the chat thread and the Tasks scope to a selection.
    func applySelection(_ selection: ChannelSelection) {
        guard !tornDown else { return }
        if selection.threadChannelId != reducer.channelId {
            // Leave the old thread: its read receipt goes out now, its loads stop, its unsent
            // messages keep going in a parked thread (M16: otherwise it is cached, ThreadCache),
            // and the composer's attachments (uploaded to that channel) are dropped. A cached
            // thread comes back as it was and loadThreadPage refreshes it without a skeleton.
            flushPendingRead()
            loadTask?.cancel()
            olderTask?.cancel()
            discardComposerAttachments()
            // M8: a quote belongs to the thread it was taken from.
            composer.replyTo = nil
            reducer = parked.switchThread(from: reducer, to: selection.threadChannelId)
            reducer.thread.loadingOlder = false
            lastMarkedRead = nil
            // M21: a link's focus on another channel is left behind.
            if case .channel(let id)? = routeFocus?.target, id != selection.threadChannelId { routeFocus = nil }
            loadThreadPage()
        }
        if selection.scope != board.list.state.scopeChannelId {
            board.list.setScope(selection.scope)
            refreshTasks()
        }
    }

    /// MenuActions.loadArchived: fills MenuState.archived; a failure with nothing shown yet sets
    /// MenuState.archivedError (the UI's Retry calls this again).
    func loadArchived() {
        guard !tornDown else { return }
        archivedTask?.cancel()
        menu.beginArchived()
        archivedTask = Task { [client] in
            do {
                let list = try await client.archivedChannels()
                try Task.checkCancellation()
                menu.setArchived(list)
                list.forEach { reducer.noteChannel($0) }
                syncChannelNames()
                markOnline()
            } catch is CancellationError {
                return
            } catch {
                noteFailure(error)
                menu.failArchived(reason: TaskBoard.reason(for: error))
            }
        }
    }

    /// The New channel sheet's Create (cardRequests[RequestKey.createChannel]): success selects the
    /// new channel (the assistant's hello arrives as events) and clears the request. M11: `access` are the
    /// items picked in "What can OpenDuet use here?"; greet is always on (the greeting is the hello).
    func createChannel(name: String, purpose: String, icon: ChannelIcon, color: ChannelColor, access: [AccessRef] = []) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = ShellState.RequestKey.createChannel
        guard !tornDown, !trimmed.isEmpty, account.begin(key) else { return }
        let body = CreateChannelRequest(
            name: trimmed, icon: icon, colorHex: color,
            purpose: purpose.trimmingCharacters(in: .whitespacesAndNewlines),
            access: access, greet: true
        )
        runTap(key, { [client] in try await client.createChannel(body) }) { store, result in
            guard let channel = store.account.answer(key, result) else { return }
            store.adopt(channel)
            store.selectChannel(channel.id)
        }
    }

    /// Archive / Unarchive (cardRequests[RequestKey.archive(id)]). Archiving the selected channel
    /// sends the chat back to Everything.
    func setChannelArchived(_ channelId: String, archived: Bool) {
        let key = ShellState.RequestKey.archive(channelId)
        guard !tornDown, account.begin(key) else { return }
        let body = UpdateChannelRequest(archived: archived)
        runTap(key, { [client] in try await client.updateChannel(id: channelId, body) }) { store, result in
            guard let channel = store.account.answer(key, result) else { return }
            store.adopt(channel)
        }
    }

    // MARK: - M9: Edit, Delete, Mark as read

    /// The New channel sheet in edit mode: PATCH name / purpose / icon / colour
    /// (cardRequests[RequestKey.updateChannel(id)]); the sheet closes when the request clears.
    func updateChannel(_ channelId: String, name: String, purpose: String, icon: ChannelIcon, color: ChannelColor) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = ShellState.RequestKey.updateChannel(channelId)
        guard !tornDown, !trimmed.isEmpty, channelId != menu.mainChannelId, account.begin(key) else { return }
        let body = UpdateChannelRequest(
            name: trimmed, icon: icon, colorHex: color,
            purpose: purpose.trimmingCharacters(in: .whitespacesAndNewlines), archived: nil
        )
        runTap(key, { [client] in try await client.updateChannel(id: channelId, body) }) { store, result in
            guard let channel = store.account.answer(key, result) else { return }
            store.adopt(channel)
        }
    }

    /// Long-press Delete, after the in-place confirmation (cardRequests[RequestKey.deleteChannel(id)]).
    /// Success (or 404: already gone) removes it like channel_deleted.
    func deleteChannel(_ channelId: String) {
        let key = ShellState.RequestKey.deleteChannel(channelId)
        guard !tornDown, channelId != menu.mainChannelId, account.begin(key) else { return }
        runTap(key, { [client] in try await client.deleteChannel(id: channelId) }) { store, result in
            switch result {
            case .success:
                store.account.clear(key)
                store.channelDeleted(channelId)
            case .failure(let error as APIError) where error == .notFound:
                store.account.clear(key)
                store.channelDeleted(channelId)
            case .failure(let error):
                store.account.fail(key, error)
            }
        }
    }

    /// Long-press Mark as read: the badge goes at once; a failure puts it back with the reason
    /// under the row (cardRequests[RequestKey.markRead(id)]).
    func markChannelRead(_ channelId: String) {
        let key = ShellState.RequestKey.markRead(channelId)
        guard !tornDown, let before = menu.channel(channelId), account.begin(key) else { return }
        let at = max(before.lastMessageAt ?? .now, .now)
        menu.markedRead(channelId, at: at)
        runTap(key, { [client] in try await client.markRead(channelId: channelId, at: at) }) { store, result in
            if case .failure = result { store.menu.restoreUnread(before) }
            _ = store.account.answer(key, result)
        }
    }

    /// A channel from a POST / PATCH answer: into the menu and the thread's channel names.
    private func adopt(_ channel: Channel) {
        reducer.noteChannel(channel)
        syncChannelNames()
        if let selection = menu.apply(channel) { applySelection(selection) }
    }

    /// Composer attachments belong to the channel they were uploaded to; switching threads drops
    /// them (in-flight uploads are cancelled, uploaded files deleted).
    private func discardComposerAttachments() {
        for attachment in composer.attachments { removeAttachment(attachment.id) }
    }
}
