// M21 W4b: a deep link's message (ThreadState.focus) is found among the thread's rows once it is
// on the page, and a task detail keeps it even when its filter would leave it out.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M21 deep link focus rows")
struct UIM21FocusTests {
    private static let base = Date(timeIntervalSince1970: 1_793_000_000)

    private func message(_ id: String, _ role: Message.Role = .assistant, at minutes: Double, text: String = "text",
                         clientId: String? = nil) -> Message {
        let date = Self.base.addingTimeInterval(minutes * 60)
        return Message(
            id: id, channelId: "main", taskId: nil, role: role, text: text, status: .sent, clientId: clientId,
            reactions: [], createdAt: date, updatedAt: date, content: .text(TextPayload(skill: nil, attachments: []))
        )
    }

    private func thread(_ messages: [Message], focus: String?) -> ThreadState {
        var thread = ThreadState()
        thread.phase = .loaded
        thread.messages = messages
        thread.focus = focus.map { ThreadFocus(messageId: $0, token: UUID()) }
        return thread
    }

    @Test("The focused message's row, by message id (the row id uses the clientId when there is one)")
    func findsRow() {
        let state = thread([message("m1", at: 0), message("m2", .user, at: 1, clientId: "c2"), message("m3", at: 2)], focus: "m2")
        let rows = ThreadLayout.rows(for: state)
        #expect(ThreadLayout.focusRow(state.focus, in: rows) == "m:c2")
        let assistant = thread(state.messages, focus: "m3")
        #expect(ThreadLayout.focusRow(assistant.focus, in: ThreadLayout.rows(for: assistant)) == "m:m3")
    }

    @Test("Nothing to scroll to: no focus, a message not on the page, a reply with no text yet")
    func noRow() {
        let messages = [message("m1", at: 0), message("m2", at: 1, text: " ")]
        #expect(ThreadLayout.focusRow(nil, in: ThreadLayout.rows(for: thread(messages, focus: nil))) == nil)
        let missing = thread(messages, focus: "older")
        #expect(ThreadLayout.focusRow(missing.focus, in: ThreadLayout.rows(for: missing)) == nil)
        let empty = thread(messages, focus: "m2")
        #expect(ThreadLayout.focusRow(empty.focus, in: ThreadLayout.rows(for: empty)) == nil, "the typing dots stand in for it")
    }

    @Test("Task detail: a link's message the filter would hide stays when kept")
    func taskFilterKeepsFocus() {
        // OpenDuet's in-between text of a turn is filtered out by default.
        var state = ThreadState(context: .task)
        state.phase = .loaded
        state.messages = [message("u1", .user, at: 0), message("c1", at: 1), message("c2", at: 2), message("c3", at: 3)]
        #expect(!TaskThreadFilter.apply(state).thread.messages.map(\.id).contains("c2"))
        state.focus = ThreadFocus(messageId: "c2", token: UUID())
        let kept = TaskThreadFilter.apply(state, keeping: [state.focus!.messageId]).thread
        #expect(kept.messages.map(\.id).contains("c2"))
        #expect(kept.focus == state.focus, "the filtered thread carries the focus")
    }
}
