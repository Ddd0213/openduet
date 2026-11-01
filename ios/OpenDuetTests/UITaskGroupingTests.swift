// The Tasks tab's Active list (Tasks/TaskGrouping.swift): M22's groups in order (Pinned → Ready
// for review → Waiting on you → Failed → Working → Just done → Done), the 24 h / 7 day windows,
// routines in Up next's Coming up, the check hold, sorting, the inline search filter and the
// highlighted match ranges; the row rules (source label, status text, Try again, Reopen, paused
// by failures) and the Show me answer line.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Task grouping")
struct UITaskGroupingTests {
    private static let base = Date(timeIntervalSince1970: 1_792_400_000)
    /// "Now" for the windows: 10 days after `base`.
    private static let now = base.addingTimeInterval(10 * day)
    private static let hour: TimeInterval = 3600
    private static let day: TimeInterval = 24 * 3600

    private func task(
        _ id: String, _ status: TaskStatus, title: String? = nil, updated: Double = 0, created: Double = 0, archived: Bool = false,
        resolvedAgo: TimeInterval? = nil, pinned: Bool = false, failure: Bool? = nil, routine: Routine? = nil,
        source: TaskSummary.Source = .user, app: String? = nil
    ) -> TaskSummary {
        var task = TaskSummary(
            id: id, channelId: "main", title: title ?? id, status: status, source: source, latestUpdate: nil,
            updateCount: 0, schedule: nil, archived: archived,
            createdAt: Self.base.addingTimeInterval(created * 60), updatedAt: Self.base.addingTimeInterval(updated * 60)
        )
        task.pinned = pinned
        task.routine = routine
        task.app = app
        task.resolvedAt = resolvedAgo.map { Self.now.addingTimeInterval(-$0) }
        if let failure { task.failure = TaskFailure(reason: Phrase(text: "The site was down"), retryable: failure, at: Self.base) }
        return task
    }

    private func routine(paused: Bool = false, next: TimeInterval? = nil) -> Routine {
        Routine(paused: paused, quiet: false, nextRunAt: next.map { Self.now.addingTimeInterval($0) }, lastRunAt: nil, lastRunStatus: nil)
    }

    private func layout(_ groups: [TaskGroup]) -> [String] {
        groups.map { "\($0.kind.rawValue):\($0.tasks.map(\.id).joined(separator: ","))" }
    }

