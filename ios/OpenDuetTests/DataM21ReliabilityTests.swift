// M21 W4 reliability (plan §4 M21 W4, review #11 #14 #16 C19): a `done` ends only its own kind's
// runs (a Make build's done leaves the chat's dots and Stop), a page's activeRun brings a running
// turn back after a cold start, `resync` forgets the runs and the ids seen, opening a channel
// zeroes its count and the selected row shows none, when a read receipt goes out, the viewer's
// edit / refresh status, and the task reply's attachments.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M21 reliability")
struct DataM21ReliabilityTests {
    // MARK: Fixtures

    private func typing(_ id: Int64, run: String, _ on: Bool, kind: String?) -> DuetEvent {
        Fx.event(id, "typing", ["runId": run, "taskId": NSNull(), "kind": kind ?? NSNull(), "typing": on])
    }

    private func status(_ id: Int64, run: String, _ key: String?, kind: String?) -> DuetEvent {
        Fx.event(id, "status", ["runId": run, "taskId": NSNull(), "kind": kind ?? NSNull(), "status": key ?? NSNull()])
    }

    private func done(_ id: Int64, run: String, kind: String?) -> DuetEvent {
        Fx.event(id, "done", ["runId": run, "taskId": NSNull(), "kind": kind ?? NSNull(), "status": "completed", "error": NSNull()])
    }

    private func resync(_ id: Int64) -> DuetEvent {
        Fx.event(id, "resync", channel: nil, ["reason": "replay_limit"])
    }

    private func active(_ run: String, _ kind: RunKind = .chat) -> ActiveRun {
        ActiveRun(runId: run, kind: kind, startedAt: Fx.date(0))
    }

    // MARK: endRun per kind (review #11)

    @Test("A build's done leaves the chat turn's dots, status and Stop")
    func buildDoneKeepsChat() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(status(1, run: "chat1", "checking_memory", kind: "chat"))
        reducer.apply(typing(2, run: "chat1", true, kind: "chat"))
        reducer.apply(status(3, run: "build1", "working", kind: "build"))
        reducer.apply(done(4, run: "build1", kind: "build"))
        #expect(reducer.thread.typing)
        #expect(reducer.status == .checkingMemory)
        #expect(reducer.isReplying)

        reducer.apply(done(5, run: "chat1", kind: "chat"))
        #expect(!reducer.thread.typing)
        #expect(!reducer.isReplying)
    }

    @Test("A done for a run never seen clears only its own kind; an old run without a kind goes too")
    func unseenDoneSameKind() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(typing(1, run: "chat1", true, kind: "chat"))
        reducer.apply(typing(2, run: "old", true, kind: nil))
        reducer.apply(done(3, run: "build9", kind: "build"))
        #expect(reducer.thread.typing, "the chat run stays")
        reducer.apply(done(4, run: "chat1", kind: "chat"))
        #expect(!reducer.thread.typing, "the run without a kind went with the build's done")
    }

    @Test("A done without a kind ends as before (older ones and, unseen, everything)")
    func nilKindDone() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(typing(1, run: "chat1", true, kind: "chat"))
        reducer.apply(status(2, run: "build1", "working", kind: "build"))
        reducer.apply(Fx.done(3, run: "never-seen"))
        #expect(!reducer.isReplying)
    }

    @Test("A done without a kind uses the kind its run's earlier events gave")
    func doneTakesKnownKind() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(typing(1, run: "chat1", true, kind: "chat"))
        reducer.apply(status(2, run: "build1", "working", kind: "build"))
        reducer.apply(Fx.done(3, run: "build1"))
        #expect(reducer.thread.typing)
        #expect(reducer.status == nil)
    }

    @Test("A done ends older runs of its kind whose done was lost, not older ones of another kind")
    func olderSameKindEnds() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(status(1, run: "chat0", "thinking", kind: "chat"))
        reducer.apply(status(2, run: "build1", "working", kind: "build"))
        reducer.apply(status(3, run: "chat1", "checking_memory", kind: "chat"))
        reducer.apply(done(4, run: "chat1", kind: "chat"))
        #expect(reducer.status == .working, "the build is still going")
        reducer.apply(done(5, run: "build1", kind: "build"))
        #expect(reducer.status == nil, "chat0 ended with chat1's done")
    }

    // MARK: activeRun (cold start)

    @Test("A first page's activeRun shows the dots and Stop until its done")
    func activeRunRestores() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.applyFirstPage(MessagePage(messages: [Fx.message("m1", at: 1)], hasMore: false, activeRun: active("r1")))
        #expect(reducer.thread.typing)
        #expect(reducer.isReplying)
        #expect(reducer.beginStop() == ["r1"])
        reducer.resumeStop(["r1"])
        #expect(reducer.thread.typing)

        reducer.apply(done(1, run: "r1", kind: "chat"))
        #expect(!reducer.isReplying)
        // A page read before that done doesn't bring the finished turn back.
        reducer.applyFirstPage(MessagePage(messages: [Fx.message("m1", at: 1)], hasMore: false, activeRun: active("r1")))
        #expect(!reducer.thread.typing)
    }

    @Test("activeRun keeps what live events said; none on a page changes nothing")
    func activeRunKnown() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(status(1, run: "r1", "searching_web", kind: "chat"))
        let known = reducer.restoreActiveRun(active("r1"))
        #expect(!known)
        #expect(reducer.status == .searchingWeb)
        #expect(!reducer.thread.typing)
        let none = reducer.restoreActiveRun(nil)
        #expect(!none)
    }

    @Test("A build's done leaves a restored chat turn alone")
    func restoredKeepsKind() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.applyFirstPage(MessagePage(messages: [], hasMore: false, activeRun: active("r1", .chat)))
        reducer.apply(done(1, run: "b1", kind: "build"))
        #expect(reducer.thread.typing)
    }

    @Test("A task session doesn't take a channel page's activeRun")
    func taskScopeIgnoresActiveRun() {
        var reducer = ThreadReducer(taskId: "t1")
        let restored = reducer.restoreActiveRun(active("r1", .task))
        #expect(!restored)
        #expect(!reducer.thread.typing)
    }

    @Test("A refreshed page with only a new activeRun reports a change")
    func refreshedPageChanged() {
        var reducer = ThreadReducer(channelId: Fx.main)
        let messages = [Fx.message("m1", at: 1), Fx.message("m2", at: 2)]
        reducer.applyFirstPage(MessagePage(messages: messages, hasMore: true))
        let same = reducer.applyRefreshedPage(MessagePage(messages: messages, hasMore: true))
        #expect(!same)
        let running = reducer.applyRefreshedPage(MessagePage(messages: messages, hasMore: true, activeRun: active("r1")))
        #expect(running)
        #expect(reducer.thread.typing)
        #expect(reducer.thread.messages.map(\.id) == ["m1", "m2"])
    }

    // MARK: resync

    @Test("resync forgets the runs and the ids seen; the page after it brings a live turn back")
    func resyncResets() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(status(10, run: "r1", "thinking", kind: "chat"))
        reducer.apply(typing(11, run: "r1", true, kind: "chat"))
        #expect(reducer.isReplying)

        let applied = reducer.apply(resync(5))
        #expect(applied)
        #expect(!reducer.isReplying)
        #expect(reducer.status == nil)
        let again = reducer.apply(resync(5))
        #expect(!again, "the resync itself is a duplicate")
        // A restored server may hand out ids again: they apply.
        let reused = reducer.apply(typing(11, run: "r2", true, kind: "chat"))
        #expect(reused)
        #expect(reducer.thread.typing)

        var fresh = ThreadReducer(channelId: Fx.main)
        fresh.apply(typing(1, run: "r1", true, kind: "chat"))
        fresh.apply(resync(2))
        fresh.applyFirstPage(MessagePage(messages: [], hasMore: false, activeRun: active("r1")))
        #expect(fresh.thread.typing)
    }
}

