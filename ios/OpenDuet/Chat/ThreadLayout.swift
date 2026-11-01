// Turns a ThreadState into the rows the main thread draws (prompt L99-L114): date separators,
// the "New" divider, bubbles and cards with their spacing, tails and Seen / Delivered, pending
// bubbles and the typing / status bubble. Pure Foundation (host-tested). M16: no footer line
// under the last message any more (the user asked to drop it).
import Foundation

enum ThreadSender: Hashable, Sendable { case user, assistant, center }

/// Vertical space above a row: 6 pt between consecutive bubbles from one sender (L82).
enum ThreadGap: Hashable, Sendable { case none, tight, group, section }

struct MessageLayout: Hashable, Sendable {
    /// "Seen" / "Delivered" under the newest user message only.
    var receipt: Message.Status?
    /// A user bubble's tail, on the last bubble of a run (iMessage style).
    var tail = false
    /// M21: quick replies of an earlier turn (the assistant or the user said something since): their
    /// options no longer take taps.
    var stale = false
}

struct ThreadRow: Identifiable, Hashable, Sendable {
    enum Kind: Hashable, Sendable {
        /// Skeleton bubbles at the top while an older page loads.
        case loadingOlder
        case dateSeparator(Date)
        case newDivider
        case message(Message, MessageLayout)
        case pending(PendingMessage, MessageLayout)
        /// The grey status bubble, or the typing dots when nil.
        case activity(StatusKey?)
    }

    var id: String
    var kind: Kind
    var sender: ThreadSender?
    var gap: ThreadGap = .none
    /// Shown at the right edge when the thread is swiped left (L114).
    var time: Date?
}

enum ThreadLayout {
    /// A gap this long starts a new date separator even on the same day.
    static let separatorInterval: TimeInterval = 60 * 60

    static func rows(for thread: ThreadState, calendar: Calendar = .autoupdatingCurrent) -> [ThreadRow] {
        var rows: [ThreadRow] = []
        if thread.loadingOlder { rows.append(ThreadRow(id: "older", kind: .loadingOlder)) }

        // A pending bubble whose echo already arrived is drawn once, as the message.
        let echoed = Set(thread.messages.compactMap(\.clientId))
        let pending = thread.pending.filter { !echoed.contains($0.clientId) }
        let messages = ordered(thread.messages)
        // A failed send that newer messages have passed stays where it was sent (by its time);
        // what is still waiting or sending, and a failed send nothing came after, stays at the end.
        // Only those at the end hold the receipt and the quick replies back.
        let newestAt = messages.map(\.createdAt).max()
        let isAnchored = { (item: PendingMessage) -> Bool in
            item.state == .failed && newestAt.map { item.createdAt < $0 } == true
        }
        var anchored = pending.filter(isAnchored).sorted { $0.createdAt < $1.createdAt }
        let trailing = pending.filter { !isAnchored($0) }
        // M22: the receipt sits under the newest user message itself again (task rows moved to
        // the assistant's side).
        let newestUser = messages.lastIndex { $0.role == .user }
        var previousDate: Date?
        var unreadPlaced = false
        let liveReplies = liveQuickReplies(messages, hasPending: !trailing.isEmpty)

        for (index, message) in messages.enumerated() {
            while let item = anchored.first, item.createdAt < message.createdAt {
                anchored.removeFirst()
                if needsSeparator(item.createdAt, after: previousDate, calendar: calendar) {
                    rows.append(ThreadRow(id: "date:\(item.clientId)", kind: .dateSeparator(item.createdAt)))
                }
                previousDate = item.createdAt
                rows.append(ThreadRow(id: "m:\(item.clientId)", kind: .pending(item, MessageLayout()), sender: .user, time: item.createdAt))
            }
            // A reply that has started but has no text yet: the typing dots stand in for it.
            if isEmptyReply(message) { continue }
            let key = message.clientId ?? message.id
            if needsSeparator(message.createdAt, after: previousDate, calendar: calendar) {
                rows.append(ThreadRow(id: "date:\(key)", kind: .dateSeparator(message.createdAt)))
            }
            previousDate = message.createdAt
            if !unreadPlaced, let lastRead = thread.lastReadAt, message.role != .user, message.createdAt > lastRead {
                rows.append(ThreadRow(id: "new", kind: .newDivider))
                unreadPlaced = true
            }
            let receipt = index == newestUser && trailing.isEmpty ? message.status : nil
            let stale = isQuickReplies(message) && message.id != liveReplies
            rows.append(ThreadRow(
                id: "m:\(key)",
                kind: .message(message, MessageLayout(receipt: receipt, stale: stale)),
                sender: sender(of: message),
                time: message.createdAt
            ))
        }
        // `anchored` is left over only when the newest message was a reply with no text yet.
        for item in anchored + trailing {
            rows.append(ThreadRow(id: "m:\(item.clientId)", kind: .pending(item, MessageLayout()), sender: .user, time: item.createdAt))
        }
        if let status = thread.statusBubble {
            rows.append(ThreadRow(id: "activity", kind: .activity(status), sender: .assistant))
        } else if thread.typing {
            rows.append(ThreadRow(id: "activity", kind: .activity(nil), sender: .assistant))
        }
        return finish(rows)
    }

