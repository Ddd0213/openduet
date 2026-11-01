// M10 (agent B) data logic: Rename from a task row's ⋯ / long-press. The new title shows at once
// (an optimistic patch like Pin's), in flight under RequestKey.renameTask(id); a failure puts the
// old title back with the reason, the answer keeps the server's copy; a task_deleted clears it.
// TaskActions.rename rides the existing title path (updateRoutine(id, nil, title)).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M10b Rename task")
struct DataM10BRenameTests {
    private func task(_ id: String, updated: Int, title: String? = nil) -> TaskSummary {
        Fx.task(id, updated: updated, title: title)
    }

    @Test("Rename shows at once; a failure puts the old title back with the reason; the answer keeps it")
    func renameRoundTrip() {
        var board = TaskBoard()
        board.list.applyList([task("a", updated: 1, title: "Old name"), task("b", updated: 2)], scope: nil)
        let key = ShellState.RequestKey.renameTask("a")

        let r1 = board.beginRename("a", title: "New name")
        #expect(r1)
        #expect(board.list.task("a")?.title == "New name")
        #expect(board.cardRequests[key] == .inFlight)
        let r2 = board.beginRename("a", title: "Other")
        #expect(!r2, "one rename at a time")
        let r3 = board.beginPin("a", true)
        #expect(!r3, "Pin waits: they share the task's one optimistic patch")

        board.answerPatch("a", key: key, .failure(APIError.unreachable))
        #expect(board.list.task("a")?.title == "Old name")
        if case .failed? = board.cardRequests[key] {} else { Issue.record("expected the reason") }

        // Retry from the sheet.
        let r4 = board.beginRename("a", title: "New name")
        #expect(r4)
        board.answerPatch("a", key: key, .success(TaskPatchAnswer(summary: task("a", updated: 1, title: "New name"))))
        #expect(board.list.task("a")?.title == "New name")
        #expect(board.cardRequests[key] == nil)
        #expect(!board.list.isPatching("a"))
    }

    @Test("Rename refuses an unchanged title, an unknown task and a deleted one")
    func renameGuards() {
        var list = TasksReducer()
        list.applyList([task("a", updated: 1, title: "Same"), task("b", updated: 2)], scope: nil)
        let same = list.beginRename("a", title: "Same")
        #expect(!same)
        let unknown = list.beginRename("zzz", title: "Name")
        #expect(!unknown)
        _ = list.remove("b")
        let deleted = list.beginRename("b", title: "Name")
        #expect(!deleted)
        let pinning = list.beginPin("a", true)
        #expect(pinning)
        let busy = list.beginRename("a", title: "Name")
        #expect(!busy, "a pin is in flight")
    }

    @Test("task_deleted clears a rename's request")
    func deleteClearsRename() {
        var board = TaskBoard()
        board.list.applyList([task("a", updated: 1)], scope: nil)
        let started = board.beginRename("a", title: "Renamed")
        #expect(started)
        board.removeTask("a")
        #expect(board.cardRequests[ShellState.RequestKey.renameTask("a")] == nil)
    }

    @Test("the key is its own; TaskActions.rename goes through the title path")
    @MainActor
    func renameAction() {
        #expect(ShellState.RequestKey.renameTask("t1") == "task:rename:t1")
        #expect(ShellState.RequestKey.renameTask("t1") != ShellState.RequestKey.pinTask("t1"))
        var calls: [String] = []
        var actions = TaskActions()
        actions.updateRoutine = { id, schedule, title in
            calls.append("\(id)|\(schedule == nil)|\(title ?? "-")")
        }
        actions.rename("t1", "Plan the offsite")
        #expect(calls == ["t1|true|Plan the offsite"])
    }
}
