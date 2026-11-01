// The Tasks tab's Active list (prompt L117, L185): tasks grouped in a fixed order with counts,
// sorted, filtered by the inline search, and the match ranges the rows highlight. M9: pinned
// tasks first, in their own "Pinned" group. M22 (plan §5 「任务列表分类」): grouped by what they
// need from you now: Pinned → Ready for review → Waiting on you → Failed → Working → Just done
// (resolved within 24 h) → Done (within 7 days, folded); routines leave Active for Up next's
// "Coming up" unless a run of theirs is going. Also the row rules (source label, Try again,
// Reopen, the status line's text) and the ~0.45 s a checked row stays put. Pure Foundation
// (host-tested); the views only draw what this returns.
import Foundation

enum TaskGroupKind: String, CaseIterable, Hashable, Sendable {
    /// M9: pinned tasks still in progress, above everything (contract §4)
    case pinned
    case readyForReview
    /// "Waiting on you": needs input (a question, an approval, a sign-in), plus the Needs you cards
    /// outside any task at its top
    case needsInput
    /// M22: the last run failed (TaskSummary.failure)
    case failed
    case working
    /// M22: only in a search's answer: a routine waiting for its next run (its home is Up next's
    /// "Coming up")
    case comingUp
    /// M22: resolved within the last 24 hours
    case justDone
    /// M22: resolved within the last 7 days (older ones are behind "Earlier")
    case done

    /// M22: only Done folds, and it starts folded (its title then shows no number).
    var isCollapsible: Bool { self == .done }
    var startsCollapsed: Bool { self == .done }
}

struct TaskGroup: Identifiable, Hashable, Sendable {
    var kind: TaskGroupKind
    var tasks: [TaskSummary]
    var id: TaskGroupKind { kind }
}

enum TaskSort: String, CaseIterable, Hashable, Sendable {
    /// Newest update first (the server's order).
    case updated
    /// Newest first by creation.
    case created
}

/// M22: where a row stands in Active: one of the groups, Up next's "Coming up" (a routine
/// waiting for its next run), or nowhere (resolved more than 7 days ago: behind "Earlier").
enum TaskPlace: Hashable, Sendable {
    case group(TaskGroupKind)
    case comingUp
    case hidden
}

enum TaskGrouping {
    /// M22: a task resolved this recently is "Just done"; up to `doneWindow` it is "Done".
    static let justDoneWindow: TimeInterval = 24 * 3600
    static let doneWindow: TimeInterval = 7 * 24 * 3600
    /// M22 (review-ux §9, the reference's CHECK_HOLD_MS): a checked (or reopened) row stays in its
    /// group this long so the tick is seen, then moves (without a slide under Reduce Motion).
    static let checkHold: Double = 0.45

    /// Active's groups in order; a group with no tasks is left out. `holding` keeps a just-checked
    /// row in the group it was in. `searching`: the rows are a search's (any age, no Coming up),
    /// already matched by the server; `query` only filters the list's own rows while it answers.
    static func groups(
        _ tasks: [TaskSummary], sort: TaskSort = .updated, query: String = "", now: Date = Date(),
        holding: [String: TaskGroupKind] = [:], running: Set<String> = [], searching: Bool = false
    ) -> [TaskGroup] {
        let needle = normalized(query)
        var byKind: [TaskGroupKind: [TaskSummary]] = [:]
        for task in tasks where !task.archived {
            if !needle.isEmpty && matches(in: task.title, query: needle).isEmpty { continue }
            let kind: TaskGroupKind
            if let held = holding[task.id] {
                kind = held
            } else {
                switch place(of: task, now: now, running: running.contains(task.id)) {
                case .group(let group): kind = group
                // A search lists routines and old tasks too.
                case .comingUp where searching: kind = .comingUp
                case .hidden where searching: kind = .done
                case .comingUp, .hidden: continue
                }
            }
            byKind[kind, default: []].append(task)
        }
        return TaskGroupKind.allCases.compactMap { kind in
            guard let tasks = byKind[kind], !tasks.isEmpty else { return nil }
            return TaskGroup(kind: kind, tasks: sorted(tasks, kind: kind, sort: sort))
        }
    }