    @Test("groups: Pinned, Ready for review, Waiting on you, Failed, Working, Just done, Done; empty ones left out")
    func order() {
        let tasks = [
            task("w", .working, updated: 5), task("j1", .resolved, resolvedAgo: 3 * Self.hour), task("n", .needsInput, updated: 3),
            task("rv1", .readyForReview, updated: 4), task("rv2", .readyForReview, updated: 2), task("p", .working, pinned: true),
            task("f", .working, failure: true), task("j2", .resolved, resolvedAgo: Self.hour), task("d", .resolved, resolvedAgo: 3 * Self.day),
            task("old", .resolved, resolvedAgo: 8 * Self.day),
        ]
        #expect(layout(TaskGrouping.groups(tasks, now: Self.now)) == [
            "pinned:p", "readyForReview:rv1,rv2", "needsInput:n", "failed:f", "working:w", "justDone:j2,j1", "done:d",
        ])
        // A failure wins over the status word (a failed run that also asks something is Failed).
        #expect(TaskGrouping.place(of: task("fn", .needsInput, failure: false), now: Self.now) == .group(.failed))
    }

    @Test("Just done is under 24 h, Done under 7 days, older is behind Earlier; no resolvedAt falls back to the last update")
    func windows() {
        func place(_ ago: TimeInterval) -> TaskPlace { TaskGrouping.place(of: task("r", .resolved, resolvedAgo: ago), now: Self.now) }
        #expect(place(Self.day - 1) == .group(.justDone))
        #expect(place(Self.day) == .group(.done))
        #expect(place(7 * Self.day - 1) == .group(.done))
        #expect(place(7 * Self.day) == .hidden)
        // updated at `base` = 10 days before now
        #expect(TaskGrouping.place(of: task("r", .resolved), now: Self.now) == .hidden)
        #expect(TaskGrouping.place(of: task("r", .resolved), now: Self.base.addingTimeInterval(Self.hour)) == .group(.justDone))
    }

    @Test("routines wait in Coming up; a run going shows in Working, one stopped for you in Waiting on you; a once that ran is Done")
    func routines() {
        let waiting = task("r", .scheduled, routine: routine(next: Self.hour))
        #expect(TaskGrouping.place(of: waiting, now: Self.now) == .comingUp)
        #expect(TaskGrouping.place(of: waiting, now: Self.now, running: true) == .group(.working))
        #expect(TaskGrouping.place(of: task("r", .working, routine: routine()), now: Self.now) == .group(.working))
        #expect(TaskGrouping.place(of: task("r", .needsInput, routine: routine()), now: Self.now) == .group(.needsInput))
        #expect(TaskGrouping.place(of: task("r", .scheduled, failure: true, routine: routine()), now: Self.now) == .group(.needsInput))
        #expect(TaskGrouping.place(of: task("r", .resolved, resolvedAgo: Self.hour, routine: routine()), now: Self.now) == .group(.justDone))
        #expect(TaskGrouping.groups([waiting], now: Self.now).isEmpty)
        // Coming up: next run first, no next run after, paused last.
        let list = [
            task("p", .scheduled, routine: routine(paused: true)), task("late", .scheduled, routine: routine(next: 5 * Self.hour)),
            task("none", .scheduled, routine: routine()), task("soon", .scheduled, routine: routine(next: Self.hour)),
            task("run", .scheduled, routine: routine(next: 2 * Self.hour)),
        ]
        #expect(TaskGrouping.comingUp(list, now: Self.now, running: ["run"]).map(\.id) == ["soon", "late", "none", "p"])
        let runs = ["a": [RunRecord(id: "1", kind: .routine, scheduledFor: nil, startedAt: nil, status: .running)],
                    "b": [RunRecord(id: "2", kind: .routine, scheduledFor: nil, startedAt: nil, status: .completed)]]
        #expect(TaskGrouping.runningRoutines(runs) == ["a"])
    }

    @Test("a search lists routines (Coming up) and old tasks (Done) too")
    func searching() {
        let tasks = [task("r", .scheduled, routine: routine(next: Self.hour)), task("old", .resolved, resolvedAgo: 30 * Self.day)]
        #expect(layout(TaskGrouping.groups(tasks, now: Self.now, searching: true)) == ["comingUp:r", "done:old"])
        #expect(TaskGrouping.groups(tasks, now: Self.now).isEmpty)
    }

    @Test("a just-checked row stays in its group; ensuring puts an empty group in its place")
    func holdAndEnsure() {
        let done = task("w", .resolved, resolvedAgo: 1)
        #expect(layout(TaskGrouping.groups([done], now: Self.now, holding: ["w": .working])) == ["working:w"])
        #expect(TaskGrouping.checkHold == 0.45)
        let groups = TaskGrouping.groups([task("n", .needsInput), done], now: Self.now)
        #expect(TaskGrouping.ensuring(.failed, in: groups).map(\.kind) == [.needsInput, .failed, .justDone])
        #expect(TaskGrouping.ensuring(.done, in: groups).map(\.kind) == [.needsInput, .justDone, .done])
        #expect(TaskGrouping.ensuring(.needsInput, in: groups) == groups)
    }

    @Test("only Done folds, and it starts folded")
    func folding() {
        #expect(TaskGroupKind.allCases.filter(\.isCollapsible) == [.done])
        #expect(TaskGroupKind.allCases.filter(\.startsCollapsed) == [.done])
    }

    @Test("archived tasks never show")
    func archived() {
        let groups = TaskGrouping.groups([task("a", .working, archived: true), task("b", .working)], now: Self.now)
        #expect(layout(groups) == ["working:b"])
        #expect(TaskGrouping.groups([task("a", .working, archived: true)], now: Self.now).isEmpty)
    }

    @Test("sort by last update or by creation, newest first, ties by id")
    func sorting() {
        let tasks = [
            task("a", .working, updated: 1, created: 9), task("b", .working, updated: 9, created: 1),
            task("c", .working, updated: 5, created: 5), task("d", .working, updated: 5, created: 5),
        ]
        #expect(layout(TaskGrouping.groups(tasks, sort: .updated, now: Self.now)) == ["working:b,c,d,a"])
        #expect(layout(TaskGrouping.groups(tasks, sort: .created, now: Self.now)) == ["working:a,c,d,b"])
    }

    @Test("search keeps matching titles only, ignoring case, accents and surrounding spaces")
    func filter() {
        let tasks = [
            task("1", .working, title: "Order from the Café"), task("2", .needsInput, title: "Book the venue"),
            task("3", .resolved, title: "cafe receipts", resolvedAgo: Self.hour), task("4", .working, title: "整理预算表"),
        ]
        #expect(layout(TaskGrouping.groups(tasks, query: "  CAFE ", now: Self.now)) == ["working:1", "justDone:3"])
        #expect(layout(TaskGrouping.groups(tasks, query: "预算", now: Self.now)) == ["working:4"])
        #expect(TaskGrouping.groups(tasks, query: "nothing like it", now: Self.now).isEmpty)
        #expect(TaskGrouping.groups(tasks, query: "   ", now: Self.now).flatMap(\.tasks).count == 4)
    }

    @Test("match ranges cover every occurrence, without overlap")
    func ranges() {
        let title = "Budget review: budget and BUDGET"
        let found = TaskGrouping.matches(in: title, query: "budget").map { String(title[$0]) }
        #expect(found == ["Budget", "budget", "BUDGET"])
        let overlapping = "aaaa"
        #expect(TaskGrouping.matches(in: overlapping, query: "aa").map { String(overlapping[$0]) } == ["aa", "aa"])
        #expect(TaskGrouping.matches(in: title, query: "").isEmpty)
        #expect(TaskGrouping.matches(in: title, query: " ").isEmpty)
        let accented = "Résumé review"
        #expect(TaskGrouping.matches(in: accented, query: "resume").map { String(accented[$0]) } == ["Résumé"])
        let chinese = "整理预算表和预算"
        #expect(TaskGrouping.matches(in: chinese, query: "预算").count == 2)
    }

    // MARK: - M22 row rules

    @Test("source label: You asked (user, no app), From <app> (app set), OpenDuet suggested (proactive, no app)")
    func sourceLabel() {
        #expect(TaskSourceLabel(task("a", .working)) == .youAsked)
        #expect(TaskSourceLabel(task("a", .working, app: "Gmail")) == .fromApp("Gmail"))
        #expect(TaskSourceLabel(task("a", .working, source: .proactive, app: " Slack ")) == .fromApp("Slack"))
        #expect(TaskSourceLabel(task("a", .working, source: .proactive)) == .assistantSuggested)
        #expect(TaskSourceLabel(task("a", .working, source: .proactive, app: "  ")) == .assistantSuggested)
    }

    @Test("status text: the failure, else the next step (not once resolved), else the latest update")
    func statusText() {
        let next = Phrase(key: "task.next.answer", params: nil, text: nil)
        let update = Phrase(text: "Read 3 emails")
        var t = task("a", .needsInput)
        t.nextStep = TaskNextStep(kind: .answer, text: next)
        t.latestUpdate = TaskUpdate(text: update, source: "Claude", at: Self.base)
        #expect(TaskStatusText(t) == .nextStep(next))
        t.status = .resolved
        #expect(TaskStatusText(t) == .update(update))
        t.failure = TaskFailure(reason: Phrase(text: "No access"), retryable: false, at: Self.base)
        #expect(TaskStatusText(t) == .failed(Phrase(text: "No access")))
        #expect(TaskStatusText(task("b", .working)) == .justStarted)
        #expect(TaskStatusText(task("c", .needsInput, updated: 2)) == .updated(Self.base.addingTimeInterval(120)))
    }

    @Test("Try again only for a retryable failure; Reopen only on a resolved, unarchived row")
    func retryAndReopen() {
        #expect(TaskRowRules.canRetry(task("a", .working, failure: true)))
        #expect(!TaskRowRules.canRetry(task("a", .working, failure: false)))
        #expect(!TaskRowRules.canRetry(task("a", .working)))
        #expect(!TaskRowRules.canRetry(task("a", .resolved, failure: true)))
        #expect(!TaskRowRules.canRetry(task("a", .working, archived: true, failure: true)))
        #expect(TaskRowRules.canReopen(task("a", .resolved)))
        #expect(!TaskRowRules.canReopen(task("a", .resolved, archived: true)))
        #expect(!TaskRowRules.canReopen(task("a", .readyForReview)))
    }

    @Test("a routine paused by failures says so with its streak; one the user paused doesn't")
    func pausedByFailures() {
        var paused = routine(paused: true)
        paused.pausedBy = .failures
        paused.failStreak = 3
        let phrase = TaskRowRules.pausedByFailures(paused)
        #expect(phrase?.key == "task.routine_paused_failures")
        #expect(phrase?.params?["count"] == .number(3))
        paused.pausedBy = .user
        #expect(TaskRowRules.pausedByFailures(paused) == nil)
        var running = routine()
        running.pausedBy = .failures
        #expect(TaskRowRules.pausedByFailures(running) == nil)
    }

    @Test("Needs you cards head Waiting on you; a channel's scope shows only its own")
    func needsYouCards() {
        func card(_ id: String, _ channel: String) -> NeedsYouItem.Card {
            NeedsYouItem.Card(kind: .approval, messageId: id, channelId: channel, title: id, detail: Phrase(text: "Send it?"),
                              route: "duet://channels/\(channel)?message=\(id)", at: Self.base)
        }
        let needsYou = NeedsYou(count: 3, items: [.card(card("m1", "a")), .task(task("t", .needsInput)), .card(card("m2", "b"))])
        #expect(TaskGrouping.needsYouCards(needsYou, scope: nil).map(\.messageId) == ["m1", "m2"])
        #expect(TaskGrouping.needsYouCards(needsYou, scope: "b").map(\.messageId) == ["m2"])
        #expect(TaskGrouping.needsYouCards(nil, scope: nil).isEmpty)
    }

    @Test("Show me always answers: slow after 60 s, nothing new when the scan ended empty, the failure")
    func showMeFeedback() {
        let start = Self.base
        func line(_ scanning: Bool, after: TimeInterval, nothing: Bool = false, failure: String? = nil) -> ShowMeFeedback {
            ShowMeFeedback.line(scanning: scanning, startedAt: scanning ? start : nil, foundNothing: nothing, failure: failure, now: start.addingTimeInterval(after))
        }
        #expect(line(true, after: 59) == ShowMeFeedback.none)
        #expect(line(true, after: 60) == .slow)
        #expect(line(false, after: 0) == ShowMeFeedback.none)
        #expect(line(false, after: 0, nothing: true) == .nothingNew)
        #expect(line(false, after: 0, nothing: true, failure: "Offline") == .failed("Offline"))
        // While a scan runs, an old failure or "nothing new" doesn't show.
        #expect(line(true, after: 5, nothing: true, failure: "Offline") == ShowMeFeedback.none)
        #expect(ShowMeFeedback.slowAt(scanning: true, startedAt: start, now: start) == start.addingTimeInterval(60))
        #expect(ShowMeFeedback.slowAt(scanning: true, startedAt: start, now: start.addingTimeInterval(61)) == nil)
        #expect(ShowMeFeedback.slowAt(scanning: false, startedAt: start, now: start) == nil)
    }
}
