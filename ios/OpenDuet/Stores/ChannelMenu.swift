// The side menu (L124): the channels other than the main thread in the server's order, the
// Archived list, the selected channel (nil = Everything) and the unread badge on ≡. `channel`
// events and GET /api/channels keep it current; a selected channel that is archived or gone
// sends the chat back to Everything. ParkedThreads keeps a channel thread that still has unsent
// messages alive after the user moves to another channel, so its queue still goes out and
// reconciles with the echoes. Foundation + models only, so the Mac host tests drive it.
import Foundation

/// The thread the chat switches to after a selection.
struct ChannelSelection: Hashable, Sendable {
    /// the channel whose thread the chat shows (the main channel for Everything)
    var threadChannelId: String
    /// MenuState.selectedChannelId and TasksState.scopeChannelId (nil = Everything)
    var scope: String?
}

/// M21: when the open thread sends its read receipt (POST /api/channels/:id/read with the newest
/// message's id): whenever the thread is on screen and the app is in the foreground, not only at
/// the bottom.
enum ReadReceiptRule {
    /// A `channel` event says the thread on screen has unread messages (the assistant just posted
    /// there): read it now, even if a receipt already went out for what the app has.
    static func readsNow(_ channel: Channel, threadChannelId: String, onScreen: Bool) -> Bool {
        onScreen && channel.id == threadChannelId && !channel.archived && channel.unreadCount > 0
    }

    /// A receipt is due unless one already went out for this newest message (or a newer one).
    static func isDue(newest: Date, lastMarked: Date?) -> Bool {
        lastMarked.map { $0 < newest } ?? true
    }
}

/// Equatable (M19) so ChatStore writes it only when a refresh changed it.
struct ChannelMenu: Equatable, Sendable {
    private(set) var state = MenuState()
    private(set) var mainChannelId: String
    /// A channel picked (duet:// link, notification) before the list knew it; applied when it shows up.
    private(set) var pendingSelection: String?
    private(set) var loaded = false
    /// M9: deleted channels; a late `channel` event never brings one back.
    private var deleted = Set<String>()

    init(mainChannelId: String) {
        self.mainChannelId = mainChannelId
    }

    /// The channel the chat thread shows.
    var threadChannelId: String { state.selectedChannelId ?? mainChannelId }

    /// The composer placeholder / header pill context.
    var context: ThreadContext {
        guard state.selectedChannelId != nil else { return .main }
        return .channel(name: state.selected?.name ?? "")
    }

    /// Badge on ≡: open channels with unread messages, not counting the one on screen.
    var unreadChannels: Int {
        state.channels.filter { $0.id != state.selectedChannelId && $0.unreadCount > 0 }.count
    }

    // MARK: - Selection

    /// MenuActions.select: nil (or the main channel) = Everything. Returns the switch to make, or
    /// nil when nothing changes (already selected, archived, or not known yet - that one is kept
    /// as pending and applied once GET /api/channels lists it).
    mutating func select(_ id: String?) -> ChannelSelection? {
        let target = (id == mainChannelId) ? nil : id
        pendingSelection = nil
        guard target != state.selectedChannelId else { return nil }
        if let target, !state.channels.contains(where: { $0.id == target }) {
            if state.archived?.contains(where: { $0.id == target }) != true { pendingSelection = target }
            return nil
        }
        state.selectedChannelId = target
        // M21: opening a channel clears its count at once (its read receipt follows); lastReadAt
        // stays, so the thread's "New" divider still marks where the unread part starts.
        if let target, let index = state.channels.firstIndex(where: { $0.id == target }) {
            state.channels[index].unreadCount = 0
        }
        return ChannelSelection(threadChannelId: target ?? mainChannelId, scope: target)
    }

    /// M21: the count a row shows: none on the selected row (the channel on screen), like the ≡
    /// badge, which doesn't count it either.
    static func shownUnread(_ channel: Channel, selected: Bool) -> Int {
        selected ? 0 : channel.unreadCount
    }

