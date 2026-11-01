// Run records (M8 contract §1) as one value: the lists by scope (paged with ?before=) and the
// details by run id. A detail answer also refreshes that run's row in every list, and an open
// run is polled while it is queued or running. ChatStore+Runs does the I/O; this stays Foundation
// + models, so the Mac host tests drive it directly.
import Foundation

struct RunsBoard: Sendable {
    private(set) var state = RunsState()
    /// Open detail views per run id (a run can be on screen twice: list > detail and the sheet).
    private(set) var openCounts: [String: Int] = [:]

    static let pageSize = 30
    static let pollInterval: Duration = .seconds(2)

    // MARK: - Lists

    /// The first page starts: skeleton rows the first time; a loaded list stays on screen.
    mutating func beginList(_ scope: RunScope) {
        var list = state.list(scope)
        if list.phase != .loaded { list.phase = .loading }
        // A reload replaces an older page still on its way.
        list.loadingMore = false
        state.lists[scope] = list
    }

    /// The newest page answered. Rows already paged in below it stay (a refresh of "See all"
    /// doesn't throw away the older pages the user scrolled to).
    mutating func applyList(_ page: RunList, scope: RunScope) {
        var list = state.list(scope)
        let fresh = Set(page.runs.map(\.id))
        let oldest = page.runs.last?.createdAt
        let older = list.runs.filter { run in
            guard !fresh.contains(run.id), let oldest else { return false }
            return run.createdAt < oldest
        }
        list.runs = page.runs + older
        list.hasMore = older.isEmpty ? page.hasMore : list.hasMore
        list.phase = .loaded
        list.moreError = nil
        state.lists[scope] = list
        for run in page.runs { seed(run) }
    }

    mutating func failList(_ scope: RunScope, reason: String) {
        var list = state.list(scope)
        if list.phase != .loaded { list.phase = .failed(reason: reason) }
        state.lists[scope] = list
    }

    /// The page before the oldest row: its cursor, or nil when there is nothing more to load.
    mutating func beginMore(_ scope: RunScope) -> String? {
        var list = state.list(scope)
        guard list.phase == .loaded, list.hasMore, !list.loadingMore, let oldest = list.runs.last?.id else { return nil }
        list.loadingMore = true
        list.moreError = nil
        state.lists[scope] = list
        return oldest
    }

    mutating func applyMore(_ page: RunList, scope: RunScope) {
        var list = state.list(scope)
        let known = Set(list.runs.map(\.id))
        list.runs += page.runs.filter { !known.contains($0.id) }
        list.hasMore = page.hasMore
        list.loadingMore = false
        state.lists[scope] = list
        for run in page.runs { seed(run) }
    }

    mutating func failMore(_ scope: RunScope, reason: String) {
        var list = state.list(scope)
        list.loadingMore = false
        list.moreError = reason
        state.lists[scope] = list
    }

    // MARK: - Details

    /// A detail view appeared; true when it is the first one for this run (start loading).
    mutating func open(_ runId: String) -> Bool {
        openCounts[runId, default: 0] += 1
        if state.details[runId] == nil { state.details[runId] = RunDetailState(summary: summary(runId)) }
        return openCounts[runId] == 1
    }

    /// A detail view went away; true when none is left (stop polling).
    mutating func close(_ runId: String) -> Bool {
        guard let count = openCounts[runId] else { return false }
        if count <= 1 {
            openCounts[runId] = nil
            return true
        }
        openCounts[runId] = count - 1
        return false
    }

    func isOpen(_ runId: String) -> Bool { openCounts[runId] != nil }

    mutating func beginDetail(_ runId: String) {
        var detail = state.detail(runId)
        if detail.steps == nil { detail.phase = .loading }
        if detail.summary == nil { detail.summary = summary(runId) }
        state.details[runId] = detail
    }

    /// GET /api/runs/:id answered: the header and timeline, and the run's row in every list.
    mutating func applyDetail(_ run: RunDetail) {
        let next = RunDetailState(phase: .loaded, summary: run.summary, steps: run.steps)
        if state.details[run.id] != next { state.details[run.id] = next }
        for (scope, var list) in state.lists {
            guard let index = list.runs.firstIndex(where: { $0.id == run.id }), list.runs[index] != run.summary else { continue }
            list.runs[index] = run.summary
            state.lists[scope] = list
        }
    }

    /// A failed answer: the first load shows the reason with Retry; a failed poll keeps what's shown.
    mutating func failDetail(_ runId: String, reason: String) {
        var detail = state.detail(runId)
        if detail.steps == nil { detail.phase = .failed(reason: reason) }
        state.details[runId] = detail
    }

    /// Whether an open detail should be fetched again in ~2 s: while it is open, its first load
    /// hasn't failed, and the run is still queued or running (or not known yet).
    func shouldPoll(_ runId: String) -> Bool {
        guard isOpen(runId) else { return false }
        let detail = state.detail(runId)
        if case .failed = detail.phase { return false }
        guard detail.steps != nil, let summary = detail.summary else { return true }
        return summary.status.isOpen
    }

    // MARK: - Helpers

    /// The newest copy of a run's summary in any list.
    func summary(_ runId: String) -> RunSummary? {
        for list in state.lists.values {
            if let run = list.runs.first(where: { $0.id == runId }) { return run }
        }
        return nil
    }

    /// A list row's summary seeds a detail that hasn't loaded yet (its header shows at once).
    private mutating func seed(_ run: RunSummary) {
        guard var detail = state.details[run.id], detail.steps == nil else { return }
        detail.summary = run
        state.details[run.id] = detail
    }
}

/// What a task's "Run details" shows (M8 brief §7a): one run opens its detail, several the list.
enum TaskRunsChoice: Hashable, Sendable {
    case loading
    case failed(String)
    case empty
    case single(RunSummary)
    case list

    init(_ list: RunListState) {
        switch list.phase {
        case .loading where list.runs.isEmpty: self = .loading
        case .failed(let reason) where list.runs.isEmpty: self = .failed(reason)
        default:
            if list.runs.isEmpty {
                self = .empty
            } else if list.runs.count == 1 && !list.hasMore {
                self = .single(list.runs[0])
            } else {
                self = .list
            }
        }
    }
}

/// Runs grouped by calendar day (the list's section headers), newest day first.
struct RunDay: Hashable, Sendable, Identifiable {
    var day: Date
    var runs: [RunSummary]
    var id: Date { day }

    static func group(_ runs: [RunSummary], calendar: Calendar = .autoupdatingCurrent) -> [RunDay] {
        var days: [RunDay] = []
        for run in runs {
            let day = calendar.startOfDay(for: run.createdAt)
            if days.last?.day == day {
                days[days.count - 1].runs.append(run)
            } else if let index = days.firstIndex(where: { $0.day == day }) {
                days[index].runs.append(run)
            } else {
                days.append(RunDay(day: day, runs: [run]))
            }
        }
        return days
    }
}
