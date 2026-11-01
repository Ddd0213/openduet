// Run records (M8 contract §1): RunList / RunDetail decode from contract-shaped samples (kept
// here until docs/api-samples/runs.json lands), RunsBoard pages lists and polls open details,
// RunDay groups rows by day, TaskRunsChoice picks the task sheet's page.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

extension Fx {
    static func runJSON(_ id: String, kind: String = "task", status: String = "completed", at t: Int = 0,
                        title: [String: Any] = ["key": "run.title.brief"], latest: Bool = true, task: String? = "task_1") -> [String: Any] {
        [
            "id": id, "kind": kind, "channelId": main, "taskId": task ?? NSNull(), "title": title,
            "status": status, "stepCount": latest ? 2 : 0,
            "latest": latest ? ["title": ["key": "run.step.exec"], "detail": "ls -la"] as [String: Any] : NSNull() as Any,
            "error": status == "failed" ? ["key": "error.unknown", "text": "Boom"] as [String: Any] : NSNull() as Any,
            "createdAt": iso(t), "startedAt": iso(t), "finishedAt": status == "running" ? NSNull() as Any : iso(t + 42) as Any,
        ]
    }

    static func stepJSON(_ id: String, index: Int, kind: String = "tool", status: String = "ok",
                         input: String? = "{\"command\":\"ls\"}", output: String? = nil) -> [String: Any] {
        [
            "id": id, "index": index, "kind": kind, "tool": kind == "tool" ? "computer_exec" : NSNull() as Any,
            "app": kind == "tool" ? "Claude's computer" : NSNull() as Any, "title": ["key": "run.step.exec"],
            "detail": "ls -la", "status": status, "input": input ?? NSNull(), "output": output ?? NSNull(),
            "approvalId": NSNull(), "startedAt": iso(index), "finishedAt": status == "running" ? NSNull() as Any : iso(index + 1) as Any,
        ]
    }

    static func run(_ id: String, status: String = "completed", at t: Int = 0, task: String? = "task_1") -> RunSummary {
        decode(RunSummary.self, runJSON(id, status: status, at: t, task: task))
    }

    static func runList(_ runs: [RunSummary], hasMore: Bool = false) -> RunList {
        RunList(runs: runs, hasMore: hasMore)
    }

    static func runDetail(_ id: String, status: String = "completed", steps: Int = 2) -> RunDetail {
        var json = runJSON(id, status: status)
        json["steps"] = (0..<steps).map { stepJSON("st\($0)", index: $0) }
        return decode(RunDetail.self, json)
    }
}

@Suite("Run records")
struct DataRunsTests {
    @Test("RunList and RunDetail decode the contract's shapes; nullable fields may be null")
    func decoding() {
        let list = Fx.decode(RunList.self, [
            "runs": [Fx.runJSON("run_1", status: "running", task: nil), Fx.runJSON("run_2", kind: "chat", status: "failed", title: ["text": "Find the deck"], latest: false)],
            "hasMore": true,
        ])
        #expect(list.hasMore)
        #expect(list.runs.map(\.id) == ["run_1", "run_2"])
        #expect(list.runs[0].status == .running && list.runs[0].status.isOpen)
        #expect(list.runs[0].taskId == nil && list.runs[0].finishedAt == nil)
        #expect(list.runs[0].latest?.title.key == "run.step.exec")
        #expect(list.runs[1].kind == .chat && list.runs[1].title.text == "Find the deck")
        #expect(list.runs[1].latest == nil && list.runs[1].error?.text == "Boom")

        var json = Fx.runJSON("run_3")
        json["steps"] = [
            Fx.stepJSON("st0", index: 0, status: "awaiting_approval"),
            Fx.stepJSON("st1", index: 1, kind: "thinking", status: "ok", input: nil, output: "Let me check the folder first."),
            Fx.stepJSON("st2", index: 2, kind: "text", status: "running", input: nil, output: nil),
        ]
        let detail = Fx.decode(RunDetail.self, json)
        #expect(detail.id == "run_3" && detail.summary.kind == .task)
        #expect(detail.steps.map(\.status) == [.awaitingApproval, .ok, .running])
        #expect(detail.steps[0].tool == "computer_exec" && detail.steps[0].app == "Claude's computer")
        #expect(detail.steps.map(\.isExpandable) == [true, true, false], "thinking / text expand when they carry a body")
        #expect(detail.steps[2].finishedAt == nil)
    }