    // MARK: - Server data

    /// GET /api/channels: the menu's rows (main thread and archived ones left out). Returns the
    /// switch to make when the selected channel is gone (back to Everything) or a pending one
    /// arrived.
    mutating func setChannels(_ list: [Channel]) -> ChannelSelection? {
        if let main = list.first(where: \.isMain) { mainChannelId = main.id }
        state.channels = list.filter { !$0.isMain && !$0.archived && !deleted.contains($0.id) }
        if var archived = state.archived {
            archived.removeAll { channel in state.channels.contains { $0.id == channel.id } }
            state.archived = archived
        }
        loaded = true
        if let selected = state.selectedChannelId, !state.channels.contains(where: { $0.id == selected }) {
            state.selectedChannelId = nil
            pendingSelection = nil
            return ChannelSelection(threadChannelId: mainChannelId, scope: nil)
        }
        if let pending = pendingSelection {
            pendingSelection = nil
            return select(pending)
        }
        return nil
    }

    /// GET /api/channels?archived=true.
    mutating func setArchived(_ list: [Channel]) {
        state.archived = list.filter { !$0.isMain && $0.archived && !deleted.contains($0.id) }
        state.archivedError = nil
    }

    /// Loading Archived starts (a Retry clears the old reason).
    mutating func beginArchived() {
        state.archivedError = nil
    }

    /// Loading Archived failed: a list already shown stays; with none, the grey reason + Retry.
    mutating func failArchived(reason: String) {
        if state.archived == nil { state.archivedError = reason }
    }

    /// A `channel` event, a POST /api/channels or PATCH answer: upsert; archiving moves it to the
    /// Archived list (when loaded) and, when it was selected, returns the switch to Everything.
    mutating func apply(_ channel: Channel) -> ChannelSelection? {
        if channel.isMain {
            mainChannelId = channel.id
            return nil
        }
        guard !deleted.contains(channel.id) else { return nil }
        if channel.archived {
            state.channels.removeAll { $0.id == channel.id }
            if var archived = state.archived {
                if let index = archived.firstIndex(where: { $0.id == channel.id }) {
                    archived[index] = channel
                } else {
                    archived.insert(channel, at: 0)
                }
                state.archived = archived
            }
            if state.selectedChannelId == channel.id {
                state.selectedChannelId = nil
                return ChannelSelection(threadChannelId: mainChannelId, scope: nil)
            }
            return nil
        }
        if let index = state.channels.firstIndex(where: { $0.id == channel.id }) {
            state.channels[index] = channel
        } else {
            state.channels.append(channel)
        }
        state.archived?.removeAll { $0.id == channel.id }
        if pendingSelection == channel.id {
            pendingSelection = nil
            return select(channel.id)
        }
        return nil
    }

    /// The thread's read receipt went out: the row's unread count drops at once (the server's
    /// next `channel` event or list agrees).
    mutating func markedRead(_ channelId: String, at date: Date) {
        guard let index = state.channels.firstIndex(where: { $0.id == channelId }) else { return }
        state.channels[index].unreadCount = 0
        state.channels[index].lastReadAt = date
    }

    // MARK: - M9

    /// Long-press Mark as read failed: the badge comes back as it was (unless the row changed).
    mutating func restoreUnread(_ before: Channel) {
        guard let index = state.channels.firstIndex(where: { $0.id == before.id }), state.channels[index].unreadCount == 0 else { return }
        state.channels[index].unreadCount = before.unreadCount
        state.channels[index].lastReadAt = before.lastReadAt
    }

    /// channel_deleted (or the DELETE answer): the row leaves the menu and the Archived list; a
    /// selected channel sends the chat back to Everything. Nil when nothing needs to switch.
    mutating func remove(_ channelId: String) -> ChannelSelection? {
        guard channelId != mainChannelId else { return nil }
        deleted.insert(channelId)
        state.channels.removeAll { $0.id == channelId }
        state.archived?.removeAll { $0.id == channelId }
        if pendingSelection == channelId { pendingSelection = nil }
        guard state.selectedChannelId == channelId else { return nil }
        state.selectedChannelId = nil
        return ChannelSelection(threadChannelId: mainChannelId, scope: nil)
    }

