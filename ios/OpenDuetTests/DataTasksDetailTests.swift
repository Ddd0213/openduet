// Task detail: the task-scoped reducer only takes this task's messages, status and typing; a
// `task` event for the open task asks for a refetch; sessions survive a close only while a
// reply waits; duet://tasks/<id> links.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Task detail")
struct DataTasksDetailTests {
    private func ids(_ reducer: ThreadReducer) -> [String] { reducer.thread.messages.map(\.id) }

    @Test("A task session takes only its own task's messages, status and typing")
    func taskScope() {
        var session = TaskSession(taskId: "task_1")
        #expect(session.reducer.thread.context == .task)
        _ = session.apply(Fx.messageEvent(1, Fx.messageJSON("mine", at: 10, taskId: "task_1")))
        _ = session.apply(Fx.messageEvent(2, Fx.messageJSON("main", at: 11)))
        _ = session.apply(Fx.messageEvent(3, Fx.messageJSON("other", at: 12, taskId: "task_2")))
        _ = session.apply(Fx.messageEvent(4, Fx.messageJSON("elsewhere", at: 13, channel: "ch_q4", taskId: "task_1")))
        #expect(ids(session.reducer) == ["mine", "elsewhere"], "any channel, this task only")

        _ = session.apply(Fx.status(5, run: "r_main", "thinking"))
        _ = session.apply(Fx.status(6, run: "r_other", "searching_web", taskId: "task_2"))
        #expect(session.state.status == nil)
        _ = session.apply(Fx.status(7, run: "r1", "checking", taskId: "task_1"))
        _ = session.apply(Fx.typing(8, run: "r1", true, taskId: "task_1"))
        _ = session.apply(Fx.typing(9, run: "r_main", true, taskId: nil))
        #expect(session.state.status == .checking)
        #expect(session.state.thread.statusBubble == .checking)
        #expect(session.state.thread.typing)

        _ = session.apply(Fx.done(10, run: "r_main", taskId: nil))
        #expect(session.state.status == .checking, "the main thread's done doesn't end the task's run")
        _ = session.apply(Fx.done(11, run: "r1", taskId: "task_1"))
        #expect(session.state.status == nil)
        #expect(!session.state.thread.typing)
    }

    @Test("route() sends one event to the main thread, the list and every session")
    func routing() {
        var board = TaskBoard()
        var main = ThreadReducer(channelId: Fx.main)
        board.open("task_1")

        board.route(Fx.messageEvent(1, Fx.messageJSON("m_main", at: 10)), main: &main)
        board.route(Fx.messageEvent(2, Fx.messageJSON("m_task", at: 11, taskId: "task_1")), main: &main)
        board.route(Fx.status(3, run: "rt", "working", taskId: "task_1"), main: &main)
        #expect(ids(main) == ["m_main"])
        #expect(main.status == nil, "a task's run stays out of the header pill")
        #expect(board.openSession.map { ids($0.reducer) } == ["m_task"])
        #expect(board.openSession?.state.status == .working)
    }

    @Test("A task event for the open task asks for a refetch once; other tasks don't")
    func refetch() {
        var board = TaskBoard()
        var main = ThreadReducer(channelId: Fx.main)
        board.open("task_1")
        board.detailLoaded(Fx.detail("task_1", updated: 1))

        let mine = Fx.taskEvent(1, Fx.taskJSON("task_1", status: "needs_input", updated: 5))
        let first = board.route(mine, main: &main)
        #expect(first)
        let duplicate = board.route(mine, main: &main)
        #expect(!duplicate, "the copy from the other stream is a duplicate")
        #expect(board.openSession?.state.task?.summary.status == .needsInput, "the summary updates at once")
        let other = board.route(Fx.taskEvent(2, Fx.taskJSON("task_2", updated: 6)), main: &main)
        #expect(!other)
        let message = board.route(Fx.messageEvent(3, Fx.messageJSON("m", at: 1, taskId: "task_1")), main: &main)
        #expect(!message)
    }

