// Card requests (L182) and edits by chat (L163): Approve in flight -> success / 409 stale /
// 410 expired / other failure; the approval written into every thread that shows its card;
// edits only when the version grows; approval events; card actions upsert their answer.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Card requests")
struct DataCardsTests {
    /// A board with one pending approval card (v1) in the main thread and the same approval's
    /// card in an open task session.
    private func setUp() -> (TaskBoard, ThreadReducer) {
        var board = TaskBoard()
        var main = ThreadReducer(channelId: Fx.main)
        main.applyFirstPage(Fx.page([Fx.approvalCard("msg_a", approval: Fx.approvalJSON(message: "msg_a"))]))
        board.open("task_1")
        board.updateSession("task_1") {
            $0.reducer.applyFirstPage(Fx.page([Fx.approvalCard("msg_t", approval: Fx.approvalJSON(message: "msg_t"), taskId: "task_1")]))
        }
        return (board, main)
    }

    private func card(_ id: String, _ reducer: ThreadReducer?) -> Approval? {
        Fx.shownApproval(reducer?.thread.messages.first { $0.id == id })
    }

    @Test("Approve: in flight, then success writes the approval into both threads' cards")
    func approveSuccess() {
        var (board, main) = setUp()
        let began = board.beginRequest("msg_a")
        #expect(began)
        #expect(board.cardRequests["msg_a"] == .inFlight)
        let again = board.beginRequest("msg_a")
        #expect(!again, "a second tap while in flight does nothing")

        let approved = Fx.approval(message: "msg_a", version: 1, status: "approved", updated: 20)
        let followUp = board.answerApproval(messageId: "msg_a", approvalId: "apr_1", .success(approved), main: &main)
        #expect(followUp == .nothing)
        #expect(board.cardRequests["msg_a"] == nil)
        #expect(card("msg_a", main)?.status == .approved)
        #expect(card("msg_a", main)?.result?.ok == true)
        #expect(card("msg_t", board.openSession?.reducer)?.status == .approved)
        #expect(main.thread.edits.isEmpty, "a decision is not an edit")

        // The message copy from before the decision (same message updatedAt) doesn't undo it.
        main.upsert(Fx.approvalCard("msg_a", approval: Fx.approvalJSON(message: "msg_a")))
        #expect(card("msg_a", main)?.status == .approved)
    }

    @Test("409 stale version: request cleared, the card's thread reloads and glows the new version")
    func staleVersion() {
        var (board, main) = setUp()
        _ = board.beginRequest("msg_t")
        let followUp = board.answerApproval(messageId: "msg_t", approvalId: "apr_1", .failure(APIError.staleVersion), main: &main)
        #expect(followUp == .reload(.task("task_1")))
        #expect(board.cardRequests["msg_t"] == nil)

        // The reload brings v2 with changedFields: the card updates in place and glows.
        board.updateSession("task_1") {
            $0.reducer.mergePage(Fx.page([Fx.approvalCard("msg_t", approval: Fx.approvalJSON(message: "msg_t", version: 2, changed: ["body"], updated: 30), taskId: "task_1", updated: 30)]))
        }
        let reducer = board.openSession?.reducer
        #expect(card("msg_t", reducer)?.version == 2)
        #expect(reducer?.thread.edits["msg_t"] == CardEdit(version: 2, fields: ["body"]))

        // Main-thread cards reload the main thread.
        _ = board.beginRequest("msg_a")
        let mainFollowUp = board.answerApproval(messageId: "msg_a", approvalId: "apr_1", .failure(APIError.staleVersion), main: &main)
        #expect(mainFollowUp == .reload(.main))
    }

    @Test("410 expired: request cleared, the card shows Expired at once and its thread reloads")
    func expired() {
        var (board, main) = setUp()
        _ = board.beginRequest("msg_a")
        let followUp = board.answerApproval(messageId: "msg_a", approvalId: "apr_1", .failure(APIError.expired), main: &main)
        #expect(followUp == .reload(.main))
        #expect(board.cardRequests["msg_a"] == nil)
        #expect(card("msg_a", main)?.status == .expired)
    }

    @Test("Other failures leave the reason with Retry; Retry is the same call again")
    func failure() {
        var (board, main) = setUp()
        _ = board.beginRequest("msg_a")
        let followUp = board.answerApproval(messageId: "msg_a", approvalId: "apr_1", .failure(APIError.unreachable), main: &main)
        #expect(followUp == .nothing)
        #expect(board.cardRequests["msg_a"] == .failed(reason: APIError.unreachable.localizedReason))
        #expect(card("msg_a", main)?.status == .pending)

        let retried = board.beginRequest("msg_a")
        #expect(retried, "Retry starts again from failed")
        #expect(board.cardRequests["msg_a"] == .inFlight)
        _ = board.answerApproval(messageId: "msg_a", approvalId: "apr_1", .success(Fx.approval(message: "msg_a", status: "approved", updated: 5)), main: &main)
        #expect(board.cardRequests["msg_a"] == nil)

        // A cancelled request (sign-out) just clears.
        _ = board.beginRequest("msg_t")
        _ = board.answerApproval(messageId: "msg_t", approvalId: "apr_1", .failure(CancellationError()), main: &main)
        #expect(board.cardRequests["msg_t"] == nil)
    }