    /// A channel the menu knows (listed or archived), for Edit / Delete.
    func channel(_ id: String) -> Channel? {
        state.channels.first { $0.id == id } ?? state.archived?.first { $0.id == id }
    }
}

/// Channel threads the user moved away from while they still had unsent messages (waiting,
/// sending or failed). They keep taking events so the echoes reconcile; a parked thread is
/// restored when the user comes back to its channel. M16: the others (and a parked one once its
/// queue is out) go into `recent`, the small LRU of loaded threads, so a switch back shows the
/// thread at once instead of a skeleton and a full reload.
struct ParkedThreads: Sendable {
    private(set) var threads: [String: ThreadReducer] = [:]
    /// M16: recently left threads with nothing unsent (ThreadCache: ≤ 6, newest messages only).
    private(set) var recent = ThreadCache()

    /// The parked threads only (their unsent messages still go out); `recent` holds none.
    var channelIds: [String] { threads.keys.sorted() }

    /// Moves the chat from `current` to the thread of `channelId`: the old one is parked when it
    /// has unsent messages and cached otherwise; the new one is the parked thread of that
    /// channel, its cached thread, or a fresh one (which loads with the skeleton).
    mutating func switchThread(from current: ThreadReducer, to channelId: String) -> ThreadReducer {
        // The target comes out first: storing the old thread into a full cache would otherwise
        // evict the target when it is the least recent (Everything, 6 channels, Everything).
        var next = threads.removeValue(forKey: channelId) ?? recent.take(channelId) ?? ThreadReducer(channelId: channelId)
        // One thread per channel: whatever else was kept for it is stale now.
        recent.drop(channelId)
        if current.hasPending {
            threads[current.channelId] = current
            recent.drop(current.channelId)
        } else {
            recent.store(current)
        }
        next.adoptShared(from: current)
        return next
    }

    /// Every event also reaches the parked and the cached threads (each dedups by id on its own).
    mutating func apply(_ event: DuetEvent) {
        for id in Array(threads.keys) { threads[id]!.apply(event) }
        recent.apply(event)
    }

    /// M16: a channel the server no longer has (404): its cached thread goes; unsent messages stay.
    mutating func dropCached(_ channelId: String) {
        recent.drop(channelId)
    }

    func contains(_ channelId: String) -> Bool { threads[channelId] != nil }

    func pendingState(_ clientId: String, in channelId: String) -> PendingMessage.State? {
        threads[channelId]?.pendingState(clientId) ?? recent.pendingState(clientId, in: channelId)
    }

    /// ChatStore.updateThread for a channel that isn't on screen: its parked thread, else (M16)
    /// its cached one, so a late rollback (a failed Skip's restoreForm, a failed stop's
    /// resumeStop) still lands. A cached thread that gains unsent messages moves to the parked
    /// ones, whose queue goes out.
    mutating func update(_ channelId: String, _ body: (inout ThreadReducer) -> Void) {
        if threads[channelId] != nil {
            body(&threads[channelId]!)
        } else if recent.update(channelId, body), recent.hasPending(channelId) {
            threads[channelId] = recent.take(channelId)
        }
    }

    /// A parked thread whose queue has gone out stops being parked; M16: it moves to `recent`
    /// (when loaded), so coming back to it is still instant.
    mutating func prune() {
        for (id, thread) in threads where !thread.hasPending {
            threads[id] = nil
            recent.store(thread)
        }
    }

    /// M9: a deleted channel's parked (and cached) thread goes, unsent messages and all.
    mutating func drop(_ channelId: String) {
        threads[channelId] = nil
        recent.drop(channelId)
    }

    /// Sign-out / new session (ChatStore.teardown): parked and cached threads all go.
    mutating func removeAll() {
        threads = [:]
        recent.removeAll()
    }
}
