// M22 W3 data layer (Stores/TasksReducer.swift, Stores/TaskBoard.swift): Done's "Earlier" pages
// and the server search kept out of the list, Reopen (also from "Earlier"), resolvedAt stamped on
// a check, the Needs you badge and when it asks again, the Show me answer state, Try again's
// 409s, and a show_tasks row starting its suggestion.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M22 tasks data")
struct DataM22TasksTests {
    private func resolved(_ id: String, updated: Int, channel: String = Fx.main) -> TaskSummary {
        var task = Fx.task(id, status: "resolved", channel: channel, updated: updated)
        task.resolvedAt = Fx.date(updated)
        return task
    }

    private func failed(_ id: String, retryable: Bool) -> TaskSummary {
        var task = Fx.task(id, status: "needs_input")
        task.failure = TaskFailure(reason: Phrase(text: "The site was down"), retryable: retryable, at: Fx.date(0))
        return task
    }

    private func ids(_ tasks: [TaskSummary]) -> [String] { tasks.map(\.id) }

    @Test("Earlier: pages of older resolved tasks show under Done, never in the list; the last page ends it; a scope change clears them")
    func olderPages() {
        var list = TasksReducer()
        list.applyList([Fx.task("w", updated: 5)], scope: nil, olderResolved: 4)
        #expect(list.state.olderResolved == 4)
        let r1 = list.beginOlder()
        #expect(r1)
        let r2 = list.beginOlder()
        #expect(!r2, "one page at a time")
        list.applyOlder(TaskList(tasks: [resolved("o1", updated: 3), resolved("o2", updated: 2)], nextCursor: "c2"))
        #expect(ids(list.state.older.tasks) == ["o1", "o2"])
        #expect(ids(list.state.tasks) == ["w"])
        #expect(list.state.older.cursor == "c2" && list.state.older.hasMore)
        _ = list.beginOlder()
        list.applyOlder(TaskList(tasks: [resolved("o3", updated: 1)], nextCursor: nil))
        #expect(ids(list.state.older.tasks) == ["o1", "o2", "o3"])
        #expect(!list.state.older.hasMore)
        let r3 = list.beginOlder()
        #expect(!r3, "nothing left")
        // A live event for an "Earlier" task that is still resolved keeps it there.
        list.apply(resolved("o1", updated: 4))
        #expect(ids(list.state.tasks) == ["w"])
        list.setScope("ch_other")
        #expect(list.state.older.tasks.isEmpty && !list.state.older.loaded && list.state.olderResolved == 0)
    }

    @Test("an older page that fails keeps its reason; Show more tries again")
    func olderFails() {
        var list = TasksReducer()
        _ = list.beginOlder()
        list.failOlder(reason: "Offline")
        #expect(list.state.older.phase == .failed(reason: "Offline"))
        let r1 = list.beginOlder()
        #expect(r1)
    }

    @Test("Reopen from Earlier: the row joins the list at once; a failure puts it back under Earlier")
    func reopenFromEarlier() {
        var list = TasksReducer()
        list.applyList([], scope: nil, olderResolved: 1)
        _ = list.beginOlder()
        list.applyOlder(TaskList(tasks: [resolved("o1", updated: 3)], nextCursor: nil))
        let r1 = list.beginReopen("o1")
        #expect(r1)
        #expect(ids(list.state.tasks) == ["o1"])
        #expect(list.task("o1")?.status == .needsInput && list.task("o1")?.resolvedAt == nil)
        #expect(list.state.older.tasks.isEmpty)
        list.failReopen("o1")
        #expect(list.state.tasks.isEmpty)
        #expect(ids(list.state.older.tasks) == ["o1"])
        // Again, and this time the server answers: it stays in the list.
        _ = list.beginReopen("o1")
        list.finishReopen(Fx.task("o1", status: "needs_input", updated: 9))
        #expect(ids(list.state.tasks) == ["o1"])
        #expect(list.state.older.tasks.isEmpty)
        let r2 = list.beginReopen("o1")
        #expect(!r2, "only a resolved row reopens")
    }

    @Test("a check stamps resolvedAt (Just done) until the server answers")
    func checkStampsResolvedAt() {
        var list = TasksReducer()
        list.applyList([Fx.task("a", updated: 1)], scope: nil)
        let at = Fx.date(500)
        let r1 = list.beginUpdate("a", UpdateTaskRequest(status: .resolved, archived: nil), now: at)
        #expect(r1)
        #expect(list.task("a")?.status == .resolved)
        #expect(list.task("a")?.resolvedAt == at)
        #expect(TaskGrouping.place(of: list.task("a")!, now: at.addingTimeInterval(1)) == .group(.justDone))
    }