    @Test("Edits glow only when the version grows and changedFields isn't empty")
    func edits() {
        var main = ThreadReducer(channelId: Fx.main)
        // First sight (even with changedFields from an edit made while away): no glow.
        main.apply(Fx.messageEvent(1, Fx.approvalCardJSON(approval: Fx.approvalJSON(version: 2, changed: ["body"], updated: 1))))
        #expect(main.thread.edits.isEmpty)

        // Same version again: no glow.
        main.apply(Fx.messageEvent(2, Fx.approvalCardJSON(approval: Fx.approvalJSON(version: 2, changed: ["body"], updated: 1), updated: 12)))
        #expect(main.thread.edits.isEmpty)

        // Version grows with changedFields: glow.
        main.apply(Fx.messageEvent(3, Fx.approvalCardJSON(approval: Fx.approvalJSON(version: 3, changed: ["subject", "to"], updated: 2), updated: 13)))
        #expect(main.thread.edits["msg_a"] == CardEdit(version: 3, fields: ["subject", "to"]))

        // An older version arriving late changes nothing.
        main.apply(Fx.messageEvent(4, Fx.approvalCardJSON(approval: Fx.approvalJSON(version: 2, changed: ["body"], updated: 1), updated: 14)))
        #expect(main.thread.edits["msg_a"]?.version == 3)
        #expect(Fx.shownApproval(main.thread.messages.first)?.version == 3)

        // Version grows without changedFields: the card updates, the glow entry stays at v3.
        main.apply(Fx.messageEvent(5, Fx.approvalCardJSON(approval: Fx.approvalJSON(version: 4, changed: [], updated: 3), updated: 15)))
        #expect(Fx.shownApproval(main.thread.messages.first)?.version == 4)
        #expect(main.thread.edits["msg_a"]?.version == 3)
    }

    @Test("A reloaded first page that brings a newer version glows it")
    func editsOnReload() {
        var main = ThreadReducer(channelId: Fx.main)
        main.applyFirstPage(Fx.page([Fx.approvalCard(approval: Fx.approvalJSON(version: 1))]))
        #expect(main.thread.edits.isEmpty)
        main.applyFirstPage(Fx.page([Fx.approvalCard(approval: Fx.approvalJSON(version: 2, changed: ["body"], updated: 5), updated: 20)]))
        #expect(main.thread.edits["msg_a"] == CardEdit(version: 2, fields: ["body"]))
    }

    @Test("approval events update the card that shows them (by approval id), in every thread")
    func approvalEvents() {
        var (board, main) = setUp()
        board.route(Fx.approvalEvent(1, Fx.approvalJSON(message: "msg_a", version: 2, changed: ["body"], updated: 10)), main: &main)
        #expect(card("msg_a", main)?.version == 2)
        #expect(main.thread.edits["msg_a"] == CardEdit(version: 2, fields: ["body"]))
        #expect(card("msg_t", board.openSession?.reducer)?.version == 2)

        // An older approval never moves a card back.
        board.route(Fx.approvalEvent(2, Fx.approvalJSON(message: "msg_a", version: 1, updated: 11)), main: &main)
        #expect(card("msg_a", main)?.version == 2)
    }

    @Test("Spend request cards take the approval's status and never go back to pending")
    func spendRequests() {
        var main = ThreadReducer(channelId: Fx.main)
        main.upsert(Fx.spendCard(approvalId: "apr_2"))
        main.apply(Fx.approvalEvent(1, Fx.approvalJSON("apr_2", message: "msg_s", status: "approved", updated: 5)))
        guard case .spendRequest(let spend)? = main.thread.messages.first?.content else { Issue.record("no spend card"); return }
        #expect(spend.status == .approved)
        main.apply(Fx.approvalEvent(2, Fx.approvalJSON("apr_2", message: "msg_s", status: "pending", updated: 6)))
        guard case .spendRequest(let after)? = main.thread.messages.first?.content else { return }
        #expect(after.status == .approved)
    }

    @Test("Card action: in flight, then the returned message is upserted where it belongs")
    func actionUpsert() {
        var board = TaskBoard()
        var main = ThreadReducer(channelId: Fx.main)
        main.applyFirstPage(Fx.page([Fx.proactiveCard(state: "open", updated: 10)]))

        let began = board.beginRequest("msg_p")
        #expect(began)
        board.answerAction(messageId: "msg_p", .success(Fx.proactiveCard(state: "started", taskId: "task_9", updated: 20)), main: &main)
        #expect(board.cardRequests["msg_p"] == nil)
        guard case .proactiveSuggestion(let card)? = main.thread.messages.first?.content else { Issue.record("no card"); return }
        #expect(card.state == .started)
        #expect(card.taskId == "task_9")
        #expect(main.thread.messages.count == 1)

        _ = board.beginRequest("msg_p")
        board.answerAction(messageId: "msg_p", .failure(APIError.validationFailed(field: nil, message: "")), main: &main)
        #expect(board.cardRequests["msg_p"] == .failed(reason: APIError.validationFailed(field: nil, message: "").localizedReason))
    }

    @Test("409 and 410 stay distinct APIErrors, with or without the error body")
    func errorMapping() {
        let stale = try! JSONSerialization.data(withJSONObject: ["error": ["code": "stale_version", "message": "m"]])
        let gone = try! JSONSerialization.data(withJSONObject: ["error": ["code": "expired", "message": "m"]])
        #expect(APIError(status: 409, body: stale) == .staleVersion)
        #expect(APIError(status: 410, body: gone) == .expired)
        #expect(APIError(status: 409, body: Data()) == .staleVersion)
        #expect(APIError(status: 410, body: Data()) == .expired)
        #expect(ShellState.createTaskRequest == "task:create")
    }
}
