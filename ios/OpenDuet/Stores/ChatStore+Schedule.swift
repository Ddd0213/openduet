// Tasks > Scheduled and Up next scans (L118, L119): GET /api/schedule with every Tasks refresh,
// "Run now" (POST /api/schedule/run), "Show me" (POST /api/up-next/scan, then GET /api/up-next
// after each `done` until the server says scanning: false) and the Scheduled rows refreshed
// after a run that may have been a scheduled one.
import Foundation

extension ChatStore {
    /// GET /api/schedule (the Scheduled group's Morning brief and Check-in rows). M19: the board is
    /// written only when the rows change (every observed write re-renders the shell, and a channel
    /// switch, every Tasks appear, Run now and finished runs all refresh it).
    func refreshSchedule() {
        guard !tornDown else { return }
        scheduleTask?.cancel()
        if board.list.state.schedule.phase != .loaded && board.list.state.schedule.phase != .loading {
            board.list.beginSchedule()
        }
        scheduleTask = Task { [client] in
            let result = await Self.result { try await client.schedule() }
            guard !Task.isCancelled, !tornDown else { return }
            switch result {
            case .success(let info):
                let shown = board.list.state.schedule
                if shown.phase != .loaded || shown.info != info { board.list.applySchedule(info) }
                markOnline()
            case .failure(let error):
                noteFailure(error)
                if board.list.state.schedule.phase != .loaded {
                    board.list.failSchedule(reason: TaskBoard.reason(for: error))
                }
            }
        }
    }

    /// The Check-in sheet's "Run now" (cardRequests[RequestKey.runNow(kind)]); the run's output
    /// arrives as events in chat and Tasks.
    func runNow(_ kind: RunNowRequest.Kind) {
        let key = ShellState.RequestKey.runNow(kind)
        guard !tornDown, account.begin(key) else { return }
        runTap(key, { [client] in try await client.runNow(kind) }) { store, result in
            if store.account.answer(key, result) != nil { store.refreshSchedule() }
        }
    }

    /// Up next's "Show me": upNext.scanning at once; the suggestions arrive as events and
    /// GET /api/up-next ends the scan. A scan that can't start leaves cardRequests[RequestKey.scan].
    func scan() {
        let key = ShellState.RequestKey.scan
        guard !tornDown, !board.list.state.upNext.scanning, account.begin(key) else { return }
        board.list.beginScan()
        runTap(key, { [client] in try await client.scanUpNext() }) { store, result in
            if store.account.answer(key, result) != nil {
                store.pollScan()
            } else {
                store.board.list.failScan()
            }
        }
    }

    /// A run ended (`done`, also chat runs): Up next while a scan runs, and the Scheduled rows when
    /// a scheduled run may have been it. Debounced, since done events come in bursts.
    func noteRunDone() {
        guard !tornDown else { return }
        runDoneTask?.cancel()
        runDoneTask = Task {
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled, !tornDown else { return }
            if board.list.state.upNext.scanning { refreshUpNext() }
            // M9: a routine that was due (or still running) has a new next run and last status;
            // the list (with the schedule) comes again, and open run histories too.
            if board.list.routineMayHaveRun(now: .now) {
                refreshTasks()
            } else if board.list.scheduleMayHaveRun(now: .now) {
                refreshSchedule()
            }
            refreshOpenRoutineRuns()
        }
    }

    /// GET /api/up-next alone (the scan's progress); Tasks refreshes fetch it with the list.
    func refreshUpNext() {
        guard !tornDown else { return }
        upNextTask?.cancel()
        upNextTask = Task { [client] in
            let result = await Self.result { try await client.upNext() }
            guard !Task.isCancelled, !tornDown else { return }
            switch result {
            case .success(let upNext):
                board.list.applyUpNext(upNext)
                if upNext.scanning { pollScan() }
                markOnline()
            case .failure(let error):
                noteFailure(error)
            }
        }
    }

    /// A safety net while a scan runs: GET /api/up-next every 20 s (a missed `done` or a scan
    /// that ended without a run), at most 30 times.
    func pollScan() {
        guard !tornDown, scanPollTask == nil else { return }
        scanPollTask = Task {
            defer { scanPollTask = nil }
            for _ in 0..<30 {
                try? await Task.sleep(for: .seconds(20))
                guard !Task.isCancelled, !tornDown, board.list.state.upNext.scanning else { return }
                refreshUpNext()
            }
        }
    }
}
