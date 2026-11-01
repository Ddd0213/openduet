// TasksReducer (the Tasks tab): `task` events upsert by id within the scope, the badge count,
// list loads (phase vs refreshing, dropping gone tasks, keeping event updates), optimistic
// Mark complete / Archive with rollback, Up next removal and restore.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Tasks list")
struct DataTasksListTests {
    private func ids(_ list: TasksReducer) -> [String] { list.state.tasks.map(\.id) }

    @Test("task events upsert by id, newest update first; an older copy never wins")
    func upsert() {
        var list = TasksReducer()
        list.apply(Fx.task("t1", updated: 10))
        list.apply(Fx.task("t2", updated: 20))
        #expect(ids(list) == ["t2", "t1"])

        list.apply(Fx.task("t1", status: "needs_input", updated: 30, title: "renamed"))
        #expect(ids(list) == ["t1", "t2"])
        #expect(list.state.tasks[0].title == "renamed")
        #expect(list.state.updatedAt == Fx.date(30))

        list.apply(Fx.task("t1", status: "working", updated: 25, title: "stale"))
        #expect(list.state.tasks[0].title == "renamed")
        #expect(list.state.tasks[0].status == .needsInput)
    }

    @Test("Through route(): a task event reaches the list once, even from both streams")
    func routed() {
        var board = TaskBoard()
        var main = ThreadReducer(channelId: Fx.main)
        let event = Fx.taskEvent(1, Fx.taskJSON("t1", status: "ready_for_review", updated: 5))
        board.route(event, main: &main)
        board.route(event, main: &main)
        #expect(ids(board.list) == ["t1"])
        #expect(board.list.needingUser == 1)
    }

    @Test("Scope: tasks of other channels stay out of the list; archived tasks leave it")
    func scope() {
        var list = TasksReducer()
        list.setScope("ch_q4")
        list.apply(Fx.task("in", channel: "ch_q4", updated: 1))
        list.apply(Fx.task("out", channel: Fx.main, updated: 2))
        #expect(ids(list) == ["in"])

        list.apply(Fx.task("in", channel: "ch_q4", updated: 3, archived: true))
        #expect(ids(list).isEmpty)

        list.setScope(nil)
        #expect(ids(list) == ["out"], "Everything shows every open task")
        #expect(list.state.updatedAt == Fx.date(2))
    }

    @Test("Badge: needs input + ready for review, any channel, not archived")
    func badge() {
        var list = TasksReducer()
        list.setScope("ch_q4")
        list.apply(Fx.task("a", status: "needs_input", channel: Fx.main))
        list.apply(Fx.task("b", status: "ready_for_review", channel: "ch_q4"))
        list.apply(Fx.task("c", status: "working"))
        list.apply(Fx.task("d", status: "scheduled"))
        list.apply(Fx.task("e", status: "resolved"))
        list.apply(Fx.task("f", status: "needs_input", archived: true))
        #expect(list.needingUser == 2)

        list.apply(Fx.task("c", status: "needs_input", updated: 5))
        #expect(list.needingUser == 3)
        list.apply(Fx.task("a", status: "resolved", channel: Fx.main, updated: 5))
        #expect(list.needingUser == 2)
    }

    @Test("First load uses phase; later loads set refreshing until the answer")
    func loadPhases() {
        var list = TasksReducer()
        list.beginLoad()
        #expect(list.state.phase == .loading)
        #expect(!list.state.refreshing)
        list.failLoad(reason: "Can't reach your server.")
        #expect(list.state.phase == .failed(reason: "Can't reach your server."))

        list.beginLoad()
        #expect(list.state.phase == .loading)
        list.applyList([Fx.task("t1")], scope: nil)
        #expect(list.state.phase == .loaded)
        #expect(!list.state.refreshing)

        list.beginLoad()
        #expect(list.state.refreshing)
        #expect(list.state.phase == .loaded)
        list.failLoad(reason: "x")
        #expect(list.state.phase == .loaded, "a failed refresh keeps the list")
        #expect(!list.state.refreshing)
        #expect(ids(list) == ["t1"])
    }

