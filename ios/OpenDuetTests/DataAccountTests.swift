// The account side of M4 as pure values: the Usage screen (first load, refresh, live `usage`
// events, Reset for free incl. the 409 "not available"), the profile's optimistic notification
// settings with rollback, the Scheduled rows (phases, "may have run" after `done`), Up next's
// scanning flag, when a `notification` event notifies (NotificationRules), and when onboarding
// shows / posts complete (OnboardingGate).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Usage and profile")
struct DataUsageProfileTests {
    @Test("usage: skeleton on the first load, the bars stay while refreshing, a failed refresh keeps them")
    func usagePhases() {
        var board = AccountBoard()
        board.beginUsage()
        #expect(board.usageScreen.phase == .loading)
        board.failUsage(reason: "offline")
        #expect(board.usageScreen.phase == .failed(reason: "offline"))

        board.beginUsage()
        #expect(board.usageScreen.phase == .loading)
        board.applyUsage(Fx.usage(sessionUsed: 10))
        #expect(board.usageScreen.phase == .loaded)
        #expect(board.usageScreen.refreshing == false)

        board.beginUsage()
        #expect(board.usageScreen.phase == .loaded)
        #expect(board.usageScreen.refreshing)
        board.failUsage(reason: "offline")
        #expect(board.usageScreen.phase == .loaded)
        #expect(board.usageScreen.refreshing == false)
        #expect(board.usageScreen.usage?.session.used == 10)
    }

    @Test("a `usage` event updates the screen live, even before the first GET")
    func usageEvent() {
        var board = AccountBoard()
        board.usageEvent(Fx.usage(sessionUsed: 42))
        #expect(board.usageScreen.phase == .loaded)
        #expect(board.usageScreen.usage?.session.used == 42)
    }

    @Test("Reset for free: one at a time; success shows the new bars")
    func fullResetSuccess() {
        var board = AccountBoard()
        let key = ShellState.RequestKey.fullReset
        #expect(board.begin(key) == true)
        #expect(board.begin(key) == false)
        #expect(board.answerFullReset(.success(Fx.usage(sessionUsed: 0, resetAvailable: false))) == false)
        #expect(board.requests[key] == nil)
        #expect(board.usageScreen.phase == .loaded)
        #expect(board.usageScreen.usage?.fullReset.available == false)
    }

    @Test("Reset for free: 409 says it isn't available and asks for a fresh GET; other failures keep the reason")
    func fullResetFailures() {
        var board = AccountBoard()
        let key = ShellState.RequestKey.fullReset
        let unavailable = String(localized: "Full reset isn't available right now.")

        #expect(board.begin(key) == true)
        #expect(board.answerFullReset(.failure(APIError.staleVersion)) == true)
        #expect(board.requests[key] == .failed(reason: unavailable))

        #expect(board.begin(key) == true)
        #expect(board.answerFullReset(.failure(APIError.server(status: 409, code: "reset_unavailable"))) == true)
        #expect(board.requests[key] == .failed(reason: unavailable))

        #expect(board.begin(key) == true)
        #expect(board.answerFullReset(.failure(APIError.unreachable)) == false)
        #expect(board.requests[key] == .failed(reason: APIError.unreachable.localizedReason))

        #expect(board.begin(key) == true)
        #expect(board.answerFullReset(.failure(CancellationError())) == false)
        #expect(board.requests[key] == nil)
        #expect(board.usageScreen.usage == nil)
    }

    @Test("notifications: shown at once, the server's copy on success, rolled back on failure")
    func notifications() {
        var board = AccountBoard()
        let key = ShellState.RequestKey.saveProfile
        #expect(board.beginNotifications(briefTime: nil, weekendsOn: true) == false)

        board.setUser(Fx.user(briefHour: 8, weekendsOn: false))
        #expect(board.beginNotifications(briefTime: LocalTime(hour: 7, minute: 0), weekendsOn: nil) == true)
        #expect(board.profile.user?.briefTime == LocalTime(hour: 7, minute: 0))
        #expect(board.requests[key] == .inFlight)
        #expect(board.beginNotifications(briefTime: nil, weekendsOn: true) == false)
        board.answerNotifications(.success(Fx.user(briefHour: 7, weekendsOn: false)))
        #expect(board.requests[key] == nil)
        #expect(board.profile.user?.briefTime == LocalTime(hour: 7, minute: 19))

        #expect(board.beginNotifications(briefTime: nil, weekendsOn: true) == true)
        #expect(board.profile.user?.weekendsOn == true)
        board.answerNotifications(.failure(APIError.unreachable))
        #expect(board.profile.user?.weekendsOn == false)
        #expect(board.profile.user?.briefTime == LocalTime(hour: 7, minute: 19))
        #expect(board.requests[key] == .failed(reason: APIError.unreachable.localizedReason))
    }