    @Test("search: the server's answer for what the field says; older answers dropped; answer tasks stay out of the list; empty ends it")
    func search() {
        var list = TasksReducer()
        list.applyList([Fx.task("a", title: "Budget review")], scope: nil)
        list.beginSearch("bud")
        list.beginSearch("budget")
        list.applySearch([Fx.task("stale")], query: "bud")
        #expect(list.state.search.answered == nil, "an answer for an older query is dropped")
        list.failSearch(reason: "Offline", query: "bud")
        #expect(list.state.search.phase == .loading)
        list.applySearch([resolved("old", updated: 1), Fx.task("a", title: "Budget review")], query: "budget")
        #expect(list.state.search.results(for: "budget").map(ids) == ["old", "a"])
        #expect(list.state.search.results(for: "bud") == nil)
        #expect(ids(list.state.tasks) == ["a"], "a search's tasks never join the list")
        list.beginSearch("")
        #expect(list.state.search.phase == .idle && list.state.search.answered == nil && list.state.search.tasks.isEmpty)
    }

    @Test("Reopen: needs input at once, resolvedAt cleared; a failure puts the row back")
    func reopen() {
        var list = TasksReducer()
        list.applyList([resolved("r", updated: 2), Fx.task("w", updated: 1)], scope: nil)
        let r1 = list.beginReopen("r")
        #expect(r1)
        #expect(list.task("r")?.status == .needsInput && list.task("r")?.resolvedAt == nil)
        let r2 = list.beginReopen("w")
        #expect(!r2)
        list.failReopen("r")
        #expect(list.task("r")?.status == .resolved && list.task("r")?.resolvedAt == Fx.date(2))
    }

    @Test("badge: the local count until Needs you answers, then its count less the tasks settled here")
    func badge() {
        var list = TasksReducer()
        list.applyList([Fx.task("n", status: "needs_input"), Fx.task("v", status: "ready_for_review"), Fx.task("w")], scope: nil)
        #expect(list.needingUser == 2)
        list.applyNeedsYou(NeedsYou(count: 3, items: [.task(Fx.task("n", status: "needs_input")), .unsupported(kind: "x")]))
        #expect(list.needingUser == 3)
        _ = list.beginUpdate("n", UpdateTaskRequest(status: .resolved, archived: nil))
        #expect(list.needingUser == 2)
        let floor = TasksReducer.badgeCount(NeedsYou(count: 1, items: [.task(Fx.task("a")), .task(Fx.task("b"))]), settled: { _ in true })
        #expect(floor == 0, "never below zero")
    }

    @Test("badge refetch: once the events are quiet 0.8 s, at most 3 s after the first; one at a time, once more after")
    func needsYouRefetch() {
        var refetch = NeedsYouRefetch()
        let t0 = Fx.date(0)
        func near(_ a: Date, _ b: Date) -> Bool { abs(a.timeIntervalSince(b)) < 0.001 }
        #expect(near(refetch.note(at: t0), t0.addingTimeInterval(0.8)))
        #expect(near(refetch.note(at: t0.addingTimeInterval(0.5)), t0.addingTimeInterval(1.3)))
        #expect(near(refetch.note(at: t0.addingTimeInterval(2.5)), t0.addingTimeInterval(3)), "never later than maxWait")
        let r1 = refetch.begin()
        #expect(r1)
        #expect(refetch.pendingSince == nil)
        let r2 = refetch.begin()
        #expect(!r2, "one request at a time")
        let r3 = refetch.end()
        #expect(r3, "events came meanwhile: once more")
        _ = refetch.begin()
        let r4 = refetch.end()
        #expect(!r4)
    }

    @Test("badge refetch follows task, approval, card, delete and resync events, not chat text")
    func needsYouEvents() {
        #expect(NeedsYouRefetch.isRelevant(Fx.taskEvent(1, Fx.taskJSON("a")).body))
        #expect(NeedsYouRefetch.isRelevant(Fx.event(2, "task_deleted", ["taskId": "a"]).body))
        #expect(NeedsYouRefetch.isRelevant(Fx.deleted(3, "m").body))
        #expect(NeedsYouRefetch.isRelevant(Fx.event(4, "resync", [:]).body))
        #expect(NeedsYouRefetch.isRelevant(Fx.messageEvent(5, Fx.approvalCardJSON(approval: Fx.approvalJSON())).body))
        #expect(!NeedsYouRefetch.isRelevant(Fx.messageEvent(6, Fx.messageJSON("t", at: 6)).body))
        #expect(!NeedsYouRefetch.isRelevant(Fx.typing(7, run: "r", true).body))
    }