    @Test("Detail answers: an older copy never replaces a newer one; failures only show before the first load")
    func detailOrder() {
        var session = TaskSession(taskId: "task_1")
        session.failDetail(reason: "x")
        #expect(session.state.phase == .failed(reason: "x"))
        session.applyDetail(Fx.detail("task_1", updated: 5, steps: ["Read"]))
        #expect(session.state.phase == .loaded)
        session.applyDetail(Fx.detail("task_1", updated: 3, steps: []))
        #expect(session.state.task?.steps.count == 1)
        session.applyDetail(Fx.detail("task_2", updated: 9))
        #expect(session.state.task?.id == "task_1")
        session.failDetail(reason: "y")
        #expect(session.state.phase == .loaded)
    }

    @Test("M14: a 404 marks the task gone (no Retry, empty thread); later failures don't undo it")
    func goneTask() {
        #expect(TaskSession.isGone(APIError.notFound))
        #expect(!TaskSession.isGone(APIError.unreachable))
        #expect(!TaskSession.isGone(APIError.server(status: 404, code: "other")))
        var session = TaskSession(taskId: "task_1")
        session.markGone()
        #expect(session.state.phase == .gone)
        #expect(session.state.task == nil)
        #expect(session.state.thread.phase == .loaded, "the thread shows nothing, not its own failure")
        session.failDetail(reason: "offline")
        #expect(session.state.phase == .gone)
    }

    @Test("Closing keeps a session only while a reply still waits to go out")
    func closeAndPrune() {
        var board = TaskBoard()
        board.open("task_1")
        board.updateSession("task_1") { $0.reducer.enqueue(Fx.pending("c1")) }
        board.close()
        #expect(board.openSession == nil)
        #expect(board.sessions["task_1"] != nil)
        #expect(board.thread(pending: "c1", main: ThreadReducer(channelId: Fx.main)) == .task("task_1"))

        board.open("task_1")
        #expect(board.openSession?.reducer.isPending("c1") == true, "reopening reuses the kept session")

        board.open("task_2")
        #expect(board.openTaskId == "task_2")
        #expect(board.sessions["task_1"] != nil)
        board.updateSession("task_1") { $0.reducer.apply(Fx.messageEvent(1, Fx.messageJSON("m", at: 1, role: "user", clientId: "c1", taskId: "task_1"))) }
        board.prune()
        #expect(board.sessions["task_1"] == nil, "dropped once the reply went out")
        #expect(board.sessions["task_2"] != nil, "the open one stays")
        board.close()
        #expect(board.sessions.isEmpty)
    }

    @Test("Where a message lives: main thread first, then the task sessions")
    func threadLookup() {
        var board = TaskBoard()
        var main = ThreadReducer(channelId: Fx.main)
        board.open("task_1")
        board.route(Fx.messageEvent(1, Fx.messageJSON("m_main", at: 10)), main: &main)
        board.route(Fx.messageEvent(2, Fx.messageJSON("m_task", at: 11, taskId: "task_1")), main: &main)
        #expect(board.thread(containing: "m_main", main: main) == .main)
        #expect(board.thread(containing: "m_task", main: main) == .task("task_1"))
        #expect(board.thread(containing: "nope", main: main) == nil)
    }

    @Test("duet:// links: tasks open; the others parse for M4+")
    func routes() {
        #expect(DuetRoute(URL(string: "duet://tasks/task_1")!) == .task(id: "task_1"))
        #expect(DuetRoute(URL(string: "duet://TASKS/task_1")!) == .task(id: "task_1"))
        #expect(DuetRoute(URL(string: "duet://artifacts/art_1")!) == .artifact(id: "art_1"))
        #expect(DuetRoute(URL(string: "duet://computer")!) == .computer)
        #expect(DuetRoute(URL(string: "duet://tasks")!) == nil)
        #expect(DuetRoute(URL(string: "https://example.com/tasks/1")!) == nil)
    }
}