    @Test("memory: skeleton while the first load runs, then the reason when it fails")
    func memoryPhases() {
        var board = AccountBoard()
        board.beginMemory()
        #expect(board.profile.memoryPhase == .loading)
        board.failMemory(reason: "offline")
        #expect(board.profile.memoryPhase == .failed(reason: "offline"))
    }
}

@Suite("Scheduled and scan")
struct DataScheduleTests {
    @Test("Scheduled rows: skeleton until loaded, a failed refresh keeps them")
    func phases() {
        var list = TasksReducer()
        list.beginSchedule()
        #expect(list.state.schedule.phase == .loading)
        list.failSchedule(reason: "offline")
        #expect(list.state.schedule.phase == .failed(reason: "offline"))
        list.applySchedule(Fx.schedule(briefNext: 3600, checkinNext: 7200))
        #expect(list.state.schedule.phase == .loaded)
        list.beginSchedule()
        list.failSchedule(reason: "offline")
        #expect(list.state.schedule.phase == .loaded)
        #expect(list.state.schedule.info?.checkin.history.count == 1)
    }

    @Test("after `done` the rows are refetched only when a scheduled run may have been it")
    func mayHaveRun() {
        var list = TasksReducer()
        #expect(list.scheduleMayHaveRun(now: Fx.date(0)) == false)

        list.applySchedule(Fx.schedule(briefNext: 3600, checkinNext: 7200))
        #expect(list.scheduleMayHaveRun(now: Fx.date(60)) == false)
        #expect(list.scheduleMayHaveRun(now: Fx.date(3600)))

        list.applySchedule(Fx.schedule(briefNext: 3600, checkinNext: 7200, checkinHistory: ["completed", "running"]))
        #expect(list.scheduleMayHaveRun(now: Fx.date(60)))
        list.applySchedule(Fx.schedule(briefNext: 3600, checkinNext: 7200, checkinHistory: ["queued"]))
        #expect(list.scheduleMayHaveRun(now: Fx.date(60)))
        list.applySchedule(Fx.schedule(briefNext: 3600, checkinNext: 7200, checkinHistory: ["failed", "skipped"]))
        #expect(list.scheduleMayHaveRun(now: Fx.date(60)) == false)
    }

    @Test("Show me: scanning at once, cleared when the scan couldn't start, then follows GET /api/up-next")
    func scanning() {
        var list = TasksReducer()
        list.beginScan()
        #expect(list.state.upNext.scanning)
        list.failScan()
        #expect(list.state.upNext.scanning == false)

        list.applyUpNext(Fx.upNext(scanning: true))
        #expect(list.state.upNext.scanning)
        list.applyUpNext(Fx.upNext(scanning: false))
        #expect(list.state.upNext.scanning == false)
        #expect(ShellState.RequestKey.scan != ShellState.RequestKey.runNow(.checkin))
    }
}

@Suite("Notification rules")
struct DataNotificationRulesTests {
    private let now = Fx.date(1_000)
    private func screen(active: Bool = true, shell: Bool = true, channel: String? = Fx.main, task: String? = nil,
                        tab: ShellTab = .chat) -> NotificationScreen {
        NotificationScreen(appActive: active, shellVisible: shell, channelId: channel, taskId: task, tab: tab)
    }

    @Test("a channel's thread is on screen only on the Chat tab; a task detail on any tab")
    func tabs() {
        #expect(NotificationRules.isOnScreen(route: "duet://channels/ch_main", screen(tab: .tasks)) == false)
        #expect(NotificationRules.shouldPostLocal(route: "duet://channels/ch_main", createdAt: now, now: now, screen(tab: .tasks)))
        #expect(NotificationRules.isOnScreen(route: "duet://tasks/t1", screen(task: "t1", tab: .tasks)))
        #expect(NotificationRules.isOnScreen(route: "duet://tasks/t1", screen(task: "t1", tab: .chat)))
        // Routes that need a tab: a channel -> Chat; a task (an overlay) stays on the current one.
        #expect(DuetRoute(URL(string: "duet://channels/ch_a")!)?.tab == .chat)
        #expect(DuetRoute(URL(string: "duet://tasks/t1")!)?.tab == nil)
        #expect(DuetRoute(URL(string: "duet://artifacts/a1")!)?.tab == nil)
    }