    @Test("A list answer drops tasks it no longer lists, but keeps ones events changed meanwhile")
    func listMerge() {
        var list = TasksReducer()
        list.applyList([Fx.task("old", updated: 1), Fx.task("gone", updated: 2), Fx.task("other", channel: "ch_q4", updated: 3)], scope: nil)
        list.setScope(Fx.main)

        list.beginLoad()
        list.apply(Fx.task("fresh", updated: 10))
        list.applyList([Fx.task("old", updated: 1)], scope: Fx.main)
        #expect(ids(list) == ["fresh", "old"])

        list.setScope(nil)
        #expect(ids(list) == ["fresh", "other", "old"], "tasks of other scopes stay known")
    }

    @Test("Mark complete is optimistic; failure rolls back to the server's latest copy")
    func markCompleteRollback() {
        var board = TaskBoard()
        board.list.apply(Fx.task("t1", status: "ready_for_review", updated: 1))
        #expect(board.list.needingUser == 1)

        let began = board.beginTaskUpdate("t1", UpdateTaskRequest(status: .resolved, archived: nil))
        #expect(began)
        #expect(board.list.state.tasks[0].status == .resolved)
        #expect(board.list.needingUser == 0)
        #expect(board.cardRequests["t1"] == .inFlight)
        let second = board.beginTaskUpdate("t1", UpdateTaskRequest(status: nil, archived: true))
        #expect(!second, "one update at a time")

        // An event lands meanwhile: it becomes the copy to roll back to.
        board.list.apply(Fx.task("t1", status: "needs_input", updated: 2, title: "event"))
        #expect(board.list.state.tasks[0].status == .resolved, "the optimistic copy stays on screen")

        board.answerTaskUpdate("t1", .failure(APIError.unreachable))
        #expect(board.list.state.tasks[0].status == .needsInput)
        #expect(board.list.state.tasks[0].title == "event")
        #expect(board.cardRequests["t1"] == .failed(reason: APIError.unreachable.localizedReason))

        let retried = board.beginTaskUpdate("t1", UpdateTaskRequest(status: .resolved, archived: nil))
        #expect(retried, "Retry")
        board.answerTaskUpdate("t1", .success(Fx.detail("t1", status: "resolved", updated: 3)))
        #expect(board.list.state.tasks[0].status == .resolved)
        #expect(board.cardRequests["t1"] == nil)
    }

    @Test("Archive hides the row at once and brings it back if the PATCH fails")
    func archive() {
        var board = TaskBoard()
        board.list.apply(Fx.task("t1", updated: 1))
        let began = board.beginTaskUpdate("t1", UpdateTaskRequest(status: nil, archived: true))
        #expect(began)
        #expect(ids(board.list).isEmpty)
        board.answerTaskUpdate("t1", .failure(APIError.notFound))
        #expect(ids(board.list) == ["t1"])
        let unknown = board.beginTaskUpdate("unknown", UpdateTaskRequest(status: .resolved, archived: nil))
        #expect(!unknown)
    }

    @Test("Up next: a removed suggestion can be put back in its place")
    func upNext() {
        var list = TasksReducer()
        list.beginUpNext()
        #expect(list.state.upNext.phase == .loading)
        list.applyUpNext(UpNext(suggestions: [Fx.suggestion("a"), Fx.suggestion("b"), Fx.suggestion("c")], scanning: false))
        #expect(list.state.upNext.phase == .loaded)

        let removed = list.removeSuggestion("b")
        #expect(list.state.upNext.suggestions.map(\.id) == ["a", "c"])
        if let removed { list.restoreSuggestion(removed.suggestion, at: removed.index) }
        #expect(list.state.upNext.suggestions.map(\.id) == ["a", "b", "c"])
        let missing = list.removeSuggestion("zzz")
        #expect(missing == nil)

        list.failUpNext(reason: "x")
        #expect(list.state.upNext.phase == .loaded, "a failed reload keeps the suggestions")
    }

    @Test("Channel names come from the loaded channels")
    func channelNames() {
        var list = TasksReducer()
        list.setChannelNames(["ch_q4": "Q4 planning"])
        #expect(list.state.channelNames == ["ch_q4": "Q4 planning"])
    }
}
