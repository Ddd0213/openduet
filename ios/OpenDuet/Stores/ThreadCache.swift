// M16: the channel threads the user left recently (Everything included), so switching back shows
// the thread at once: no skeleton, no full reload, the background refresh merges into it
// (ThreadReducer.applyRefreshedPage). A small LRU keyed by channel id; every cached thread keeps
// taking the live events, so it is current when it comes back. Bounded in threads and in
// messages per thread. Lives inside ParkedThreads (one per ChatStore, so a new session starts
// empty); Foundation + models only, so the Mac host tests drive it.
import Foundation

struct ThreadCache: Sendable {
    /// Threads kept besides the one on screen (Everything counts like any channel).
    static let defaultCapacity = 6
    /// Newest messages a cached thread keeps; older ones load again on scroll (hasMoreBefore).
    static let defaultMessageLimit = 200

    let capacity: Int
    let messageLimit: Int
    private var threads: [String: ThreadReducer] = [:]
    /// Least recently left first.
    private(set) var order: [String] = []

    init(capacity: Int = ThreadCache.defaultCapacity, messageLimit: Int = ThreadCache.defaultMessageLimit) {
        self.capacity = max(capacity, 0)
        self.messageLimit = max(messageLimit, 1)
    }

    var channelIds: [String] { order }
    var count: Int { order.count }

    func contains(_ channelId: String) -> Bool { threads[channelId] != nil }

    /// The thread the chat just left. Only a loaded channel thread is worth keeping (one that is
    /// still loading would only show the skeleton again); it becomes the most recent, and the
    /// least recent beyond `capacity` is dropped.
    mutating func store(_ reducer: ThreadReducer) {
        guard reducer.scope == .channel, reducer.thread.phase == .loaded, capacity > 0 else { return }
        var kept = reducer
        // Its loads were cancelled with the switch.
        kept.thread.loadingOlder = false
        trim(&kept)
        let id = kept.channelId
        threads[id] = kept
        order.removeAll { $0 == id }
        order.append(id)
        while order.count > capacity {
            threads[order.removeFirst()] = nil
        }
    }

    /// The cached thread of `channelId`, taken out (it goes back on screen); nil = none.
    mutating func take(_ channelId: String) -> ThreadReducer? {
        guard let reducer = threads.removeValue(forKey: channelId) else { return nil }
        order.removeAll { $0 == channelId }
        return reducer
    }

    /// Every live event reaches the cached threads too (each dedups by id and keeps only what
    /// it owns), so their messages, typing and status stay current while off screen. The
    /// message bound holds while they grow, not only when they are stored.
    mutating func apply(_ event: DuetEvent) {
        for id in order {
            guard threads[id]?.apply(event) == true else { continue }
            trim(&threads[id]!)
        }
    }

    /// Changes a cached thread in place (ChatStore.updateThread for a channel that isn't on
    /// screen: a failed Skip's restoreForm, a failed stop's resumeStop, a reaction's rollback),
    /// so the change isn't lost while the thread is cached. False when it isn't cached. Its place
    /// in the LRU stays: it wasn't on screen.
    @discardableResult
    mutating func update(_ channelId: String, _ body: (inout ThreadReducer) -> Void) -> Bool {
        guard threads[channelId] != nil else { return false }
        body(&threads[channelId]!)
        trim(&threads[channelId]!)
        return true
    }

    func pendingState(_ clientId: String, in channelId: String) -> PendingMessage.State? {
        threads[channelId]?.pendingState(clientId)
    }

    /// A cached thread got unsent messages (ParkedThreads then parks it, so they go out).
    func hasPending(_ channelId: String) -> Bool { threads[channelId]?.hasPending == true }

    /// The newest `messageLimit` messages only; the cut-off ones load again on scroll.
    private func trim(_ reducer: inout ThreadReducer) {
        let extra = reducer.thread.messages.count - messageLimit
        guard extra > 0 else { return }
        reducer.thread.messages.removeFirst(extra)
        reducer.thread.hasMoreBefore = true
    }

    mutating func drop(_ channelId: String) {
        threads[channelId] = nil
        order.removeAll { $0 == channelId }
    }

    /// Sign-out / new session: nothing of the old threads stays in memory.
    mutating func removeAll() {
        threads = [:]
        order = []
    }
}
