// M16: switching channels (ThreadCache inside ParkedThreads). Recently left threads come back at
// once (loaded: no skeleton) and the refreshed page merges into them; the cache is an LRU of
// ≤ 6, keeps each channel's own messages, trims long threads, takes in drained parked threads and
// empties on sign-out / a new session.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Thread cache")
struct DataThreadCacheTests {
    /// A loaded thread of `channel` with these messages (seconds after the fixtures' base).
    private func loaded(_ channel: String, _ messages: [(String, Int)], hasMore: Bool = false) -> ThreadReducer {
        var reducer = ThreadReducer(channelId: channel)
        reducer.applyFirstPage(Fx.page(messages.map { Fx.message($0.0, at: $0.1, channel: channel) }, hasMore: hasMore))
        return reducer
    }

    private func ids(_ reducer: ThreadReducer?) -> [String] { reducer?.thread.messages.map(\.id) ?? [] }

    // MARK: - LRU

    @Test("LRU: past the capacity the least recently left thread goes; leaving one again makes it the newest")
    func eviction() {
        var cache = ThreadCache(capacity: 3)
        for id in ["a", "b", "c"] { cache.store(loaded(id, [("\(id)1", 1)])) }
        #expect(cache.channelIds == ["a", "b", "c"])
        cache.store(loaded("a", [("a1", 1)]))
        #expect(cache.channelIds == ["b", "c", "a"])
        cache.store(loaded("d", [("d1", 1)]))
        #expect(cache.channelIds == ["c", "a", "d"])
        #expect(!cache.contains("b"))
        let gone = cache.take("b")
        #expect(gone?.channelId == nil)
        // A task session's thread is never kept here.
        var task = ThreadReducer(taskId: "t1")
        task.applyFirstPage(Fx.page([]))
        cache.store(task)
        #expect(cache.count == 3)
    }

    @Test("switching through more channels than it holds keeps 6, Everything counted like any channel")
    func boundedThroughSwitches() {
        var parked = ParkedThreads()
        var current = loaded(Fx.main, [("m1", 1)])
        for index in 0..<9 {
            current = parked.switchThread(from: current, to: "c\(index)")
            current.applyFirstPage(Fx.page([Fx.message("c\(index)-1", at: 1, channel: "c\(index)")]))
        }
        #expect(ThreadCache.defaultCapacity == 6)
        #expect(parked.recent.count == 6)
        #expect(parked.recent.channelIds == ["c2", "c3", "c4", "c5", "c6", "c7"])
        #expect(!parked.recent.contains(Fx.main))
        #expect(parked.channelIds.isEmpty)
    }

    @Test("a long thread is cached with its newest messages only; the rest loads again on scroll")
    func trims() {
        var cache = ThreadCache(capacity: 2, messageLimit: 2)
        var long = loaded("a", [("a1", 1), ("a2", 2), ("a3", 3)])
        long.thread.loadingOlder = true
        cache.store(long)
        let back = cache.take("a")
        #expect(ids(back) == ["a2", "a3"])
        #expect(back?.thread.hasMoreBefore == true)
        #expect(back?.thread.loadingOlder == false)
        #expect(cache.count == 0)
    }

    // MARK: - Switching

    @Test("a switch back shows the cached thread at once (loaded: no skeleton) with what arrived meanwhile")
    func instantBack() {
        var parked = ParkedThreads()
        var main = loaded(Fx.main, [("m1", 1), ("m2", 2)])
        main.setChannels([Fx.chan(Fx.main, isMain: true), Fx.chan("a")])
        var a = parked.switchThread(from: main, to: "a")
        // Never loaded this session: the skeleton.
        #expect(a.thread.phase == .loading)
        a.applyFirstPage(Fx.page([Fx.message("a1", at: 1, channel: "a")]))
        // A reply in Everything while the user reads #a.
        let reply = Fx.messageEvent(3, Fx.messageJSON("m3", at: 3, channel: Fx.main))
        a.apply(reply)
        parked.apply(reply)
        #expect(ids(a) == ["a1"])

        let back = parked.switchThread(from: a, to: Fx.main)
        #expect(back.channelId == Fx.main)
        #expect(back.thread.phase == .loaded)
        #expect(ids(back) == ["m1", "m2", "m3"])
        #expect(back.channels.count == 2)
        #expect(parked.recent.channelIds == ["a"])
    }