    /// M22: `groups` with an empty group of `kind` in its place when there is none (Waiting on you
    /// holding only Needs you cards; Done holding only "Earlier").
    static func ensuring(_ kind: TaskGroupKind, in groups: [TaskGroup]) -> [TaskGroup] {
        guard !groups.contains(where: { $0.kind == kind }) else { return groups }
        let order = TaskGroupKind.allCases
        let rank = order.firstIndex(of: kind) ?? 0
        let index = groups.firstIndex { (order.firstIndex(of: $0.kind) ?? 0) > rank } ?? groups.endIndex
        var result = groups
        result.insert(TaskGroup(kind: kind, tasks: []), at: index)
        return result
    }

    /// M22: the routines for Up next's "Coming up" (those not running a turn now), next run first;
    /// paused ones last.
    static func comingUp(_ tasks: [TaskSummary], now: Date = Date(), running: Set<String> = []) -> [TaskSummary] {
        tasks.filter { !$0.archived && place(of: $0, now: now, running: running.contains($0.id)) == .comingUp }
            .sorted { a, b in
                let pa = a.routine?.paused == true, pb = b.routine?.paused == true
                if pa != pb { return !pa }
                switch (a.routine?.nextRunAt, b.routine?.nextRunAt) {
                case let (x?, y?) where x != y: return x < y
                case (.some, nil): return true
                case (nil, .some): return false
                default: return a.id < b.id
                }
            }
    }

    /// Where a task stands. A pinned task in progress sits in Pinned; a routine waits in Coming
    /// up, and shows in Working (a run is going) or Waiting on you (a run stopped for you) only
    /// while that lasts; a "once" routine that ran is resolved like any task.
    static func place(of task: TaskSummary, now: Date = Date(), running: Bool = false) -> TaskPlace {
        if task.status == .resolved { return resolvedPlace(task, now: now) }
        if task.routine != nil || task.status == .scheduled {
            if task.failure != nil || task.status == .needsInput { return .group(.needsInput) }
            if running || task.status == .working { return .group(.working) }
            return .comingUp
        }
        if task.pinned { return .group(.pinned) }
        if task.status == .readyForReview { return .group(.readyForReview) }
        if task.failure != nil { return .group(.failed) }
        if task.status == .needsInput { return .group(.needsInput) }
        return .group(.working)
    }

    /// Just done (24 h), Done (7 days) or behind "Earlier", by `resolvedAt` (an older server's
    /// task: its last update).
    static func resolvedPlace(_ task: TaskSummary, now: Date) -> TaskPlace {
        let age = now.timeIntervalSince(task.resolvedAt ?? task.updatedAt)
        if age < justDoneWindow { return .group(.justDone) }
        if age < doneWindow { return .group(.done) }
        return .hidden
    }

    /// M9 kept: a group's own order. Just done / Done: most recently resolved first.
    static func sorted(_ tasks: [TaskSummary], kind: TaskGroupKind, sort: TaskSort) -> [TaskSummary] {
        tasks.sorted { a, b in
            switch sort {
            case .created:
                return a.createdAt != b.createdAt ? a.createdAt > b.createdAt : a.id < b.id
            case .updated:
                let x = kind == .justDone || kind == .done ? (a.resolvedAt ?? a.updatedAt) : a.updatedAt
                let y = kind == .justDone || kind == .done ? (b.resolvedAt ?? b.updatedAt) : b.updatedAt
                return x != y ? x > y : a.id < b.id
            }
        }
    }

    /// M22: the routines a run is going for, from the loaded run histories (queued or running).
    static func runningRoutines(_ runs: [String: [RunRecord]]) -> Set<String> {
        Set(runs.filter { $0.value.contains { $0.status == .queued || $0.status == .running } }.keys)
    }

    /// M22: the Needs you cards outside any task that head Waiting on you: in a channel's scope
    /// only that channel's.
    static func needsYouCards(_ needsYou: NeedsYou?, scope: String?) -> [NeedsYouItem.Card] {
        guard let needsYou else { return [] }
        return needsYou.items.compactMap { item in
            guard case .card(let card) = item, scope == nil || card.channelId == scope else { return nil }
            return card
        }
    }

