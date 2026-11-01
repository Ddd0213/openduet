// M9 lists (contract §4, §5): pinned tasks first (newest update first among them) with an
// optimistic Pin that a failure puts back; task_deleted / channel_deleted removing tasks for good
// and sending a selected channel back to Everything; the Usage panel's per-range cache.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M9 pinned and deleted tasks")
struct DataM9ListTests {
    private func ids(_ list: TasksReducer) -> [String] { list.state.tasks.map(\.id) }

    private func task(_ id: String, updated: Int, pinned: Bool = false, channel: String = Fx.main) -> TaskSummary {
        var task = Fx.task(id, channel: channel, updated: updated)
        task.pinned = pinned
        return task
    }

    @Test("pinned tasks sort first, then newest update first")
    func pinnedFirst() {
        var list = TasksReducer()
        list.applyList([
            task("new", updated: 30), task("pinOld", updated: 5, pinned: true), task("mid", updated: 20),
            task("pinNew", updated: 10, pinned: true),
        ], scope: nil)
        #expect(ids(list) == ["pinNew", "pinOld", "new", "mid"])
    }

    @Test("Pin moves the row at once; a failure puts it back; the answer keeps it")
    func optimisticPin() {
        var list = TasksReducer()
        list.applyList([task("a", updated: 30), task("b", updated: 10)], scope: nil)
        let r1 = list.beginPin("b", true)
        #expect(r1)
        #expect(ids(list) == ["b", "a"])
        #expect(list.isPatching("b"))
        let r2 = list.beginPin("b", false)
        #expect(!r2, "one change at a time")

        list.failPatch("b")
        #expect(ids(list) == ["a", "b"])
        #expect(!list.isPatching("b"))

        let r3 = list.beginPin("b", true)
        #expect(r3)
        list.finishPatch(task("b", updated: 10, pinned: true))
        #expect(ids(list) == ["b", "a"])
        #expect(list.task("b")?.pinned == true)
        let r4 = list.beginPin("missing", true)
        #expect(!r4)
    }

    @Test("pinned work in progress gets its own group; resolved and routines stay where they are")
    func pinnedGroup() {
        var working = task("w", updated: 1, pinned: true)
        working.status = .working
        var resolved = task("r", updated: 2, pinned: true)
        resolved.status = .resolved
        var routine = task("s", updated: 3, pinned: true)
        routine.status = .scheduled
        routine.routine = Routine(paused: false, quiet: false, nextRunAt: nil, lastRunAt: nil, lastRunStatus: nil)
        let now = Fx.date(60)
        #expect(TaskGrouping.place(of: working, now: now) == .group(.pinned))
        // M22: resolved a minute ago = Just done; a routine waiting = Up next's Coming up.
        #expect(TaskGrouping.place(of: resolved, now: now) == .group(.justDone))
        #expect(TaskGrouping.place(of: routine, now: now) == .comingUp)
        let other = task("o", updated: 9)
        let groups = TaskGrouping.groups([other, working, resolved], now: now)
        #expect(groups.first?.kind == .pinned)
        #expect(groups.first?.tasks.map(\.id) == ["w"])
    }

    @Test("Pause shows at once (no next run) and only on a routine")
    func routinePause() {
        var list = TasksReducer()
        var routine = task("r", updated: 1)
        routine.status = .scheduled
        routine.routine = Routine(paused: false, quiet: false, nextRunAt: Fx.date(3600), lastRunAt: nil, lastRunStatus: nil)
        list.applyList([routine, task("plain", updated: 2)], scope: nil)
        let r5 = list.beginRoutineChange("plain", paused: true)
        #expect(!r5)
        let r6 = list.beginRoutineChange("r", paused: true)
        #expect(r6)
        #expect(list.task("r")?.routine?.paused == true)
        #expect(list.task("r")?.routine?.nextRunAt == nil)
        list.failPatch("r")
        #expect(list.task("r")?.routine?.paused == false)
        #expect(list.task("r")?.routine?.nextRunAt == Fx.date(3600))
    }

