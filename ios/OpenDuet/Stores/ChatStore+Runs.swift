// Run records (M8 contract §1): lists by scope (first page, then ?before= pages) and run details
// that poll GET /api/runs/:id about every 2 s while the run is queued or running and a detail
// view is open (no SSE event carries runs). State lives in RunsBoard; the UI gets it as
// RunsContext through the environment (ShellHost).
import Foundation

extension ChatStore {
    var runActions: RunActions {
        var runs = RunActions()
        runs.loadList = { [weak self] scope in self?.loadRuns(scope) }
        runs.loadMore = { [weak self] scope in self?.loadMoreRuns(scope) }
        runs.openRun = { [weak self] id in self?.openRun(id) }
        runs.closeRun = { [weak self] id in self?.closeRun(id) }
        runs.retryRun = { [weak self] id in self?.pollRun(id) }
        return runs
    }

    var runsContext: RunsContext { RunsContext(state: runsBoard.state, actions: runActions) }

    /// The first page of a list (again each time it appears; a loaded list stays on screen).
    func loadRuns(_ scope: RunScope) {
        guard !tornDown else { return }
        runListTasks[scope]?.cancel()
        runsBoard.beginList(scope)
        runListTasks[scope] = Task { [client] in
            let result = await Self.result { try await client.runs(scope, before: nil) }
            guard !Task.isCancelled, !tornDown else { return }
            runListTasks[scope] = nil
            switch result {
            case .success(let page):
                runsBoard.applyList(page, scope: scope)
                markOnline()
            case .failure(let error):
                noteFailure(error)
                runsBoard.failList(scope, reason: TaskBoard.reason(for: error))
            }
        }
    }

    /// The page before the oldest row ("See all" scrolled to its end, or its Retry).
    func loadMoreRuns(_ scope: RunScope) {
        guard !tornDown, runListTasks[scope] == nil, let before = runsBoard.beginMore(scope) else { return }
        runListTasks[scope] = Task { [client] in
            let result = await Self.result { try await client.runs(scope, before: before) }
            guard !Task.isCancelled, !tornDown else { return }
            runListTasks[scope] = nil
            switch result {
            case .success(let page):
                runsBoard.applyMore(page, scope: scope)
                markOnline()
            case .failure(let error):
                noteFailure(error)
                runsBoard.failMore(scope, reason: TaskBoard.reason(for: error))
            }
        }
    }

    func openRun(_ runId: String) {
        guard !tornDown, !runId.isEmpty else { return }
        if runsBoard.open(runId) { pollRun(runId) }
    }

    func closeRun(_ runId: String) {
        guard runsBoard.close(runId) else { return }
        runPollTasks[runId]?.cancel()
        runPollTasks[runId] = nil
    }

    /// Loads the detail now, then again every ~2 s for as long as RunsBoard.shouldPoll says so.
    func pollRun(_ runId: String) {
        guard !tornDown, runsBoard.isOpen(runId) else { return }
        runPollTasks[runId]?.cancel()
        runsBoard.beginDetail(runId)
        runPollTasks[runId] = Task { [client] in
            repeat {
                let result = await Self.result { try await client.run(id: runId) }
                guard !Task.isCancelled, !tornDown else { return }
                switch result {
                case .success(let detail):
                    runsBoard.applyDetail(detail)
                    markOnline()
                case .failure(let error):
                    noteFailure(error)
                    runsBoard.failDetail(runId, reason: TaskBoard.reason(for: error))
                }
                guard runsBoard.shouldPoll(runId) else { break }
                try? await Task.sleep(for: RunsBoard.pollInterval)
            } while !Task.isCancelled && !tornDown
            if !Task.isCancelled { runPollTasks[runId] = nil }
        }
    }

    /// Sign-out: every list and poll stops.
    func teardownRuns() {
        runListTasks.values.forEach { $0.cancel() }
        runListTasks = [:]
        runPollTasks.values.forEach { $0.cancel() }
        runPollTasks = [:]
    }
}