    @Test("Show me state: a scan keeps its start; ending with Up next empty is 'nothing new' until the next scan or a suggestion")
    func scanFeedback() {
        var list = TasksReducer()
        list.beginScan(now: Fx.date(10))
        #expect(list.state.upNext.scanning && list.state.upNext.scanStartedAt == Fx.date(10))
        list.applyUpNext(UpNext(suggestions: [], scanning: true), now: Fx.date(30))
        #expect(list.state.upNext.scanStartedAt == Fx.date(10) && !list.state.upNext.scanFoundNothing)
        list.applyUpNext(UpNext(suggestions: [], scanning: false))
        #expect(list.state.upNext.scanFoundNothing && list.state.upNext.scanStartedAt == nil)
        list.beginScan(now: Fx.date(40))
        #expect(!list.state.upNext.scanFoundNothing)
        list.failScan()
        #expect(!list.state.upNext.scanning && list.state.upNext.scanStartedAt == nil)
        // A scan already running when the list comes starts then; one that ends with suggestions isn't "nothing".
        var fresh = TasksReducer()
        fresh.applyUpNext(UpNext(suggestions: [], scanning: true), now: Fx.date(50))
        #expect(fresh.state.upNext.scanStartedAt == Fx.date(50))
        fresh.applyUpNext(UpNext(suggestions: [Fx.suggestion("s")], scanning: false))
        #expect(!fresh.state.upNext.scanFoundNothing)
        // Not a scan ending: an empty list on its own says nothing.
        var idle = TasksReducer()
        idle.applyUpNext(UpNext(suggestions: [], scanning: false))
        #expect(!idle.state.upNext.scanFoundNothing)
        // Save for Up next heads the list and clears "nothing new".
        list.beginScan(now: Fx.date(60))
        list.applyUpNext(UpNext(suggestions: [], scanning: false))
        #expect(list.state.upNext.scanFoundNothing)
        list.insertSuggestion(Fx.suggestion("mine"))
        #expect(list.state.upNext.suggestions.map(\.id) == ["mine"] && !list.state.upNext.scanFoundNothing)
    }

    @Test("Try again: only a retryable failure; a 409 says why in plain words; success runs it again")
    func retry() {
        var board = TaskBoard()
        board.list.applyList([failed("f", retryable: true), failed("n", retryable: false)], scope: nil)
        let key = ShellState.RequestKey.retryTask("f")
        let r1 = board.beginRetry("n")
        #expect(!r1, "running it again won't help")
        let r2 = board.beginRetry("f")
        #expect(r2)
        #expect(board.cardRequests[key] == .inFlight)
        let r3 = board.beginRetry("f")
        #expect(!r3, "one at a time")
        board.answerRetry("f", .failure(APIError.server(status: 409, code: "task_running")))
        #expect(board.cardRequests[key] == .failed(reason: String(localized: "It's already running.")))
        _ = board.beginRetry("f")
        board.answerRetry("f", .failure(APIError.server(status: 409, code: "not_retryable")))
        #expect(board.cardRequests[key] == .failed(reason: String(localized: "Running it again won't help. Open the task to see why.")))
        _ = board.beginRetry("f")
        board.answerRetry("f", .success(Fx.detail("f", status: "working", updated: 5)))
        #expect(board.cardRequests[key] == nil)
        #expect(board.list.task("f")?.status == .working && board.list.task("f")?.failure == nil)
    }

    @Test("Reopen on the board: in flight under its key; a failure puts the row back with the reason")
    func boardReopen() {
        var board = TaskBoard()
        board.list.applyList([resolved("r", updated: 2)], scope: nil)
        let key = ShellState.RequestKey.reopenTask("r")
        let r1 = board.beginReopen("r")
        #expect(r1)
        #expect(board.cardRequests[key] == .inFlight)
        board.answerReopen("r", .failure(APIError.unreachable))
        #expect(board.list.task("r")?.status == .resolved)
        if case .failed? = board.cardRequests[key] {} else { Issue.record("expected the reason") }
        let r2 = board.beginReopen("r")
        #expect(r2)
        board.answerReopen("r", .success(Fx.detail("r", status: "needs_input", updated: 9)))
        #expect(board.cardRequests[key] == nil)
        #expect(board.list.task("r")?.status == .needsInput)
    }

    @Test("a show_tasks row's suggestion started: the task joins the list, the suggestion leaves Up next, a second tap opens it")
    func suggestionStarted() {
        var board = TaskBoard()
        board.list.applyUpNext(UpNext(suggestions: [Fx.suggestion("s1"), Fx.suggestion("s2")], scanning: false))
        let key = ShellState.RequestKey.startSuggestion("s1")
        let r1 = board.beginRequest(key)
        #expect(r1)
        board.suggestionStarted("s1", task: Fx.task("t1"))
        #expect(board.cardRequests[key] == nil)
        #expect(board.startedSuggestions["s1"] == "t1")
        #expect(board.list.state.upNext.suggestions.map(\.id) == ["s2"])
        #expect(ids(board.list.state.tasks) == ["t1"])
    }
}
