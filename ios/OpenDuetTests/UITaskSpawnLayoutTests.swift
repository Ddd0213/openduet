// Task rows in the thread (Chat/ThreadLayout.swift, prompt L102 as changed in M22): a turn's
// task rows move under the last paragraph of OpenDuet's turn, one per task, on OpenDuet's side, above
// that turn's quick replies; the Seen / Delivered line stays under the user's message; wide cards.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Task spawn layout")
struct UITaskSpawnLayoutTests {
    private static let base = Date(timeIntervalSince1970: 1_792_368_000 + 9 * 3600)
    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar
    }()

    private func message(_ id: String, _ role: Message.Role = .assistant, at minutes: Double, status: Message.Status = .sent, content: MessageContent? = nil) -> Message {
        let date = Self.base.addingTimeInterval(minutes * 60)
        return Message(
            id: id, channelId: "main", taskId: nil, role: role, text: "text", status: status, clientId: nil,
            reactions: [], createdAt: date, updatedAt: date, content: content ?? .text(TextPayload(skill: nil, attachments: []))
        )
    }

    private func chip(_ id: String, anchor: String?, at minutes: Double) -> Message {
        let date = Self.base.addingTimeInterval(minutes * 60)
        let task = TaskSummary(
            id: "task_\(id)", channelId: "main", title: "Task \(id)", status: .working, source: .user, latestUpdate: nil,
            updateCount: 0, schedule: nil, archived: false, createdAt: date, updatedAt: date
        )
        return message(id, .assistant, at: minutes, content: .taskSpawn(TaskSpawnPayload(task: task, anchorMessageId: anchor)))
    }

    private func replies(_ id: String, at minutes: Double) -> Message {
        message(id, at: minutes, content: .quickReplies(QuickRepliesPayload(options: ["Yes", "No"], chosen: nil)))
    }

    private func messageRows(_ thread: ThreadState) -> [(id: String, layout: MessageLayout, sender: ThreadSender?, gap: ThreadGap)] {
        ThreadLayout.rows(for: thread, calendar: Self.calendar).compactMap { row in
            if case .message(let m, let layout) = row.kind { (m.id, layout, row.sender, row.gap) } else { nil }
        }
    }

    private func ids(_ messages: [Message]) -> [String] {
        var thread = ThreadState(phase: .loaded)
        thread.messages = messages
        return messageRows(thread).map(\.id)
    }

    @Test("a turn's task rows move under the last paragraph of OpenDuet's turn, in order, on OpenDuet's side, tight")
    func underLastParagraph() {
        var thread = ThreadState(phase: .loaded)
        thread.messages = [
            message("u1", .user, at: 0), message("c1", at: 0.5),
            chip("k1", anchor: "u1", at: 1), chip("k2", anchor: "u1", at: 1), message("on", at: 1),
        ]
        let rows = messageRows(thread)
        #expect(rows.map(\.id) == ["u1", "c1", "on", "k1", "k2"])
        #expect(rows.filter { $0.id.hasPrefix("k") }.allSatisfy { $0.sender == .assistant && $0.gap == .tight })
    }

    @Test("quick replies stay last; OpenDuet's next message a while later is another turn")
    func repliesLastAndTurnGap() {
        #expect(ids([
            message("u1", .user, at: 0), chip("k1", anchor: "u1", at: 1), message("on", at: 1), replies("qr", at: 1),
            message("later", at: 5),
        ]) == ["u1", "on", "k1", "qr", "later"])
        // Within a minute of the last row it is still this turn.
        #expect(ids([
            message("u1", .user, at: 0), chip("k1", anchor: "u1", at: 1), message("on", at: 1.5),
        ]) == ["u1", "on", "k1"])
        // The live quick replies are OpenDuet's newest message even with a task row after them.
        let messages = [message("u1", .user, at: 0), replies("qr", at: 1), chip("k1", anchor: "u1", at: 1)]
        #expect(ThreadLayout.liveQuickReplies(messages, hasPending: false) == "qr")
    }

    @Test("a turn where OpenDuet said nothing keeps the rows under the user's message")
    func noReply() {
        #expect(ids([message("u1", .user, at: 0), chip("k1", anchor: "u1", at: 0), message("u2", .user, at: 1)]) == ["u1", "k1", "u2"])
    }

    @Test("the turn ends at the user's next message or a system line, even when the row came after it")
    func turnEnds() {
        #expect(ids([
            message("u1", .user, at: 0), message("c1", at: 0.2), message("u2", .user, at: 0.5), chip("k1", anchor: "u1", at: 1),
        ]) == ["u1", "c1", "k1", "u2"])
        let line = message("sys", .system, at: 0.6, content: .system(Phrase(text: "Stopped")))
        #expect(ids([message("u1", .user, at: 0), message("c1", at: 0.2), line, chip("k1", anchor: "u1", at: 1)]) == ["u1", "c1", "k1", "sys"])
    }

    @Test("a chip without its anchor on the page stays in place on OpenDuet's side")
    func unanchored() {
        var thread = ThreadState(phase: .loaded)
        thread.messages = [message("c", at: 0), chip("k1", anchor: nil, at: 1), chip("k2", anchor: "gone", at: 2)]
        let rows = messageRows(thread)
        #expect(rows.map(\.id) == ["c", "k1", "k2"])
        #expect(rows.allSatisfy { $0.sender == .assistant })
    }

    @Test("the receipt stays under the user's message, which keeps its tail")
    func receiptAndTail() {
        var thread = ThreadState(phase: .loaded)
        thread.messages = [
            message("u1", .user, at: 0, status: .seen), message("c1", at: 0.5), chip("k1", anchor: "u1", at: 1), message("on", at: 1),
        ]
        let rows = messageRows(thread)
        #expect(rows.first { $0.id == "u1" }?.layout.receipt == .seen)
        #expect(rows.first { $0.id == "k1" }?.layout.receipt == nil)
        #expect(rows.first { $0.id == "u1" }?.layout.tail == true)
    }

    @Test("approval, suggestion, confirmation, alert and plate cards take the full width")
    func wide() {
        let approval = Approval(
            id: "ap", kind: .email, status: .pending, version: 1,
            preview: .email(EmailPreview(app: "Gmail", to: [], cc: [], subject: "", body: "", attachments: [])),
            expiresAt: nil, taskId: nil, messageId: "a", result: nil, changedFields: [], updatedAt: Self.base
        )
        #expect(ThreadLayout.isWide(message("a", at: 0, content: .approval(approval))))
        #expect(ThreadLayout.isWide(message("p", at: 0, content: .plate(PlatePayload(items: [])))))
        #expect(ThreadLayout.isWide(message("s", at: 0, content: .taskSuggestions(TaskSuggestionsPayload(items: [])))))
        #expect(!ThreadLayout.isWide(message("t", at: 0)))
        #expect(!ThreadLayout.isWide(chip("k", anchor: nil, at: 0)))
    }
}
