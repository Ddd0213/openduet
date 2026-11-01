// ThreadLayout: the main thread's rows (date separators, the "New" divider, Seen / Delivered,
// tails, pending bubbles, spacing, typing / status bubble). M16: no footer row under the last
// message.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Thread layout")
struct UIThreadLayoutTests {
    private static let base = Date(timeIntervalSince1970: 1_792_368_000 + 9 * 3600)  // 2026-10-19 09:00 UTC
    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar
    }()

    private func message(
        _ id: String, _ role: Message.Role = .assistant, at minutes: Double,
        status: Message.Status = .sent, clientId: String? = nil, content: MessageContent? = nil
    ) -> Message {
        let date = Self.base.addingTimeInterval(minutes * 60)
        return Message(
            id: id, channelId: "main", taskId: nil, role: role, text: "text", status: status, clientId: clientId,
            reactions: [], createdAt: date, updatedAt: date,
            content: content ?? .text(TextPayload(skill: nil, attachments: []))
        )
    }

    private func rows(_ thread: ThreadState) -> [ThreadRow] {
        ThreadLayout.rows(for: thread, calendar: Self.calendar)
    }

    private func ids(_ thread: ThreadState) -> [String] { rows(thread).map(\.id) }

    @Test("a date separator before the first message, after an hour's gap and on a new day")
    func separators() {
        var thread = ThreadState(phase: .loaded)
        thread.messages = [message("a", at: 0), message("b", at: 30), message("c", at: 120), message("d", at: 24 * 60)]
        #expect(ids(thread) == ["date:a", "m:a", "m:b", "date:c", "m:c", "date:d", "m:d"])
    }

    @Test("the New divider goes above the first non-user message after lastReadAt")
    func newDivider() {
        var thread = ThreadState(phase: .loaded)
        thread.messages = [message("a", at: 0), message("u", .user, at: 2), message("b", at: 3), message("c", at: 4)]
        thread.lastReadAt = Self.base.addingTimeInterval(60)
        #expect(ids(thread) == ["date:a", "m:a", "m:u", "new", "m:b", "m:c"])
        thread.lastReadAt = nil
        #expect(!ids(thread).contains("new"))
    }

    @Test("Seen / Delivered only under the newest user message, and not while one is pending")
    func receipts() {
        var thread = ThreadState(phase: .loaded)
        thread.messages = [message("u1", .user, at: 0), message("u2", .user, at: 1, status: .seen), message("c", at: 2)]
        let receipts = rows(thread).compactMap { row -> String? in
            if case .message(let m, let layout) = row.kind, let receipt = layout.receipt { "\(m.id):\(receipt)" } else { nil }
        }
        #expect(receipts == ["u2:seen"])

        thread.pending = [PendingMessage(clientId: "p1", text: "hi", attachments: [], createdAt: Self.base, state: .waiting)]
        let none = rows(thread).contains { if case .message(_, let layout) = $0.kind { layout.receipt != nil } else { false } }
        #expect(!none)
    }

    @Test("user bubbles get a tail on the last of a run")
    func tails() {
        var thread = ThreadState(phase: .loaded)
        thread.messages = [message("u1", .user, at: 0), message("u2", .user, at: 1), message("c", at: 2)]
        let tails = rows(thread).compactMap { row -> Bool? in
            if case .message(let m, let layout) = row.kind, m.role == .user { layout.tail } else { nil }
        }
        #expect(tails == [false, true])
    }

    @Test("a pending bubble whose echo arrived is drawn once, under the same row id")
    func pendingEcho() {
        var thread = ThreadState(phase: .loaded)
        thread.pending = [PendingMessage(clientId: "local-1", text: "hi", attachments: [], createdAt: Self.base, state: .sending)]
        #expect(ids(thread) == ["m:local-1"])
        thread.messages = [message("srv-1", .user, at: 0, clientId: "local-1")]
        #expect(ids(thread) == ["date:local-1", "m:local-1"])
    }

    @Test("6 pt between bubbles of one sender, more between senders and around system lines")
    func gaps() {
        var thread = ThreadState(phase: .loaded)
        thread.messages = [
            message("a", at: 0), message("b", at: 1), message("u", .user, at: 2),
            message("s", .system, at: 3, content: .system(Phrase(key: "system.feedback_thanks"))),
        ]
        #expect(rows(thread).map(\.gap) == [.none, .group, .tight, .group, .section])
    }

    @Test("the status bubble replaces the typing dots under one row id")
    func activity() {
        var thread = ThreadState(phase: .loaded)
        thread.typing = true
        #expect(rows(thread).map(\.kind) == [.activity(nil)])
        thread.statusBubble = .checking
        #expect(rows(thread).map(\.kind) == [.activity(.checking)])
        #expect(rows(thread).map(\.id) == ["activity"])
    }

    @Test("an OpenDuet reply with no text yet draws no bubble")
    func emptyReply() {
        var thread = ThreadState(phase: .loaded)
        var empty = message("e", at: 0)
        empty.text = ""
        thread.messages = [message("a", at: 0), empty]
        thread.typing = true
        #expect(ids(thread) == ["date:a", "m:a", "activity"])
    }

    @Test("skeletons on top while an older page loads")
    func loadingOlder() {
        var thread = ThreadState(phase: .loaded)
        thread.loadingOlder = true
        thread.messages = [message("a", at: 0)]
        #expect(ids(thread) == ["older", "date:a", "m:a"])
    }

    private func pending(_ id: String, at minutes: Double, _ state: PendingMessage.State) -> PendingMessage {
        PendingMessage(clientId: id, text: "hi", attachments: [], createdAt: Self.base.addingTimeInterval(minutes * 60), state: state)
    }

    private func receipts(_ thread: ThreadState) -> [String] {
        rows(thread).compactMap { row -> String? in
            if case .message(let m, let layout) = row.kind, let receipt = layout.receipt { "\(m.id):\(receipt)" } else { nil }
        }
    }

    @Test("a failed send that newer messages passed stays at its time; it doesn't hold the receipt back")
    func failedStaysInPlace() {
        // The 2026-10-30 case: sends refused at the usage limit, then a later message went through.
        var thread = ThreadState(phase: .loaded)
        thread.messages = [message("a", at: 0), message("b", at: 1), message("c", .user, at: 25, status: .seen)]
        thread.pending = [pending("f1", at: 21, .failed), pending("f2", at: 22, .failed)]
        #expect(ids(thread) == ["date:a", "m:a", "m:b", "m:f1", "m:f2", "m:c"])
        #expect(receipts(thread) == ["c:seen"])
        // An hour after the message before it, it gets its own date separator.
        thread.pending = [pending("f3", at: 90, .failed)]
        thread.messages.append(message("d", at: 120))
        #expect(ids(thread) == ["date:a", "m:a", "m:b", "m:c", "date:f3", "m:f3", "m:d"])
    }

    @Test("still sending, waiting, or failed with nothing after it: at the end, holding the receipt back")
    func pendingAtTheEnd() {
        var thread = ThreadState(phase: .loaded)
        thread.messages = [message("u", .user, at: 0, status: .seen), message("c", at: 5)]
        thread.pending = [pending("f", at: 10, .failed)]
        #expect(ids(thread) == ["date:u", "m:u", "m:c", "m:f"])
        #expect(receipts(thread).isEmpty)
        // A message being sent stays last even if its clock reads earlier than the server's.
        thread.pending = [pending("s", at: 3, .sending), pending("w", at: 4, .waiting)]
        #expect(ids(thread) == ["date:u", "m:u", "m:c", "m:s", "m:w"])
        #expect(receipts(thread).isEmpty)
    }

    @Test("a failed send passed by OpenDuet's quick replies doesn't freeze their options")
    func failedDoesNotFreezeReplies() {
        var thread = ThreadState(phase: .loaded)
        let replies = message("q", at: 2, content: .quickReplies(QuickRepliesPayload(options: ["Yes", "No"], chosen: nil)))
        thread.messages = [message("a", at: 0), replies]
        thread.pending = [pending("f", at: 1, .failed)]
        let stale = rows(thread).compactMap { row -> Bool? in
            if case .message(let m, let layout) = row.kind, m.id == "q" { layout.stale } else { nil }
        }
        #expect(stale == [false])
        #expect(ids(thread) == ["date:a", "m:a", "m:f", "m:q"])
    }
}
