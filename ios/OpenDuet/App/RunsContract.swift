// M8 additions to the data <-> UI seam (see ShellContract.swift): run records (contract §1).
// The store fills RunsState from GET /api/runs and GET /api/runs/:id and polls an open run's
// detail about every 2 s while it is queued or running; the UI renders it and calls RunActions.
// Both travel in the environment (`\.runs`, injected by ShellHost) so the OpenDuet sheet's Activity
// section and the task detail's "Run details" reach them without new initializer parameters.
// Foundation only (Mac host tests); the environment entry is in RunsEnvironment.swift.
import Foundation

/// Which runs a list shows: every run of the user, one task's, or one channel's.
enum RunScope: Hashable, Sendable {
    case all
    case task(String)
    case channel(String)
}

struct RunListState: Hashable, Sendable {
    /// first load: skeleton rows; failed: grey reason + Retry
    var phase: TasksState.Phase = .loading
    /// newest first
    var runs: [RunSummary] = []
    var hasMore = false
    /// an older page is loading (a skeleton row at the end of "See all")
    var loadingMore = false
    /// the older page failed: the reason with Retry at the end
    var moreError: String?
}

struct RunDetailState: Hashable, Sendable {
    var phase: TasksState.Phase = .loading
    /// the list row's copy until the detail answers, so the header shows at once
    var summary: RunSummary?
    /// nil until GET /api/runs/:id answers (skeleton timeline meanwhile)
    var steps: [RunStep]?
}

struct RunsState: Hashable, Sendable {
    var lists: [RunScope: RunListState] = [:]
    var details: [String: RunDetailState] = [:]

    func list(_ scope: RunScope) -> RunListState { lists[scope] ?? RunListState() }
    func detail(_ id: String) -> RunDetailState { details[id] ?? RunDetailState() }
}

struct RunActions: Sendable {
    /// a list appeared (OpenDuet sheet's Activity, "See all", a task's "Run details"): first page
    var loadList: @MainActor @Sendable (_ scope: RunScope) -> Void = { _ in }
    /// the end of "See all" came into view: the page before the oldest run
    var loadMore: @MainActor @Sendable (_ scope: RunScope) -> Void = { _ in }
    /// a detail appeared / went away: it loads, then polls while the run is queued or running
    var openRun: @MainActor @Sendable (_ runId: String) -> Void = { _ in }
    var closeRun: @MainActor @Sendable (_ runId: String) -> Void = { _ in }
    /// a failed detail's Retry
    var retryRun: @MainActor @Sendable (_ runId: String) -> Void = { _ in }
}

/// What the run views read from the environment (`\.runs`, RunsEnvironment.swift).
struct RunsContext: Sendable {
    var state = RunsState()
    var actions = RunActions()
}