// MARK: - Unread

@Suite("M21 unread")
struct DataM21UnreadTests {
    private func loaded(_ channels: [Channel]) -> ChannelMenu {
        var menu = ChannelMenu(mainChannelId: Fx.main)
        _ = menu.setChannels(channels)
        return menu
    }

    @Test("Opening a channel zeroes its count at once and keeps its lastReadAt")
    func selectZeroes() {
        var menu = loaded([Fx.chan(Fx.main, isMain: true), Fx.chan("a", unread: 3), Fx.chan("b", unread: 2)])
        _ = menu.select("a")
        #expect(menu.state.channels.first { $0.id == "a" }?.unreadCount == 0)
        #expect(menu.state.channels.first { $0.id == "b" }?.unreadCount == 2)
        #expect(menu.unreadChannels == 1)
    }

    @Test("The selected row shows no badge, even when an event gives it a count")
    func selectedRowNoBadge() throws {
        var menu = loaded([Fx.chan(Fx.main, isMain: true), Fx.chan("a")])
        _ = menu.select("a")
        _ = menu.apply(Fx.chan("a", unread: 2))
        let row = try #require(menu.state.channels.first { $0.id == "a" })
        #expect(row.unreadCount == 2)
        #expect(ChannelMenu.shownUnread(row, selected: true) == 0)
        #expect(ChannelMenu.shownUnread(row, selected: false) == 2)
        #expect(menu.unreadChannels == 0, "the ≡ badge doesn't count it either")
    }

    @Test("A channel event for the thread on screen with unread messages reads it now")
    func readsNow() {
        let unread = Fx.chan("a", unread: 1)
        #expect(ReadReceiptRule.readsNow(unread, threadChannelId: "a", onScreen: true))
        #expect(!ReadReceiptRule.readsNow(unread, threadChannelId: "a", onScreen: false), "app in the background or a sheet over it")
        #expect(!ReadReceiptRule.readsNow(unread, threadChannelId: "b", onScreen: true), "another channel")
        #expect(!ReadReceiptRule.readsNow(Fx.chan("a"), threadChannelId: "a", onScreen: true), "nothing unread")
        #expect(!ReadReceiptRule.readsNow(Fx.chan("a", unread: 1, archived: true), threadChannelId: "a", onScreen: true))
    }

    @Test("A receipt is due unless one went out for this newest message or a newer one")
    func isDue() {
        #expect(ReadReceiptRule.isDue(newest: Fx.date(10), lastMarked: nil))
        #expect(ReadReceiptRule.isDue(newest: Fx.date(10), lastMarked: Fx.date(9)))
        #expect(!ReadReceiptRule.isDue(newest: Fx.date(10), lastMarked: Fx.date(10)))
        #expect(!ReadReceiptRule.isDue(newest: Fx.date(10), lastMarked: Fx.date(11)))
    }
}
