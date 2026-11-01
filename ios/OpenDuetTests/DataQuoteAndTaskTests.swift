// M8 data rules: quote reply on the wire (SendMessageRequest.replyTo, TextPayload.replyTo; old
// payloads without it still decode), the task session's typing dots while the task works (also
// after reopening it), and the checkbox's undo window (the PATCH waits for it).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Quote reply and task fixes")
struct DataQuoteAndTaskTests {
    @Test("SendMessageRequest carries replyTo only when set")
    func requestReplyTo() throws {
        let quoted = SendMessageRequest(text: "Yes, that one", clientId: "c1", replyTo: "msg_assistant")
        let json = try JSONSerialization.jsonObject(with: JSONCoding.encoder().encode(quoted)) as? [String: Any]
        #expect(json?["replyTo"] as? String == "msg_assistant")
        let plain = SendMessageRequest(text: "Hi", clientId: "c2")
        let bare = try JSONSerialization.jsonObject(with: JSONCoding.encoder().encode(plain)) as? [String: Any]
        #expect(bare?.keys.contains("replyTo") == false, "older servers never see the field")
    }

    @Test("TextPayload.replyTo decodes; null and older payloads without it decode as nil")
    func payloadReplyTo() {
        var json = Fx.messageJSON("m1", at: 1, text: "Yes, that one", role: "user")
        json["payload"] = ["skill": NSNull(), "attachments": [], "replyTo": ["messageId": "m0", "role": "assistant", "excerpt": "Here are three options"]]
        let quoting = Fx.decode(Message.self, json)
        guard case .text(let payload) = quoting.content else { Issue.record("not text"); return }
        #expect(payload.replyTo?.messageId == "m0")
        #expect(payload.replyTo?.role == .assistant)
        #expect(payload.replyTo?.excerpt == "Here are three options")

        json["payload"] = ["skill": NSNull(), "attachments": [], "replyTo": NSNull()]
        if case .text(let nullPayload) = Fx.decode(Message.self, json).content { #expect(nullPayload.replyTo == nil) }
        if case .text(let oldPayload) = Fx.message("m2", at: 2).content { #expect(oldPayload.replyTo == nil) }
    }

    @Test("Typing dots: a working task shows them after reopening, until OpenDuet speaks or it stops")
    func workingDots() {
        var session = TaskSession(taskId: "task_1")
        #expect(!session.state.thread.typing)
        session.applyDetail(Fx.detail("task_1", status: "working", updated: 1))
        #expect(session.state.thread.typing, "reopened mid-run: no live typing event needed")

        // An empty, just-started reply doesn't end them; OpenDuet's words do.
        _ = session.apply(Fx.messageEvent(1, Fx.messageJSON("m0", at: 1, text: " ", taskId: "task_1")))
        #expect(session.state.thread.typing)
        _ = session.apply(Fx.messageEvent(2, Fx.messageJSON("m1", at: 2, text: "On it", taskId: "task_1")))
        #expect(!session.state.thread.typing)

        // Live typing events still bring them back.
        _ = session.apply(Fx.typing(3, run: "r1", true, taskId: "task_1"))
        #expect(session.state.thread.typing)
        _ = session.apply(Fx.typing(4, run: "r1", false, taskId: "task_1"))
        #expect(!session.state.thread.typing)

        // Leaving working ends the stretch; the next working stretch shows them again.
        session.applyDetail(Fx.detail("task_1", status: "needs_input", updated: 5))
        #expect(!session.state.thread.typing)
        session.applyDetail(Fx.detail("task_1", status: "working", updated: 6))
        #expect(session.state.thread.typing)
    }

    @Test("Checkbox: resolved at once, nothing sent until the ~4 s undo window ends; Undo puts it back")
    func completionUndo() {
        #expect(TaskBoard.completionUndoSeconds == 4)
        var board = TaskBoard()
        board.list.apply(Fx.task("t1", status: "ready_for_review", updated: 1))
        board.list.apply(Fx.task("t2", status: "needs_input", updated: 2))

        let undo = board.beginCompletion("t1")
        #expect(undo?.taskId == "t1")
        #expect(board.completionUndo == undo)
        #expect(board.list.task("t1")?.status == .resolved, "the row shows resolved at once")
        #expect(board.cardRequests["t1"] == nil, "no PATCH yet")
        let overlapping = board.beginCompletion("t2")
        #expect(overlapping == nil, "the store commits the first window before a second tap")

        board.undoCompletion()
        #expect(board.completionUndo == nil)
        #expect(board.list.task("t1")?.status == .readyForReview)
        let none = board.commitCompletion()
        #expect(none == nil, "an undone tap sends nothing")

        let again = board.beginCompletion("t1")
        #expect(again != nil && again?.id != undo?.id, "a new tap is a new toast")
        let committed = board.commitCompletion()
        #expect(committed == "t1")
        #expect(board.completionUndo == nil)
        #expect(board.cardRequests["t1"] == .inFlight, "the PATCH goes out when the window ends")
        board.answerTaskUpdate("t1", .success(Fx.detail("t1", status: "resolved", updated: 3)))
        #expect(board.cardRequests["t1"] == nil)
        #expect(board.list.task("t1")?.status == .resolved)

        let resolvedAgain = board.beginCompletion("t1")
        #expect(resolvedAgain == nil, "already resolved")
    }
}