    @Test("each channel keeps its own messages and typing; nothing crosses into another thread")
    func isolation() {
        var parked = ParkedThreads()
        var main = loaded(Fx.main, [("m1", 1)])
        var a = parked.switchThread(from: main, to: "a")
        a.applyFirstPage(Fx.page([Fx.message("a1", at: 1, channel: "a")]))
        var b = parked.switchThread(from: a, to: "b")
        b.applyFirstPage(Fx.page([Fx.message("b1", at: 1, channel: "b")]))
        // Live events while #b is on screen: a message per channel, and OpenDuet typing in Everything.
        let events = [
            Fx.messageEvent(10, Fx.messageJSON("a2", at: 10, channel: "a")),
            Fx.messageEvent(11, Fx.messageJSON("m2", at: 11, channel: Fx.main)),
            Fx.messageEvent(12, Fx.messageJSON("b2", at: 12, channel: "b")),
            Fx.typing(13, run: "r1", true),
        ]
        for event in events {
            b.apply(event)
            parked.apply(event)
        }
        #expect(ids(b) == ["b1", "b2"])
        #expect(!b.thread.typing)

        main = parked.switchThread(from: b, to: Fx.main)
        #expect(ids(main) == ["m1", "m2"])
        #expect(main.thread.typing)
        a = parked.switchThread(from: main, to: "a")
        #expect(ids(a) == ["a1", "a2"])
        #expect(!a.thread.typing)
        #expect(parked.recent.channelIds == ["b", Fx.main])
    }

    @Test("a thread left before its first page isn't kept; coming back loads it with the skeleton")
    func loadingNotCached() {
        var parked = ParkedThreads()
        let main = loaded(Fx.main, [("m1", 1)])
        let a = parked.switchThread(from: main, to: "a")
        let back = parked.switchThread(from: a, to: Fx.main)
        #expect(!parked.recent.contains("a"))
        let again = parked.switchThread(from: back, to: "a")
        #expect(again.thread.phase == .loading)
        #expect(again.thread.messages.isEmpty)
    }

    @Test("a parked thread whose queue went out moves to the cache; a deleted channel's thread goes")
    func pruneAndDrop() {
        var parked = ParkedThreads()
        var a = loaded("a", [("a1", 1)])
        a.enqueue(Fx.pending("c1"))
        var b = parked.switchThread(from: a, to: "b")
        #expect(parked.channelIds == ["a"])
        #expect(!parked.recent.contains("a"))

        let echo = Fx.messageEvent(5, Fx.messageJSON("a2", at: 5, role: "user", channel: "a", clientId: "c1"))
        b.apply(echo)
        parked.apply(echo)
        parked.prune()
        #expect(parked.channelIds.isEmpty)
        #expect(parked.recent.channelIds == ["a"])

        b.applyFirstPage(Fx.page([]))
        let back = parked.switchThread(from: b, to: "a")
        #expect(ids(back) == ["a1", "a2"])
        #expect(back.thread.pending.isEmpty)
        #expect(parked.recent.channelIds == ["b"])
        parked.drop("b")
        #expect(parked.recent.count == 0)
    }

    // MARK: - Cached, then merged

    @Test("the refreshed page merges: older pages stay, newer versions win, messages gone from its span go")
    func refreshMerges() {
        // On screen: an older page (o1), the newest page (m2...m4) and a live m6.
        var thread = loaded(Fx.main, [("m2", 2), ("m3", 3), ("m4", 4)], hasMore: true)
        thread.applyOlderPage(Fx.page([Fx.message("o1", at: 1)], hasMore: true))
        thread.apply(Fx.messageEvent(20, Fx.messageJSON("m6", at: 6)))
        // A local copy of m4 newer than the page's (a decision written in meanwhile).
        thread.upsert(Fx.message("m4", at: 4, text: "decided", updated: 9))
        // The server's newest page now: m3 was deleted, m5 is new.
        thread.applyRefreshedPage(Fx.page([Fx.message("m2", at: 2), Fx.message("m4", at: 4), Fx.message("m5", at: 5)], hasMore: true))
        #expect(ids(thread) == ["o1", "m2", "m4", "m5", "m6"])
        #expect(thread.thread.messages.first { $0.id == "m4" }?.text == "decided")
        #expect(thread.thread.hasMoreBefore)
        #expect(thread.thread.phase == .loaded)
    }

    @Test("a page that doesn't reach back to the cached messages replaces them (no hole); a page with no more history is the whole thread")
    func refreshGapAndWhole() {
        var stale = loaded(Fx.main, [("m1", 1), ("m2", 2)], hasMore: true)
        stale.applyRefreshedPage(Fx.page([Fx.message("m8", at: 8), Fx.message("m9", at: 9)], hasMore: true))
        #expect(ids(stale) == ["m8", "m9"])
        #expect(stale.thread.hasMoreBefore)

        var whole = loaded(Fx.main, [("m1", 1), ("m2", 2)])
        whole.applyRefreshedPage(Fx.page([Fx.message("m2", at: 2), Fx.message("m3", at: 3)]))
        #expect(ids(whole) == ["m2", "m3"])
        #expect(!whole.thread.hasMoreBefore)

        // Before the first load it is the first load.
        var fresh = ThreadReducer(channelId: Fx.main)
        fresh.applyRefreshedPage(Fx.page([Fx.message("m1", at: 1)]))
        #expect(fresh.thread.phase == .loaded)
        #expect(ids(fresh) == ["m1"])
    }

