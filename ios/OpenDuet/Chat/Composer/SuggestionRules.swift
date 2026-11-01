// M23 W5 (#29, plan §6 W5): the pure rules behind the newest Up next suggestion above the
// composer and the suggestion cards' swipe. Which suggestions float there (newest open first, not
// one an open card in this thread already shows, scoped to the channel), when they hide (typing,
// an attachment, a quote), the "From Gmail · Re: Q4 budget" line, the swipe's thresholds and its
// blur / wash / stack amounts, and when the store asks GET /api/up-next again. Pure Foundation
// (host-tested).
import CoreGraphics
import Foundation

/// What the composer floats above itself: the open Up next suggestions to show, newest first
/// (the first is the card on top, the next ones peek out under it). Built from the shell state.
struct ComposerUpNext: Hashable, Sendable {
    var stack: [Suggestion] = []

    init(stack: [Suggestion] = []) {
        self.stack = stack
    }

    /// The main thread (Everything) shows every channel's suggestions; a channel only its own.
    init(state: ShellState) {
        let scope: String? = state.thread.context == .main ? nil : state.threadChannelId
        stack = ComposerSuggestionRules.stack(state.tasks.upNext.suggestions, thread: state.thread.messages, channelId: scope)
    }
}

enum ComposerSuggestionRules {
    /// The top card plus the ones peeking out under it.
    static let maxStack = 3

    /// Newest first; none that an open card in the thread already shows (one answer, one place:
    /// the card's `suggestionId`); in a channel only that channel's (nil `channelId` = everywhere).
    static func stack(_ suggestions: [Suggestion], thread: [Message], channelId: String?) -> [Suggestion] {
        let shown = openCardSuggestionIds(thread)
        let picked = suggestions
            .filter { !shown.contains($0.id) }
            .filter { channelId == nil || $0.channelId == nil || $0.channelId == channelId }
            // Stable newest-first: the server already sends them so; equal times keep its order.
            .enumerated()
            .sorted { $0.element.createdAt != $1.element.createdAt ? $0.element.createdAt > $1.element.createdAt : $0.offset < $1.offset }
            .map(\.element)
        return Array(picked.prefix(maxStack))
    }

    /// Suggestion ids an open card in the thread already offers (a proactive card not yet started
    /// or hidden, a task_suggestions item not yet started).
    static func openCardSuggestionIds(_ messages: [Message]) -> Set<String> {
        var ids: Set<String> = []
        for message in messages {
            switch message.content {
            case .proactiveSuggestion(let card) where card.state == .open:
                if let id = card.suggestionId { ids.insert(id) }
            case .taskSuggestions(let card):
                for item in card.items where item.taskId == nil {
                    if let id = item.suggestionId { ids.insert(id) }
                }
            default:
                break
            }
        }
        return ids
    }

    /// The place above the composer is free (the card shows there when there is one): it stays
    /// out of the way while the user writes: the field focused or holding text (a candidate being
    /// composed included), an attachment, a quote, the skills list.
    static func isVisible(hasContent: Bool, focused: Bool, hasAttachments: Bool, quoting: Bool, pickingSkill: Bool) -> Bool {
        !hasContent && !focused && !hasAttachments && !quoting && !pickingSkill
    }

    /// The source line: "You asked" for one saved from the + sheet; "From Gmail · Re: Q4 budget"
    /// (the email or event it came from), "From Gmail" (only the app), else nil.
    static func sourceLine(_ suggestion: Suggestion) -> String? {
        if suggestion.fromUser == true { return String(localized: "You asked") }
        let ref = suggestion.sourceRef
        let app = trimmed(ref?.app) ?? trimmed(suggestion.app)
        let title = trimmed(ref?.title)
        switch (app, title) {
        case let (app?, title?): return String(localized: "From \(app) · \(title)")
        case let (app?, nil): return String(localized: "From \(app)")
        default: return nil
        }
    }

    private static func trimmed(_ text: String?) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }
}

/// The suggestion cards' swipe (the thread's proactive card and the one above the composer):
/// right starts, left hides. While dragging the card blurs and takes a green (Start) or grey
/// (Hide) wash with the word on its left; the cards under it rise and grow as it goes.
enum SuggestionSwipe {
    enum Outcome: Hashable, Sendable { case start, hide, cancel }

