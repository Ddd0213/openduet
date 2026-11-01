// M10a stop responding (contract §1, plan 2.8): ■ hides the live runs' typing and status at once
// (late events of a stopped run stay hidden, newer runs show), a failed stop brings them back with
// its reason, a 409 stays silent; the task session's working dots; the lenient `stopped` flag.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M10a stop responding")
struct DataM10AStopTests {
    @Test("■ hides the live run's typing and status at once; its late events stay hidden")
    func beginStopHides() {
        var reducer = ThreadReducer(channelId: Fx.main)
        #expect(!reducer.isReplying)
        reducer.apply(Fx.status(1, run: "r1", "thinking"))
        reducer.apply(Fx.typing(2, run: "r1", true))
        #expect(reducer.isReplying)

        let hidden = reducer.beginStop()
        #expect(hidden == ["r1"])
        #expect(!reducer.thread.typing)
        #expect(reducer.status == nil)
        #expect(reducer.thread.statusBubble == nil)
        #expect(!reducer.isReplying)

        // The server finishes the turn's last step before it cancels: still hidden.
        reducer.apply(Fx.status(3, run: "r1", "searching_web"))
        reducer.apply(Fx.typing(4, run: "r1", true))
        #expect(reducer.status == nil)
        #expect(!reducer.thread.typing)
        #expect(reducer.beginStop().isEmpty, "a second tap has nothing new to stop")

        reducer.apply(Fx.done(5, run: "r1"))
        #expect(!reducer.isReplying)
    }

    @Test("A turn queued behind the stopped one shows as usual")
    func queuedRunShows() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(Fx.status(1, run: "r1", "thinking"))
        reducer.apply(Fx.typing(2, run: "r1", true))
        reducer.beginStop()

        reducer.apply(Fx.status(3, run: "r2", "checking_memory"))
        #expect(reducer.status == .checkingMemory)
        reducer.apply(Fx.typing(4, run: "r2", true))
        #expect(reducer.thread.typing)
        reducer.apply(Fx.done(5, run: "r1"))
        #expect(reducer.status == .checkingMemory, "the stopped run's done leaves the newer one")
        #expect(reducer.thread.typing)
        reducer.apply(Fx.done(6, run: "r2"))
        #expect(!reducer.isReplying)
    }

    @Test("A failed stop shows the reply again; after its done, nothing comes back")
    func resumeStop() {
        var reducer = ThreadReducer(channelId: Fx.main)
        reducer.apply(Fx.status(1, run: "r1", "checking"))
        reducer.apply(Fx.typing(2, run: "r1", true))
        let hidden = reducer.beginStop()
        #expect(reducer.thread.statusBubble == nil)
        reducer.resumeStop(hidden)
        #expect(reducer.status == .checking)
        #expect(reducer.thread.statusBubble == .checking)
        #expect(reducer.thread.typing)

        let again = reducer.beginStop()
        reducer.apply(Fx.done(3, run: "r1"))
        reducer.resumeStop(again)
        #expect(reducer.status == nil)
        #expect(!reducer.thread.typing)
    }

    @Test("■ with nothing live hides nothing")
    func nothingLive() {
        var reducer = ThreadReducer(channelId: Fx.main)
        #expect(reducer.beginStop().isEmpty)
        reducer.apply(Fx.status(1, run: "r1", "thinking"))
        reducer.apply(Fx.done(2, run: "r1"))
        #expect(reducer.beginStop().isEmpty)
        reducer.apply(Fx.typing(3, run: "r2", true))
        #expect(reducer.thread.typing, "a stop with nothing live doesn't block the next run")
    }

    @Test("Stop failures: a 409 and a cancelled request are silent, others give their reason")
    func failureReason() {
        #expect(ThreadReducer.stopFailure(for: APIError.server(status: 409, code: "conflict")) == nil)
        #expect(ThreadReducer.stopFailure(for: CancellationError()) == nil)
        #expect(ThreadReducer.stopFailure(for: APIError.staleVersion) == nil)
        #expect(ThreadReducer.stopFailure(for: APIError.unreachable) == APIError.unreachable.localizedReason)
        let server = APIError.server(status: 500, code: "internal")
        #expect(ThreadReducer.stopFailure(for: server) == server.localizedReason)
        #expect(ThreadReducer.stopFailure(for: URLError(.badURL)) != nil)
        #expect(ThreadReducer.stopFailure(for: APIError.notFound)?.isEmpty == false)
    }

    @Test("Task session: ■ hides the working dots until the task leaves working")
    func taskWorkingDots() {
        var session = TaskSession(taskId: "task_1")
        session.applyDetail(Fx.detail("task_1", status: "working", updated: 1))
        #expect(session.state.thread.typing)
        #expect(session.state.composer.replying)

        session.beginStop()
        #expect(session.stopRequested)
        #expect(!session.state.thread.typing)
        #expect(!session.state.composer.replying)

        // The stopped turn's task event: needs_input. The next working stretch shows the dots.
        _ = session.apply(Fx.taskEvent(1, Fx.taskJSON("task_1", status: "needs_input", updated: 2)))
        #expect(!session.stopRequested)
        _ = session.apply(Fx.taskEvent(2, Fx.taskJSON("task_1", status: "working", updated: 3)))
        #expect(session.state.thread.typing)
    }

    @Test("Task session: a newer turn's typing shows; a failed stop gives the reason")
    func taskLiveRuns() {
        var session = TaskSession(taskId: "task_1")
        session.applyDetail(Fx.detail("task_1", status: "working", updated: 1))
        _ = session.apply(Fx.typing(1, run: "r1", true, taskId: "task_1"))
        let hidden = session.beginStop()
        #expect(hidden == ["r1"])
        _ = session.apply(Fx.typing(2, run: "r1", true, taskId: "task_1"))
        #expect(!session.state.thread.typing, "the stopped run's late typing stays hidden")

        _ = session.apply(Fx.done(3, run: "r1", taskId: "task_1"))
        _ = session.apply(Fx.typing(4, run: "r2", true, taskId: "task_1"))
        #expect(session.state.thread.typing)
        #expect(!session.stopRequested)

        let next = session.beginStop()
        session.resumeStop(next, failure: "Couldn't reach the server.")
        #expect(session.state.thread.typing)
        #expect(session.state.composer.stopFailure == "Couldn't reach the server.")
        session.beginStop()
        #expect(session.state.composer.stopFailure == nil, "a new tap clears the old reason")
    }

    @Test("Message.stopped decodes leniently: missing is false")
    func stoppedFlag() {
        #expect(!Fx.message("m1", at: 1).stopped)
        var json = Fx.messageJSON("m2", at: 2)
        json["stopped"] = true
        #expect(Fx.decode(Message.self, json).stopped)
    }
}