    // MARK: - Reset

    @Test("sign-out / a new session empties it: no thread of the old session comes back")
    func reset() {
        var parked = ParkedThreads()
        var current = loaded(Fx.main, [("m1", 1)])
        current = parked.switchThread(from: current, to: "a")
        current.applyFirstPage(Fx.page([Fx.message("a1", at: 1, channel: "a")]))
        current.enqueue(Fx.pending("c1"))
        current = parked.switchThread(from: current, to: "b")
        #expect(parked.recent.channelIds == [Fx.main])
        #expect(parked.channelIds == ["a"])

        parked.removeAll()
        #expect(parked.recent.count == 0)
        #expect(parked.channelIds.isEmpty)
        let main = parked.switchThread(from: current, to: Fx.main)
        #expect(main.thread.phase == .loading)
        #expect(main.thread.messages.isEmpty)

        var cache = ThreadCache()
        cache.store(loaded("x", [("x1", 1)]))
        cache.removeAll()
        #expect(!cache.contains("x"))
        #expect(cache.channelIds.isEmpty)
    }
}

/// M16 review fixes: late rollbacks reach a cached thread, a full cache doesn't evict the target,
/// ties at the refreshed page's edges stay, live growth stays bounded.
@Suite("Thread cache: review fixes")
struct DataThreadCacheReviewTests {
    private func loaded(_ channel: String, _ messages: [(String, Int)], hasMore: Bool = false) -> ThreadReducer {
        var reducer = ThreadReducer(channelId: channel)
        reducer.applyFirstPage(Fx.page(messages.map { Fx.message($0.0, at: $0.1, channel: channel) }, hasMore: hasMore))
        return reducer
    }

    private func ids(_ reducer: ThreadReducer?) -> [String] { reducer?.thread.messages.map(\.id) ?? [] }

    /// A form card in the main thread (the M9 fixture's shape).
    private static func formJSON(_ id: String = "msg_f", updated: Int = 10) -> [String: Any] {
        Fx.cardJSON(id, at: 10, kind: "form", payload: [
            "title": "Reply length", "description": NSNull(), "icon": "chat", "submitLabel": NSNull(),
            "state": "open", "answers": NSNull(),
            "fields": [[
                "id": "f_len", "type": "single", "label": "How long?", "required": true, "allowOther": false,
                "options": [["id": "o_short", "label": "Short", "detail": NSNull()]],
            ]],
        ], updated: updated)
    }

    private func formState(_ reducer: ThreadReducer, _ id: String = "msg_f") -> FormPayload.State? {
        if case .form(let payload)? = reducer.thread.messages.first(where: { $0.id == id })?.content { payload.state } else { nil }
    }

    @Test("skip fails after a switch: the rollback reaches the cached thread, and the refresh keeps it open")
    func skipFailsAfterSwitch() {
        var parked = ParkedThreads()
        var main = loaded(Fx.main, [("m1", 1)])
        main.apply(Fx.messageEvent(20, Self.formJSON()))
        // Skip shows at once, then the user switches channel before the answer.
        let before = main.setFormState("msg_f", .dismissed, answers: nil)
        #expect(before != nil)
        var other = parked.switchThread(from: main, to: "a")
        #expect(parked.recent.contains(Fx.main))
        #expect(parked.channelIds.isEmpty)
        other.applyFirstPage(Fx.page([]))

        // The skip fails: ChatStore.updateThread(.channel(main)) -> ParkedThreads.update.
        if let before { parked.update(Fx.main) { $0.restoreForm("msg_f", before) } }
        let back = parked.switchThread(from: other, to: Fx.main)
        #expect(formState(back) == .open)

        // loadThreadPage's refresh: the server still has it open, at the same updatedAt.
        var refreshed = back
        refreshed.applyRefreshedPage(Fx.page([Fx.message("m1", at: 1), Fx.decode(Message.self, Self.formJSON())], hasMore: true))
        #expect(formState(refreshed) == .open)
        #expect(ids(refreshed) == ["m1", "msg_f"])
    }

    @Test("skip still in flight when switching back: the refresh doesn't reopen the card")
    func skipInFlightAcrossRefresh() {
        var parked = ParkedThreads()
        var main = loaded(Fx.main, [("m1", 1)])
        main.apply(Fx.messageEvent(20, Self.formJSON()))
        _ = main.setFormState("msg_f", .dismissed, answers: nil)
        var other = parked.switchThread(from: main, to: "a")
        other.applyFirstPage(Fx.page([]))
        var back = parked.switchThread(from: other, to: Fx.main)
        back.applyRefreshedPage(Fx.page([Fx.message("m1", at: 1), Fx.decode(Message.self, Self.formJSON())], hasMore: true))
        #expect(formState(back) == .dismissed)
    }

