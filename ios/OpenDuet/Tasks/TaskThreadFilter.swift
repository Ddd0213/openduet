// Task detail's default conversation (prompt L121, M8 brief §6, decided by the user): under the
// structured body, only what matters. Kept: the user's replies; the assistant's FIRST and LAST text of
// each turn (the acknowledgement, the result); approval cards still pending; cards that still
// want something (a live browser, a pending sign-in, an open skill, the latest turn's alert) and
// result cards; the latest failure line only when it is the last thing in the thread. Everything
// else (the assistant's in-between texts, decided cards, files, older failure lines) is in the run
// records. Files the assistant sent come back as one "N files" row. Pure Foundation (host-tested).
import Foundation

enum TaskThreadFilter {
    struct Result: Hashable, Sendable {
        var thread: ThreadState
        /// Files the assistant sent in this task, oldest first, without repeats.
        var files: [ChannelFile]
    }

    /// `keeping`: messages that stay whatever their state, e.g. an approval decided while the
    /// detail is open (its check and fold play in place instead of vanishing).
    static func apply(_ thread: ThreadState, keeping: Set<String> = []) -> Result {
        let messages = thread.messages
        var keep = keeping.intersection(messages.map(\.id))
        var files: [ChannelFile] = []
        var seenFiles = Set<String>()
        // M26: a deleted file (a tombstone with no bytes) isn't one of the task's files any more.
        func collect(_ list: [ChannelFile]) {
            for file in list where !file.isDeleted && seenFiles.insert(file.id).inserted { files.append(file) }
        }

        // Turns: everything after a user message up to the next one (the first turn may have none).
        var turns: [[Int]] = [[]]
        for (index, message) in messages.enumerated() {
            if message.role == .user && !ThreadLayout.isSpawnChip(message) {
                keep.insert(message.id)
                turns.append([])
            } else {
                turns[turns.count - 1].append(index)
            }
        }
        let lastId = messages.last?.id
        let latestTurn = turns.count - 1

        for (turn, indices) in turns.enumerated() {
            let replies = indices.filter { isReply(messages[$0]) }
            if let first = replies.first { keep.insert(messages[first].id) }
            if let last = replies.last { keep.insert(messages[last].id) }
            for index in indices {
                let message = messages[index]
                switch message.content {
                case .text(let payload):
                    if !keep.contains(message.id), message.role == .assistant { collect(payload.attachments) }
                case .file(let payload), .image(let payload):
                    if message.role == .assistant { collect([payload.file]) }
                case .approval(let approval):
                    if approval.status == .pending { keep.insert(message.id) }
                case .spendRequest(let spend):
                    if spend.status == .pending { keep.insert(message.id) }
                case .system, .usageLimit:
                    if message.id == lastId { keep.insert(message.id) }
                case .liveBrowser(let payload):
                    if payload.state == .live { keep.insert(message.id) }
                case .signIn(let payload):
                    if payload.state == .pending || payload.state == .failed { keep.insert(message.id) }
                case .skillProposal(let payload):
                    if payload.state == .open { keep.insert(message.id) }
                // M11: open cards want the user; the memory chip stays (its Undo).
                case .soulProposal(let payload):
                    if payload.state == .open { keep.insert(message.id) }
                case .connectionRequest(let payload):
                    if payload.state == .open { keep.insert(message.id) }
                case .soulSetup(let payload):
                    if payload.state == .open { keep.insert(message.id) }
                // M12: a failed turn's card stays while it can still be retried.
                case .modelError(let payload):
                    if payload.state == .open || message.id == lastId { keep.insert(message.id) }
                case .memoryNote:
                    keep.insert(message.id)
                case .alert:
                    if turn == latestTurn { keep.insert(message.id) }
                case .artifact, .confirmation, .plate, .taskSuggestions, .proactiveSuggestion, .form, .card, .call:
                    keep.insert(message.id)
                case .quickReplies, .taskSpawn, .unsupported:
                    break
                }
            }
        }

        var result = thread
        result.messages = messages.filter { keep.contains($0.id) }
        return Result(thread: result, files: files)
    }

    /// Cards still waiting for the user (pending approvals and spend requests): kept for the
    /// rest of the visit once seen, so deciding one plays its check / fold where it is.
    static func awaitingUser(_ messages: [Message]) -> Set<String> {
        var ids = Set<String>()
        for message in messages {
            switch message.content {
            case .approval(let approval) where approval.status == .pending: ids.insert(message.id)
            case .spendRequest(let spend) where spend.status == .pending: ids.insert(message.id)
            default: break
            }
        }
        return ids
    }

    /// The assistant's words in a turn: a text bubble (with text) or a question with quick-reply chips.
    static func isReply(_ message: Message) -> Bool {
        guard message.role == .assistant else { return false }
        switch message.content {
        case .text, .quickReplies: return !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        default: return false
        }
    }
}