    /// Where `query` occurs in `title`, case- and diacritic-insensitive, in order and not
    /// overlapping. An empty query matches nothing (no highlight).
    static func matches(in title: String, query: String) -> [Range<String.Index>] {
        let needle = normalized(query)
        guard !needle.isEmpty else { return [] }
        var ranges: [Range<String.Index>] = []
        var start = title.startIndex
        while start < title.endIndex,
              let found = title.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], range: start..<title.endIndex) {
            ranges.append(found)
            start = found.isEmpty ? title.index(after: found.lowerBound) : found.upperBound
        }
        return ranges
    }

    static func normalized(_ query: String) -> String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - M22: what a row says

/// The small source label on a row (plan candidate 4): the user asked, it came from an app's
/// suggestion, or the assistant suggested it.
enum TaskSourceLabel: Hashable, Sendable {
    case youAsked
    case fromApp(String)
    case assistantSuggested

    init(_ task: TaskSummary) {
        if let app = task.app?.trimmingCharacters(in: .whitespacesAndNewlines), !app.isEmpty {
            self = .fromApp(app)
        } else {
            self = task.source == .user ? .youAsked : .assistantSuggested
        }
    }
}

/// The text after the status word (review-ux §1): what the task needs from you when it says so,
/// else the latest update, else "Just started" / "Updated …".
enum TaskStatusText: Hashable, Sendable {
    /// failure != nil: "Couldn't finish" + the reason
    case failed(Phrase)
    case nextStep(Phrase)
    case update(Phrase)
    case justStarted
    case updated(Date)

    init(_ task: TaskSummary) {
        if let failure = task.failure {
            self = .failed(failure.reason)
        } else if let next = task.nextStep, task.status != .resolved {
            self = .nextStep(next.text)
        } else if let update = task.latestUpdate {
            self = .update(update.text)
        } else if task.status == .working && task.updateCount == 0 {
            self = .justStarted
        } else {
            self = .updated(task.updatedAt)
        }
    }
}

/// When a row's buttons apply.
enum TaskRowRules {
    /// "Try again" under a failed row: only when running it again can help.
    static func canRetry(_ task: TaskSummary) -> Bool {
        task.failure?.retryable == true && task.status != .resolved && !task.archived
    }

    /// The check of a resolved row reopens it (a routine never resolves; one that did is a "once").
    static func canReopen(_ task: TaskSummary) -> Bool {
        task.status == .resolved && !task.archived
    }

    /// M22: a routine paused by the fatigue rule says so (task.routine_paused_failures {count}).
    static func pausedByFailures(_ routine: Routine) -> Phrase? {
        guard routine.paused, routine.pausedBy == .failures else { return nil }
        return Phrase(key: "task.routine_paused_failures", params: ["count": .number(Double(max(routine.failStreak, 1)))], text: nil)
    }
}

/// M22 (review-ux §14): the line under the empty Up next's "Show me", so a tap always ends in an
/// answer: looking (the capsule's own spinner), slow after `slowAfter`, nothing new, or failed.
enum ShowMeFeedback: Hashable, Sendable {
    case none
    /// "This is taking a while. New tasks show up here."
    case slow
    /// "Nothing new right now. I'll keep checking."
    case nothingNew
    /// "Couldn't check just now." + the reason, with Retry (= Show me again)
    case failed(String)

    static let slowAfter: TimeInterval = 60

    static func line(scanning: Bool, startedAt: Date?, foundNothing: Bool, failure: String?, now: Date) -> ShowMeFeedback {
        if scanning {
            guard let startedAt, now.timeIntervalSince(startedAt) >= slowAfter else { return .none }
            return .slow
        }
        if let failure { return .failed(failure) }
        return foundNothing ? .nothingNew : .none
    }

    /// When a running scan turns slow (nil: not scanning, or already slow).
    static func slowAt(scanning: Bool, startedAt: Date?, now: Date) -> Date? {
        guard scanning, let startedAt else { return nil }
        let at = startedAt.addingTimeInterval(slowAfter)
        return at > now ? at : nil
    }
}