    @Test("task_deleted: the task leaves for good; a late event or list answer doesn't bring it back")
    func taskDeleted() {
        var list = TasksReducer()
        list.applyList([task("a", updated: 1), task("b", updated: 2)], scope: nil)
        let r7 = list.remove("a")
        #expect(r7)
        #expect(ids(list) == ["b"])
        #expect(list.wasDeleted("a"))
        list.apply(task("a", updated: 99))
        list.applyList([task("a", updated: 1), task("b", updated: 2)], scope: nil)
        #expect(ids(list) == ["b"])
        let r8 = list.remove("missing")
        #expect(!r8)
    }

    @Test("task_deleted closes the open detail and clears its requests")
    func taskDeletedClosesDetail() {
        var board = TaskBoard()
        board.list.applyList([task("a", updated: 1)], scope: nil)
        board.open("a")
        let r9 = board.beginDelete("a")
        #expect(r9)
        #expect(board.cardRequests[ShellState.RequestKey.deleteTask("a")] == .inFlight)
        let r10 = board.answerDelete("a", .success(()))
        #expect(r10, "the open detail closes")
        #expect(board.openTaskId == nil)
        #expect(board.cardRequests[ShellState.RequestKey.deleteTask("a")] == nil)
        let r11 = board.beginDelete("a")
        #expect(!r11, "already gone")
    }

    @Test("a failed delete keeps the task with the reason; 404 counts as gone")
    func deleteFailure() {
        var board = TaskBoard()
        board.list.applyList([task("a", updated: 1), task("b", updated: 2)], scope: nil)
        let r12 = board.beginDelete("a")
        #expect(r12)
        let r13 = board.answerDelete("a", .failure(APIError.unreachable))
        #expect(!r13)
        #expect(board.list.task("a") != nil)
        if case .failed? = board.cardRequests[ShellState.RequestKey.deleteTask("a")] {} else { Issue.record("expected the reason") }
        let r14 = board.beginDelete("b")
        #expect(r14)
        _ = board.answerDelete("b", .failure(APIError.notFound))
        #expect(board.list.task("b") == nil)
    }

    @Test("channel_deleted: its tasks go, others stay; the open detail of one of them closes")
    func channelDeletedTasks() {
        var board = TaskBoard()
        board.list.applyList([
            task("q1", updated: 1, channel: "ch_q4"), task("q2", updated: 2, channel: "ch_q4"), task("m", updated: 3),
        ], scope: nil)
        board.open("q2")
        let r15 = board.removeChannel("ch_q4")
        #expect(r15)
        #expect(board.list.state.tasks.map(\.id) == ["m"])
        #expect(board.openTaskId == nil)
        let r16 = board.removeChannel("ch_none")
        #expect(!r16)
    }

    @Test("channel_deleted: the row leaves the menu and Archived; a selected channel goes back to Everything")
    func channelDeletedMenu() {
        var menu = ChannelMenu(mainChannelId: Fx.main)
        _ = menu.setChannels([Fx.chan(Fx.main, isMain: true), Fx.chan("ch_q4"), Fx.chan("ch_b")])
        menu.setArchived([Fx.chan("ch_old", archived: true)])
        _ = menu.select("ch_q4")
        #expect(menu.state.selectedChannelId == "ch_q4")

        let back = menu.remove("ch_q4")
        #expect(back == ChannelSelection(threadChannelId: Fx.main, scope: nil))
        #expect(menu.state.selectedChannelId == nil)
        #expect(menu.state.channels.map(\.id) == ["ch_b"])
        // A late `channel` event or list doesn't bring it back.
        _ = menu.setChannels([Fx.chan(Fx.main, isMain: true), Fx.chan("ch_q4"), Fx.chan("ch_b")])
        #expect(menu.state.channels.map(\.id) == ["ch_b"])

        let r17 = menu.remove("ch_old")
        #expect(r17 == nil, "not selected: nothing to switch")
        #expect(menu.state.archived?.isEmpty == true)
        let r18 = menu.remove(Fx.main)
        #expect(r18 == nil, "the main thread can't be deleted")
    }

