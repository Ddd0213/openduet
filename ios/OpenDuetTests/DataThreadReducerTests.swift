// ThreadReducer: event upserts, pending reconciliation by clientId, dedup by event id
// (both streams and the Last-Event-ID catch-up), the offline queue's order, live status.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Thread reducer")
struct DataThreadReducerTests {
    private func ids(_ reducer: ThreadReducer) -> [String] { reducer.thread.messages.map(\.id) }

    @Test("message events upsert by id in createdAt order; an older version never wins")
    func upsert() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(Fx.messageEvent(1, Fx.messageJSON("m2", at: 20, text: "second")))
        reducer.apply(Fx.messageEvent(2, Fx.messageJSON("m1", at: 10, text: "first")))
        reducer.apply(Fx.messageEvent(3, Fx.messageJSON("m3", at: 30)))
        #expect(ids(reducer) == ["m1", "m2", "m3"])

        reducer.apply(Fx.messageEvent(4, Fx.messageJSON("m2", at: 20, text: "edited", updated: 40)))
        #expect(ids(reducer) == ["m1", "m2", "m3"])
        #expect(reducer.thread.messages[1].text == "edited")

        reducer.apply(Fx.messageEvent(5, Fx.messageJSON("m2", at: 20, text: "stale", updated: 25)))
        #expect(reducer.thread.messages[1].text == "edited")
    }

    @Test("message_deleted removes the message")
    func deleted() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(Fx.messageEvent(1, Fx.messageJSON("m1", at: 10)))
        reducer.apply(Fx.messageEvent(2, Fx.messageJSON("m2", at: 20)))
        reducer.apply(Fx.deleted(3, "m1"))
        #expect(ids(reducer) == ["m2"])
    }

    @Test("The echoed message replaces its PendingMessage (same clientId); others stay")
    func pendingReconciled() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.enqueue(Fx.pending("c1", "hello"))
        reducer.enqueue(Fx.pending("c2", "again"))
        let sending = reducer.nextToSend()
        #expect(sending?.clientId == "c1")
        reducer.apply(Fx.messageEvent(1, Fx.messageJSON("m1", at: 10, text: "hello", role: "user", clientId: "c1")))
        #expect(reducer.thread.pending.map(\.clientId) == ["c2"])
        #expect(ids(reducer) == ["m1"])
        #expect(!reducer.isPending("c1"))
    }

    @Test("The same event from both streams applies once")
    func dedupAcrossStreams() {
        var reducer = ThreadReducer(channelId: Fx.main)
        let echo = Fx.messageEvent(104, Fx.messageJSON("m1", at: 10, role: "user", clientId: "c1"))
        let first = reducer.apply(echo)
        reducer.apply(Fx.deleted(105, "m1"))
        // The overlapping copy from GET /api/events arrives after the delete: still gone.
        let second = reducer.apply(echo)
        #expect(first)
        #expect(!second)
        #expect(ids(reducer).isEmpty)
    }

    @Test("A Last-Event-ID catch-up that replays events adds nothing twice")
    func replayAddsNothingTwice() {
        var reducer = ThreadReducer(channelId: Fx.main)
        let events = [
            Fx.messageEvent(1, Fx.messageJSON("m1", at: 10)),
            Fx.status(2, run: "r1", "checking"),
            Fx.messageEvent(3, Fx.messageJSON("m2", at: 20)),
            Fx.done(4, run: "r1"),
        ]
        events.forEach { reducer.apply($0) }
        // Reconnect: the server replays from an older id, overlapping what we have.
        let applied = (events + [Fx.messageEvent(5, Fx.messageJSON("m3", at: 30))]).filter { reducer.apply($0) }
        #expect(applied.map(\.id) == [5])
        #expect(ids(reducer) == ["m1", "m2", "m3"])
        #expect(reducer.status == nil)

        // A fresh reducer (app relaunched, no seen ids) still keeps one copy per message id.
        var fresh = ThreadReducer(channelId: Fx.main)
        fresh.applyFirstPage(Fx.page([Fx.message("m1", at: 10), Fx.message("m2", at: 20)]))
        (events + events).forEach { fresh.apply($0) }
        #expect(ids(fresh) == ["m1", "m2"])
    }

    @Test("The offline queue sends one at a time, in order; failures can be retried")
    func offlineQueueOrder() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.enqueue(Fx.pending("a", at: 1))
        reducer.enqueue(Fx.pending("b", at: 2))
        reducer.enqueue(Fx.pending("c", at: 3))

        var next = reducer.nextToSend()
        #expect(next?.clientId == "a")
        next = reducer.nextToSend()
        #expect(next == nil, "nothing else goes while one is sending")

        // Still offline: back to waiting, and it stays first.
        reducer.setPending("a", .waiting)
        #expect(reducer.thread.pending.map(\.state) == [.waiting, .waiting, .waiting])
        next = reducer.nextToSend()
        #expect(next?.clientId == "a")

        // Accepted (echo), then b is rejected (usage limit), then c goes.
        reducer.apply(Fx.messageEvent(1, Fx.messageJSON("m-a", at: 10, role: "user", clientId: "a")))
        next = reducer.nextToSend()
        #expect(next?.clientId == "b")
        reducer.setPending("b", .failed)
        next = reducer.nextToSend()
        #expect(next?.clientId == "c")
        reducer.apply(Fx.messageEvent(2, Fx.messageJSON("m-c", at: 11, role: "user", clientId: "c")))

        // Retry b: waiting again, then sent.
        #expect(reducer.pendingState("b") == .failed)
        reducer.setPending("b", .waiting)
        next = reducer.nextToSend()
        #expect(next?.clientId == "b")
        reducer.apply(Fx.messageEvent(3, Fx.messageJSON("m-b", at: 12, role: "user", clientId: "b")))
        #expect(reducer.thread.pending.isEmpty)
        #expect(ids(reducer) == ["m-a", "m-c", "m-b"])
    }

    @Test("Retry sends a failed message again as the newest: new time, after what is queued")
    func retryMovesToTheEnd() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.enqueue(Fx.pending("a", at: 1))
        reducer.enqueue(Fx.pending("b", at: 2))
        _ = reducer.nextToSend()
        reducer.setPending("a", .failed)
        let now = Fx.date(50)
        reducer.retry("a", at: now)
        #expect(reducer.thread.pending.map(\.clientId) == ["b", "a"])
        #expect(reducer.thread.pending.map(\.state) == [.waiting, .waiting])
        #expect(reducer.thread.pending.last?.createdAt == now)
        // Only a failed message is retried.
        reducer.retry("b", at: Fx.date(60))
        #expect(reducer.thread.pending.first?.createdAt == Fx.date(2))
    }

    @Test("status drives the pill; checking / reading_now also show the status bubble; done clears")
    func status() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(Fx.status(1, run: "r1", "thinking"))
        #expect(reducer.status == .thinking)
        #expect(reducer.thread.statusBubble == nil)

        reducer.apply(Fx.status(2, run: "r1", "checking"))
        #expect(reducer.status == .checking)
        #expect(reducer.thread.statusBubble == .checking)

        reducer.apply(Fx.status(3, run: "r1", "reading_now"))
        #expect(reducer.thread.statusBubble == .readingNow)

        reducer.apply(Fx.typing(4, run: "r1", true))
        #expect(reducer.thread.typing)

        reducer.apply(Fx.done(5, run: "r1"))
        #expect(reducer.status == nil)
        #expect(reducer.thread.statusBubble == nil)
        #expect(!reducer.thread.typing)
    }

    @Test("Overlapping runs: the newest busy run shows; done ends its run and older ones")
    func overlappingRuns() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(Fx.status(1, run: "r1", "searching_web"))
        reducer.apply(Fx.status(2, run: "r2", "writing_draft"))
        #expect(reducer.status == .writingDraft)
        reducer.apply(Fx.status(3, run: "r2", nil))
        #expect(reducer.status == .searchingWeb)
        reducer.apply(Fx.status(4, run: "r2", "working"))
        reducer.apply(Fx.done(5, run: "r1"))
        #expect(reducer.status == .working, "an older run's done leaves the newer run busy")
        reducer.apply(Fx.done(6, run: "r2"))
        #expect(reducer.status == nil)
    }

    @Test("Task runs, other channels and task-session messages stay out of the main thread")
    func scoping() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(Fx.status(1, run: "t1", "working", taskId: "task_1"))
        reducer.apply(Fx.event(2, "status", channel: "ch_other", ["runId": "o1", "taskId": NSNull(), "status": "thinking"]))
        reducer.apply(Fx.messageEvent(3, Fx.messageJSON("x1", at: 10, channel: "ch_other")))
        reducer.apply(Fx.messageEvent(4, Fx.messageJSON("x2", at: 11, taskId: "task_1")))
        #expect(reducer.status == nil)
        #expect(ids(reducer).isEmpty)
    }

    @Test("The first page keeps messages that arrived live after it was read and reconciles pending")
    func firstPageMerge() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.enqueue(Fx.pending("c1"))
        reducer.apply(Fx.messageEvent(1, Fx.messageJSON("m3", at: 30, text: "live")))
        reducer.apply(Fx.messageEvent(2, Fx.messageJSON("m2", at: 20, text: "newer", updated: 50)))
        reducer.applyFirstPage(Fx.page([
            Fx.message("m1", at: 10),
            Fx.message("m2", at: 20, text: "page copy", updated: 20),
            Fx.message("mu", at: 25, role: "user", clientId: "c1"),
        ], hasMore: true))
        #expect(ids(reducer) == ["m1", "m2", "mu", "m3"])
        #expect(reducer.thread.messages[1].text == "newer")
        #expect(reducer.thread.pending.isEmpty)
        #expect(reducer.thread.hasMoreBefore)
        #expect(reducer.thread.phase == .loaded)
    }

    @Test("Older pages prepend without duplicates")
    func olderPage() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.applyFirstPage(Fx.page([Fx.message("m3", at: 30), Fx.message("m4", at: 40)], hasMore: true))
        reducer.thread.loadingOlder = true
        reducer.applyOlderPage(Fx.page([Fx.message("m1", at: 10), Fx.message("m2", at: 20), Fx.message("m3", at: 30)]))
        #expect(ids(reducer) == ["m1", "m2", "m3", "m4"])
        #expect(!reducer.thread.hasMoreBefore)
        #expect(!reducer.thread.loadingOlder)
    }

    @Test("Unread channels: open non-main channels with unread messages; channel events update it")
    func unread() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.setChannels([
            Fx.decode(Channel.self, Fx.channel(Fx.main, isMain: true, unread: 3)),
            Fx.decode(Channel.self, Fx.channel("ch_a", unread: 2)),
            Fx.decode(Channel.self, Fx.channel("ch_b")),
            Fx.decode(Channel.self, Fx.channel("ch_old", unread: 5, archived: true)),
        ])
        #expect(reducer.unreadChannels == 1)
        reducer.apply(Fx.event(1, "channel", channel: "ch_b", ["channel": Fx.channel("ch_b", unread: 1)]))
        #expect(reducer.unreadChannels == 2)
    }

    @Test("The dedup window forgets the oldest ids past its limit")
    func seenWindow() {
        var small = ThreadReducer(channelId: Fx.main, seenLimit: 3)
        for id in 1...5 { small.apply(Fx.deleted(Int64(id), "none")) }
        let recent = small.apply(Fx.deleted(5, "none"))
        let forgotten = small.apply(Fx.deleted(1, "none"))
        #expect(!recent)
        #expect(forgotten)
    }
}