    /// A release past this many points (or 35 % of the card, whichever is more) answers it.
    static let minThreshold: CGFloat = 96
    static let widthFraction: CGFloat = 0.35
    /// A quick flick answers it from a shorter drag: at least this far, thrown twice the threshold.
    static let flickMinDistance: CGFloat = 40
    /// Horizontal must beat vertical by this much, so a scroll never turns into a swipe.
    static let directionRatio: CGFloat = 1.3

    static let maxBlur: CGFloat = 6
    static let maxWash: Double = 0.85
    /// How far each card under the top one peeks out, and how much smaller it is.
    static let peek: CGFloat = 7
    static let peekScale: CGFloat = 0.05

    static func threshold(width: CGFloat) -> CGFloat {
        max(minThreshold, width * widthFraction)
    }

    /// A drag that reads as sideways (only then does the card follow the finger).
    static func isHorizontal(dx: CGFloat, dy: CGFloat) -> Bool {
        abs(dx) > abs(dy) * directionRatio
    }

    /// What a release does. `allowsHide` false: a left swipe snaps back.
    static func outcome(dx: CGFloat, dy: CGFloat, predictedDx: CGFloat, width: CGFloat, allowsHide: Bool = true) -> Outcome {
        guard isHorizontal(dx: dx, dy: dy) else { return .cancel }
        let limit = threshold(width: width)
        let flung = abs(dx) >= flickMinDistance && abs(predictedDx) >= limit * 2 && (predictedDx > 0) == (dx > 0)
        guard abs(dx) >= limit || flung else { return .cancel }
        if dx > 0 { return .start }
        return allowsHide ? .hide : .cancel
    }

    /// 0...1: how far toward answering the drag is.
    static func progress(dx: CGFloat, width: CGFloat) -> CGFloat {
        min(abs(dx) / threshold(width: width), 1)
    }

    /// The card's blur and wash at a progress (Reduce Motion: no blur, the wash only).
    static func blur(_ progress: CGFloat, reduceMotion: Bool) -> CGFloat {
        reduceMotion ? 0 : maxBlur * clamp(progress)
    }

    static func wash(_ progress: CGFloat) -> Double {
        maxWash * Double(clamp(progress))
    }

    /// A card `depth` under the top one while the top card is `lift` (0...1) on its way out: it
    /// moves up and grows by one step as lift reaches 1. Reduce Motion: no movement.
    static func stackOffset(depth: Int, lift: CGFloat, reduceMotion: Bool) -> CGFloat {
        guard depth > 0 else { return 0 }
        let steps = reduceMotion ? CGFloat(depth) : CGFloat(depth) - clamp(lift)
        return peek * steps
    }

    static func stackScale(depth: Int, lift: CGFloat, reduceMotion: Bool) -> CGFloat {
        guard depth > 0 else { return 1 }
        let steps = reduceMotion ? CGFloat(depth) : CGFloat(depth) - clamp(lift)
        return 1 - peekScale * steps
    }

    private static func clamp(_ value: CGFloat) -> CGFloat { min(max(value, 0), 1) }
}

/// When the store asks GET /api/up-next again (the composer's suggestion follows the chat): a
/// suggestion card arriving or changing, a task it didn't know yet, a run ending (a check-in adds
/// rows without a card), deleted tasks or channels. Streaming text and status ticks don't count.
enum UpNextRefresh {
    /// Quiet time after the last relevant event before the fetch.
    static let quiet: Duration = .milliseconds(900)

    static func isRelevant(_ body: DuetEvent.Body, knowsTask: (String) -> Bool) -> Bool {
        switch body {
        case .message(let message):
            switch message.content {
            case .proactiveSuggestion, .taskSuggestions: return true
            default: return false
            }
        case .task(let task): return !knowsTask(task.id)
        case .done, .taskDeleted, .channelDeleted: return true
        default: return false
        }
    }

    /// Up next rows a card says were answered (here, in Tasks or on another device): a proactive
    /// card started or hidden, task_suggestions items started. They leave at once.
    static func answeredIds(_ body: DuetEvent.Body) -> [String] {
        guard case .message(let message) = body else { return [] }
        switch message.content {
        case .proactiveSuggestion(let card) where card.state != .open:
            return card.suggestionId.map { [$0] } ?? []
        case .taskSuggestions(let card):
            return card.items.compactMap { $0.taskId != nil ? $0.suggestionId : nil }
        default:
            return []
        }
    }
}