    @Test("Mark as read failing puts the badge back")
    func markReadRollback() {
        var menu = ChannelMenu(mainChannelId: Fx.main)
        _ = menu.setChannels([Fx.chan(Fx.main, isMain: true), Fx.chan("a", unread: 3)])
        let before = menu.channel("a")!
        menu.markedRead("a", at: Fx.date(10))
        #expect(menu.state.channels.first?.unreadCount == 0)
        menu.restoreUnread(before)
        #expect(menu.state.channels.first?.unreadCount == 3)
    }
}

@Suite("M9 usage stats cache")
struct DataM9UsageTests {
    private static let start = Date(timeIntervalSince1970: 1_793_000_000)

    private func stats(_ range: UsageRange, tokens: Int = 10) -> UsageStats {
        UsageStats(
            range: range, since: nil, until: Self.start,
            totals: .init(inputTokens: tokens, outputTokens: 1, runs: 1), estimated: false,
            byModel: [], byKind: [], bucket: .day, series: []
        )
    }

    @Test("a range loads once, then comes from the cache while fresh; each range has its own")
    func cachePerRange() {
        var board = AccountBoard()
        let r19 = board.beginUsageStats(.sevenDays, now: Self.start)
        #expect(r19)
        #expect(board.usageScreen.statsPhase[.sevenDays] == .loading)
        let r20 = board.beginUsageStats(.sevenDays, now: Self.start)
        #expect(!r20, "already loading")
        board.applyUsageStats(stats(.sevenDays), range: .sevenDays, now: Self.start)
        #expect(board.usageScreen.statsPhase[.sevenDays] == .loaded)

        let r21 = board.beginUsageStats(.sevenDays, now: Self.start.addingTimeInterval(5))
        #expect(!r21)
        let r22 = board.beginUsageStats(.today, now: Self.start.addingTimeInterval(5))
        #expect(r22)
        #expect(board.usageScreen.range == .today)
        #expect(board.usageScreen.stats[.sevenDays] != nil, "the other range stays cached")
    }

    @Test("after the freshness window (or a usage event) it loads again but keeps showing the numbers")
    func refreshKeepsNumbers() {
        var board = AccountBoard()
        _ = board.beginUsageStats(.thirtyDays, now: Self.start)
        board.applyUsageStats(stats(.thirtyDays), range: .thirtyDays, now: Self.start)
        let later = Self.start.addingTimeInterval(AccountBoard.usageStatsFreshness + 1)
        let r23 = board.beginUsageStats(.thirtyDays, now: later)
        #expect(r23)
        #expect(board.usageScreen.statsPhase[.thirtyDays] == .loaded, "no skeleton over cached numbers")
        board.failUsageStats(.thirtyDays, APIError.unreachable)
        #expect(board.usageScreen.stats[.thirtyDays] != nil)
        #expect(board.usageScreen.statsPhase[.thirtyDays] == .loaded)

        board.applyUsageStats(stats(.thirtyDays), range: .thirtyDays, now: later)
        let r24 = board.beginUsageStats(.thirtyDays, now: later)
        #expect(!r24)
        board.usageStatsStale()
        let r25 = board.beginUsageStats(.thirtyDays, now: later)
        #expect(r25)
    }

    @Test("a first load that fails shows the reason; a cancelled one leaves no trace")
    func firstLoadFailure() {
        var board = AccountBoard()
        _ = board.beginUsageStats(.all, now: Self.start)
        board.failUsageStats(.all, APIError.unreachable)
        if case .failed = board.usageScreen.statsPhase[.all] {} else { Issue.record("expected the inline reason") }
        let r26 = board.beginUsageStats(.all, now: Self.start)
        #expect(r26, "Retry loads again")
        board.failUsageStats(.all, CancellationError())
        #expect(board.usageScreen.statsPhase[.all] == nil)
    }
}
