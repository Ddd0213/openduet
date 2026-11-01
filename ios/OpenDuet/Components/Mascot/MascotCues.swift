// Which live events make the header mascot react (M29), and the one place they are posted.
// ChatStore.route hands every event of GET /api/events and the send streams to `MascotCues`;
// history pages, scrolling back and a relaunch never go through route, and replays (a reconnect,
// the stream catching up after a relaunch) are left out by age and by the previous task state.
import Foundation
import Observation

struct MascotCueRules: Sendable {
    /// Events older than this are a replay (or a clock far off): no reaction.
    static let fresh: TimeInterval = 20

    /// Card messages that already made it react (an edit of the same card doesn't again).
    private var cued = Set<String>()
    private var cuedOrder: [String] = []

    /// The reaction to `event`, given the task's displayed copy before the event (nil = unknown).
    mutating func reaction(to event: DuetEvent, previousTask: TaskSummary?, now: Date) -> MascotReaction? {
        guard now.timeIntervalSince(event.createdAt) < Self.fresh else { return nil }
        switch event.body {
        case .task(let task):
            // A background task finishing live: it was working here and the server says it's done.
            // A list load (no copy before) or the user's own Mark complete (already resolved) isn't.
            guard let previousTask, previousTask.status == .working, previousTask.updatedAt <= task.updatedAt,
                  task.status == .resolved || task.status == .readyForReview else { return nil }
            return .done
        case .message(let message):
            guard message.role != .user, let reaction = Self.reaction(to: message.content) else { return nil }
            return note(message.id) ? reaction : nil
        default:
            return nil
        }
    }

    /// A new card that wants the user (still open) or a failed turn.
    static func reaction(to content: MessageContent) -> MascotReaction? {
        switch content {
        case .modelError(let error): error.state == .open ? .error : nil
        case .approval(let approval): approval.status == .pending ? .needsYou : nil
        case .signIn(let signIn): signIn.state == .pending ? .needsYou : nil
        case .connectionRequest(let request): request.state == .open ? .needsYou : nil
        default: nil
        }
    }

    /// Records a card id; false when it was cued before.
    private mutating func note(_ id: String) -> Bool {
        guard cued.insert(id).inserted else { return false }
        cuedOrder.append(id)
        if cuedOrder.count > 200 { cued.remove(cuedOrder.removeFirst()) }
        return true
    }
}

/// The header mascot's live reactions: ChatStore posts, ChatHeader's mascot plays `latest`.
@MainActor
@Observable
final class MascotCues {
    static let shared = MascotCues()

    /// The newest reaction (a new value each time, so the same one twice still plays twice).
    private(set) var latest: MascotEvent?
    @ObservationIgnored private var rules = MascotCueRules()

    /// One routed event; `previousTask` is the task list's copy before it was applied.
    func note(_ event: DuetEvent, previousTask: TaskSummary?, now: Date = .now) {
        guard let reaction = rules.reaction(to: event, previousTask: previousTask, now: now) else { return }
        latest = MascotEvent(reaction)
    }
}