    @Test("the thread or task on screen never notifies; anything else does")
    func onScreen() {
        #expect(NotificationRules.isOnScreen(route: "duet://channels/ch_main", screen()))
        #expect(NotificationRules.isOnScreen(route: "duet://channels/ch_other", screen()) == false)
        // A task detail over the thread hides the thread.
        #expect(NotificationRules.isOnScreen(route: "duet://channels/ch_main", screen(task: "t1")) == false)
        #expect(NotificationRules.isOnScreen(route: "duet://tasks/t1", screen(task: "t1")))
        #expect(NotificationRules.isOnScreen(route: "duet://tasks/t2", screen(task: "t1")) == false)
        #expect(NotificationRules.isOnScreen(route: "duet://artifacts/a1", screen()) == false)
        #expect(NotificationRules.isOnScreen(route: "not a route", screen()) == false)
    }

    @Test("background, onboarding or sign-in: nothing counts as on screen")
    func notVisible() {
        #expect(NotificationRules.isOnScreen(route: "duet://channels/ch_main", screen(active: false)) == false)
        #expect(NotificationRules.isOnScreen(route: "duet://channels/ch_main", screen(shell: false)) == false)
        #expect(NotificationRules.shouldPostLocal(route: "duet://channels/ch_main", createdAt: now, now: now, screen(active: false)))
    }

    @Test("local notifications only for fresh events (a long catch-up stays quiet)")
    func freshness() {
        let route = "duet://tasks/t1"
        #expect(NotificationRules.shouldPostLocal(route: route, createdAt: now, now: now, screen()))
        #expect(NotificationRules.shouldPostLocal(route: route, createdAt: now, now: now.addingTimeInterval(NotificationRules.freshness), screen()))
        #expect(NotificationRules.shouldPostLocal(route: route, createdAt: now, now: now.addingTimeInterval(NotificationRules.freshness + 1), screen()) == false)
        #expect(NotificationRules.shouldPostLocal(route: route, createdAt: now, now: now, screen(task: "t1")) == false)
    }

    @Test("foreground banners: a remote push is dropped while the stream is live, the rest follow the screen")
    func present() {
        #expect(NotificationRules.shouldPresent(route: "duet://tasks/t1", isRemote: true, streamLive: true, screen()) == false)
        #expect(NotificationRules.shouldPresent(route: "duet://tasks/t1", isRemote: true, streamLive: false, screen()))
        #expect(NotificationRules.shouldPresent(route: "duet://tasks/t1", isRemote: false, streamLive: true, screen()))
        #expect(NotificationRules.shouldPresent(route: "duet://channels/ch_main", isRemote: false, streamLive: true, screen()) == false)
        #expect(NotificationRules.shouldPresent(route: nil, isRemote: false, streamLive: true, screen()))
    }

    @Test("the APNs token goes up as lowercase hex")
    func hex() {
        #expect(NotificationRules.hex(Data([0x00, 0x0f, 0xab, 0xff])) == "000fabff")
        #expect(NotificationRules.hex(Data()) == "")
    }
}

@Suite("Onboarding gate")
struct DataOnboardingGateTests {
    @Test("the first run shows when the server has no onboardedAt, and finishing posts complete once")
    func firstRun() {
        var gate = OnboardingGate(onboardedAt: nil, finishedLocally: false)
        #expect(gate.mode == .firstRun)
        #expect(gate.isShowing)
        #expect(gate.finish() == true)
        #expect(gate.mode == .hidden)
        #expect(gate.needsCompletePost)
        // A second finish (a duplicate tap) doesn't post again.
        #expect(gate.finish() == false)
        gate.serverConfirmed()
        #expect(gate.needsCompletePost == false)
    }

    @Test("onboarded on the server, or finished here before: hidden; a failed POST is retried")
    func hidden() {
        let onboarded = OnboardingGate(onboardedAt: Fx.date(0), finishedLocally: false)
        #expect(onboarded.mode == .hidden)
        #expect(onboarded.needsCompletePost == false)

        var pending = OnboardingGate(onboardedAt: nil, finishedLocally: true)
        #expect(pending.mode == .hidden)
        #expect(pending.needsCompletePost)
        pending.userRefreshed(onboardedAt: nil)
        #expect(pending.needsCompletePost)
        pending.userRefreshed(onboardedAt: Fx.date(10))
        #expect(pending.needsCompletePost == false)
    }

    @Test("a long-press replay shows the pages again and never posts")
    func replay() {
        var gate = OnboardingGate(onboardedAt: Fx.date(0), finishedLocally: false)
        gate.replay()
        #expect(gate.mode == .replay)
        #expect(gate.isShowing)
        #expect(gate.finish() == false)
        #expect(gate.mode == .hidden)
        #expect(gate.needsCompletePost == false)

        // Replayed while the first-run POST is still pending: still nothing new to post here.
        var pending = OnboardingGate(onboardedAt: nil, finishedLocally: true)
        pending.replay()
        #expect(pending.finish() == false)
        #expect(pending.needsCompletePost)
    }
}