    @Test("stop fails after a switch: resumeStop reaches the cached thread, so typing and status show again")
    func stopFailsAfterSwitch() {
        var parked = ParkedThreads()
        var main = loaded(Fx.main, [("m1", 1)])
        main.apply(Fx.typing(30, run: "r1", true))
        main.apply(Fx.status(31, run: "r1", "checking_memory"))
        let hidden = main.beginStop()
        #expect(hidden == ["r1"])
        #expect(!main.isReplying)

        var other = parked.switchThread(from: main, to: "a")
        other.applyFirstPage(Fx.page([]))
        // The stop fails: ChatStore+Stop -> updateThread(.channel(main)) -> ParkedThreads.update.
        parked.update(Fx.main) { $0.resumeStop(hidden) }
        let back = parked.switchThread(from: other, to: Fx.main)
        #expect(back.thread.typing)
        #expect(back.status == .checkingMemory)
        #expect(back.isReplying)
    }

    @Test("a cached thread that gains unsent messages is parked, so its queue goes out")
    func updateParksPending() {
        var parked = ParkedThreads()
        let main = loaded(Fx.main, [("m1", 1)])
        var other = parked.switchThread(from: main, to: "a")
        other.applyFirstPage(Fx.page([]))
        parked.update(Fx.main) { $0.enqueue(Fx.pending("c1")) }
        #expect(parked.channelIds == [Fx.main])
        #expect(!parked.recent.contains(Fx.main))
        #expect(parked.pendingState("c1", in: Fx.main) == .waiting)
        // A channel kept nowhere takes no update.
        parked.update("zzz") { $0.enqueue(Fx.pending("c2")) }
        #expect(parked.channelIds == [Fx.main])
    }

    @Test("a full cache: Everything, then 6 channels, then Everything again comes back from the cache")
    func fullCacheKeepsTarget() {
        var parked = ParkedThreads()
        var current = loaded(Fx.main, [("m1", 1)])
        for index in 1...6 {
            current = parked.switchThread(from: current, to: "c\(index)")
            current.applyFirstPage(Fx.page([Fx.message("c\(index)-1", at: 1, channel: "c\(index)")]))
        }
        #expect(parked.recent.channelIds == [Fx.main, "c1", "c2", "c3", "c4", "c5"])
        let back = parked.switchThread(from: current, to: Fx.main)
        #expect(back.thread.phase == .loaded)
        #expect(ids(back) == ["m1"])
        #expect(parked.recent.channelIds == ["c1", "c2", "c3", "c4", "c5", "c6"])
    }

    @Test("ties at the refreshed page's edges stay; what lies strictly inside its span and is missing goes")
    func refreshKeepsEdgeTies() {
        // Cached: t2 (oldest tie), p3 and gone (inside), p5 and t5 (newest tie), live l6.
        var thread = loaded(Fx.main, [("t2", 2), ("p2", 2), ("p3", 3), ("gone", 4), ("p5", 5), ("t5", 5)], hasMore: true)
        thread.apply(Fx.messageEvent(40, Fx.messageJSON("l6", at: 6)))
        // The server's newest page starts at p2 and ends at p5 (t2 and t5 sit just outside it).
        thread.applyRefreshedPage(Fx.page([Fx.message("p2", at: 2), Fx.message("p3", at: 3), Fx.message("p5", at: 5)], hasMore: true))
        #expect(ids(thread) == ["t2", "p2", "p3", "p5", "t5", "l6"])
    }

    @Test("live events keep a cached thread within its message bound; hasMoreBefore follows")
    func liveGrowthTrims() {
        var cache = ThreadCache(capacity: 2, messageLimit: 2)
        cache.store(loaded("a", [("a1", 1), ("a2", 2)]))
        cache.store(loaded("b", [("b1", 1)]))
        cache.apply(Fx.messageEvent(50, Fx.messageJSON("a3", at: 3, channel: "a")))
        cache.apply(Fx.messageEvent(51, Fx.messageJSON("a4", at: 4, channel: "a")))
        let updated = cache.update("b") { $0.upsert(Fx.message("b2", at: 2, channel: "b")) }
        #expect(updated)
        let a = cache.take("a")
        #expect(ids(a) == ["a3", "a4"])
        #expect(a?.thread.hasMoreBefore == true)
        let b = cache.take("b")
        #expect(ids(b) == ["b1", "b2"])
        #expect(b?.thread.hasMoreBefore == false)
    }
}