    @Test("Lists: first page, older pages by ?before=, a refresh keeps the pages below it")
    func paging() {
        var board = RunsBoard()
        board.beginList(.all)
        #expect(board.state.list(.all).phase == .loading)
        board.applyList(Fx.runList([Fx.run("r3", at: 30), Fx.run("r2", at: 20)], hasMore: true), scope: .all)
        #expect(board.state.list(.all).phase == .loaded)

        let before = board.beginMore(.all)
        #expect(before == "r2")
        #expect(board.state.list(.all).loadingMore)
        let twice = board.beginMore(.all)
        #expect(twice == nil, "one older page at a time")
        board.applyMore(Fx.runList([Fx.run("r2", at: 20), Fx.run("r1", at: 10)], hasMore: false), scope: .all)
        #expect(board.state.list(.all).runs.map(\.id) == ["r3", "r2", "r1"], "no repeats")
        #expect(!board.state.list(.all).hasMore && !board.state.list(.all).loadingMore)
        let done = board.beginMore(.all)
        #expect(done == nil)

        // A refresh: the newest page answers again with a new run; the rows below it stay, and
        // so does "nothing more" (the older pages were already read).
        board.beginList(.all)
        #expect(board.state.list(.all).phase == .loaded, "a loaded list stays on screen")
        board.applyList(Fx.runList([Fx.run("r4", at: 40), Fx.run("r3", at: 30)], hasMore: true), scope: .all)
        #expect(board.state.list(.all).runs.map(\.id) == ["r4", "r3", "r2", "r1"])
        #expect(!board.state.list(.all).hasMore)

        // Scopes are separate; a failed first load shows the reason, a failed older page too.
        board.failList(.task("t9"), reason: "Offline")
        #expect(board.state.list(.task("t9")).phase == .failed(reason: "Offline"))
        board.failList(.all, reason: "Offline")
        #expect(board.state.list(.all).phase == .loaded, "a failed refresh keeps the rows")
        var paged = RunsBoard()
        paged.applyList(Fx.runList([Fx.run("r2", at: 20)], hasMore: true), scope: .all)
        let cursor = paged.beginMore(.all)
        #expect(cursor == "r2")
        paged.failMore(.all, reason: "Offline")
        #expect(paged.state.list(.all).moreError == "Offline" && !paged.state.list(.all).loadingMore)
        let retry = paged.beginMore(.all)
        #expect(retry == "r2", "Retry asks for the same page")
        #expect(paged.state.list(.all).moreError == nil)
    }

    @Test("Details poll every ~2 s while the run is open on screen and still queued or running")
    func polling() {
        #expect(RunsBoard.pollInterval == .seconds(2))
        var board = RunsBoard()
        board.applyList(Fx.runList([Fx.run("r1", status: "running")]), scope: .task("task_1"))
        let first = board.open("r1")
        #expect(first, "the first view starts the polling")
        let second = board.open("r1")
        #expect(!second, "a second view of the same run shares it")
        #expect(board.state.detail("r1").summary?.id == "r1", "the row's summary shows at once")
        #expect(board.shouldPoll("r1"), "steps not loaded yet")

        board.beginDetail("r1")
        board.applyDetail(Fx.runDetail("r1", status: "running", steps: 1))
        #expect(board.state.detail("r1").steps?.count == 1)
        #expect(board.shouldPoll("r1"))

        board.applyDetail(Fx.runDetail("r1", status: "completed", steps: 3))
        #expect(!board.shouldPoll("r1"), "finished: no more polling")
        #expect(board.state.list(.task("task_1")).runs.first?.status == .completed, "the list row follows the detail")

        let closedOne = board.close("r1")
        #expect(!closedOne, "one view is still open")
        let closedAll = board.close("r1")
        #expect(closedAll)
        #expect(!board.isOpen("r1"))
        #expect(!board.shouldPoll("r1"), "nobody looks: no polling")
    }

    @Test("A failed first detail load shows Retry and stops polling; a failed poll keeps the timeline")
    func detailFailure() {
        var board = RunsBoard()
        _ = board.open("r1")
        board.beginDetail("r1")
        board.failDetail("r1", reason: "Offline")
        #expect(board.state.detail("r1").phase == .failed(reason: "Offline"))
        #expect(!board.shouldPoll("r1"))

        board.beginDetail("r1")
        #expect(board.state.detail("r1").phase == .loading, "Retry")
        board.applyDetail(Fx.runDetail("r1", status: "running", steps: 2))
        board.failDetail("r1", reason: "Offline")
        #expect(board.state.detail("r1").phase == .loaded)
        #expect(board.state.detail("r1").steps?.count == 2)
        #expect(board.shouldPoll("r1"))
    }

    @Test("Rows group by calendar day, newest day first; the task sheet picks one run or the list")
    func daysAndChoice() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let day: Int = 86_400
        let runs = [Fx.run("a", at: 2 * day + 50), Fx.run("b", at: 2 * day + 10), Fx.run("c", at: day + 5), Fx.run("d", at: 5)]
        let days = RunDay.group(runs, calendar: calendar)
        #expect(days.map { $0.runs.map(\.id) } == [["a", "b"], ["c"], ["d"]])
        #expect(days[0].day == calendar.startOfDay(for: runs[0].createdAt))

        #expect(TaskRunsChoice(RunListState()) == .loading)
        #expect(TaskRunsChoice(RunListState(phase: .failed(reason: "x"))) == .failed("x"))
        #expect(TaskRunsChoice(RunListState(phase: .loaded)) == .empty)
        #expect(TaskRunsChoice(RunListState(phase: .loaded, runs: [runs[0]])) == .single(runs[0]))
        #expect(TaskRunsChoice(RunListState(phase: .loaded, runs: [runs[0]], hasMore: true)) == .list, "more on the server")
        #expect(TaskRunsChoice(RunListState(phase: .loaded, runs: runs)) == .list)
        #expect(TaskRunsChoice(RunListState(phase: .loading, runs: runs)) == .list, "a reload keeps the rows")
    }
}