    /// M21: the row a deep link's message is drawn in (ThreadState.focus); nil while it isn't on
    /// the page (not loaded yet, or a reply with no text yet).
    static func focusRow(_ focus: ThreadFocus?, in rows: [ThreadRow]) -> String? {
        guard let focus else { return nil }
        return rows.first { row in
            if case .message(let message, _) = row.kind { message.id == focus.messageId } else { false }
        }?.id
    }

    static func isEmptyReply(_ message: Message) -> Bool {
        guard message.role == .assistant, case .text(let payload) = message.content else { return false }
        return payload.attachments.isEmpty && message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Who a message belongs to: system lines and the usage-limit line sit centred. M22 (L102):
    /// task rows are the assistant's, under the last paragraph of the turn (see `ordered`).
    static func sender(of message: Message) -> ThreadSender {
        switch message.content {
        case .system, .usageLimit: return .center
        default: break
        }
        switch message.role {
        case .user: return .user
        case .assistant: return .assistant
        case .system: return .center
        }
    }

    static func isSpawnChip(_ message: Message) -> Bool {
        if case .taskSpawn = message.content { true } else { false }
    }

    static func isQuickReplies(_ message: Message) -> Bool {
        if case .quickReplies = message.content { true } else { false }
    }

    /// M21 (review C10): the one quick-replies message whose options still take taps: the assistant's
    /// newest message, with nothing from the user after it (not even a message still being sent).
    /// System lines and a reply that hasn't started don't count as newer. nil = none.
    static func liveQuickReplies(_ messages: [Message], hasPending: Bool) -> String? {
        // M22: task rows stand above the replies (they aren't something the assistant said after them).
        guard !hasPending,
              let newest = messages.last(where: { $0.role != .system && !isEmptyReply($0) && !isSpawnChip($0) }),
              newest.role == .assistant, isQuickReplies(newest) else { return nil }
        return newest.id
    }

    /// Cards that take the thread's full width (their lead bubble keeps the 80% slot).
    static func isWide(_ message: Message) -> Bool {
        switch message.content {
        case .approval, .taskSuggestions, .proactiveSuggestion, .confirmation, .alert, .plate: true
        default: false
        }
    }

    /// M22 (L102): what comes after a turn's last task row is still that turn only this soon
    /// after it (the server posts "On it" right after the row, and start_task ends the turn).
    static let turnGap: TimeInterval = 60

    /// Server order, except (M22, L102) that the task rows a turn started move under the last
    /// paragraph of the assistant's turn, in their order, above that turn's quick replies (they stay
    /// last). The turn is the one the chip's anchor (the user message that asked) opened:
    /// the assistant's messages after the anchor, up to the next user message, system line or task
    /// result, and after its last row only what follows within `turnGap`. A turn where the assistant said
    /// nothing (a suggestion card's tap) keeps the rows under the anchor. A chip whose anchor
    /// isn't on the page (or isn't before it) stays where it is.
    static func ordered(_ messages: [Message]) -> [Message] {
        var position: [String: Int] = [:]
        for (at, message) in messages.enumerated() where position[message.id] == nil { position[message.id] = at }
        // Each anchor's chips, in server order (the last one bounds the turn's gap rule).
        var byAnchor: [(anchor: Int, chips: [Int])] = []
        var slot: [Int: Int] = [:]
        for (at, message) in messages.enumerated() {
            guard case .taskSpawn(let payload) = message.content, let anchorId = payload.anchorMessageId,
                  let anchor = position[anchorId], anchor < at, !isSpawnChip(messages[anchor]) else { continue }
            if let index = slot[anchor] {
                byAnchor[index].chips.append(at)
            } else {
                slot[anchor] = byAnchor.count
                byAnchor.append((anchor, [at]))
            }
        }
        guard !byAnchor.isEmpty else { return messages }
        var under: [String: [Message]] = [:]
        var moved = Set<String>()
        for group in byAnchor {
            let target = turnEnd(from: group.anchor, lastChip: group.chips[group.chips.count - 1], in: messages)
            under[target, default: []].append(contentsOf: group.chips.map { messages[$0] })
            moved.formUnion(group.chips.map { messages[$0].id })
        }
        var result: [Message] = []
        result.reserveCapacity(messages.count)
        for message in messages where !moved.contains(message.id) {
            result.append(message)
            if let rows = under[message.id] { result.append(contentsOf: rows) }
        }
        return result
    }

    /// The id of the last message of the turn the user message at `anchor` opened (quick replies
    /// left out); the anchor itself when the assistant said nothing in it.
    private static func turnEnd(from anchor: Int, lastChip: Int, in messages: [Message]) -> String {
        var target = messages[anchor].id
        let rowsAt = messages[lastChip].createdAt
        for at in (anchor + 1)..<messages.count {
            let message = messages[at]
            // Past the rows, only what follows at once (the "On it", quick replies) is this turn's.
            if at > lastChip, message.createdAt.timeIntervalSince(rowsAt) > turnGap { break }
            if isSpawnChip(message) { continue }
            guard message.role == .assistant, sender(of: message) == .assistant, !isTaskResult(message) else { break }
            if !isQuickReplies(message) { target = message.id }
        }
        return target
    }

    private static func isTaskResult(_ message: Message) -> Bool {
        if case .text(let payload) = message.content { payload.taskResult != nil } else { false }
    }

    static func needsSeparator(_ date: Date, after previous: Date?, calendar: Calendar) -> Bool {
        guard let previous else { return true }
        return !calendar.isDate(date, inSameDayAs: previous) || date.timeIntervalSince(previous) >= separatorInterval
    }

    /// Second pass: spacing from the row above, and tails on the last bubble of a user run.
    private static func finish(_ input: [ThreadRow]) -> [ThreadRow] {
        var rows = input
        for i in rows.indices {
            rows[i].gap = i == 0 ? .none : gap(after: rows[i - 1], before: rows[i])
            let nextIsUser = i + 1 < rows.count && rows[i + 1].sender == .user
            switch rows[i].kind {
            case .message(let message, var layout) where rows[i].sender == .user:
                layout.tail = !nextIsUser
                rows[i].kind = .message(message, layout)
            case .pending(let item, var layout):
                layout.tail = !nextIsUser
                rows[i].kind = .pending(item, layout)
            default:
                break
            }
        }
        return rows
    }

    private static func gap(after previous: ThreadRow, before row: ThreadRow) -> ThreadGap {
        switch row.kind {
        case .dateSeparator, .newDivider: return .section
        default: break
        }
        switch previous.kind {
        case .dateSeparator, .newDivider, .loadingOlder: return .group
        default: break
        }
        if row.sender == .center || previous.sender == .center { return .section }
        // Receipts sit under their bubble, so the next bubble needs the larger space.
        if case .message(_, let layout) = previous.kind, layout.receipt != nil { return .group }
        return previous.sender == row.sender ? .tight : .group
    }
}
