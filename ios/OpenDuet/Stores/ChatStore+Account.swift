// The profile sheet and the Usage screen (L128, L129, L166): which store-driven sheet is up,
// GET /api/me and the notification permission, Memory, Notifications (PATCH /api/me), usage
// (GET /api/usage, then live `usage` events), Full reset and Send feedback. Sign-out and the
// iOS Settings link need the app (SessionStore, UIApplication) and are injected by ShellHost.
import Foundation

extension ChatStore {
    // MARK: - Sheets

    func present(_ sheet: ShellPresentation) {
        account.presented = sheet
    }

    func dismissSheet() {
        account.presented = nil
    }

    // MARK: - Profile

    /// AccountActions.refreshProfile: the user (also the header initials) and the permission.
    func refreshProfile() {
        guard !tornDown else { return }
        profileTask?.cancel()
        profileTask = Task { [client] in
            async let me = Self.result { try await client.me() }
            async let allowed = NotificationPermission.isAllowed()
            let (meResult, notificationsAllowed) = await (me, allowed)
            guard !Task.isCancelled, !tornDown else { return }
            account.profile.notificationsAllowed = notificationsAllowed
            switch meResult {
            case .success(let (user, json)):
                if account.requests[ShellState.RequestKey.saveProfile] != .inFlight { refreshUser(user, json: json) }
                markOnline()
            case .failure(let error):
                noteFailure(error)
            }
        }
    }

    // MARK: - Memory

    /// AccountActions.loadMemory (profile > Memory opened).
    func loadMemory() {
        guard !tornDown else { return }
        memoryTask?.cancel()
        account.beginMemory()
        memoryTask = Task { [client] in
            let result = await Self.result { try await client.memory() }
            guard !Task.isCancelled, !tornDown else { return }
            switch result {
            case .success(let memory):
                account.applyMemory(memory)
                markOnline()
            case .failure(let error):
                noteFailure(error)
                account.failMemory(reason: TaskBoard.reason(for: error))
            }
        }
    }

    /// AccountActions.saveMemory (cardRequests[RequestKey.saveMemory]).
    func saveMemory(_ document: String) {
        let key = ShellState.RequestKey.saveMemory
        guard !tornDown, account.begin(key) else { return }
        runTap(key, { [client] in try await client.saveMemory(document) }) { store, result in
            if let memory = store.account.answer(key, result) { store.account.applyMemory(memory) }
        }
    }

    // MARK: - Notifications

    /// AccountActions.updateNotifications (cardRequests[RequestKey.saveProfile]): shown at once,
    /// rolled back on failure; success also refreshes Tasks > Scheduled (next run times).
    func updateNotifications(briefTime: LocalTime?, weekendsOn: Bool?) {
        guard !tornDown, briefTime != nil || weekendsOn != nil,
              account.beginNotifications(briefTime: briefTime, weekendsOn: weekendsOn) else { return }
        let body = UpdateMeRequest(firstName: nil, briefTime: briefTime, weekendsOn: weekendsOn)
        runTap(ShellState.RequestKey.saveProfile, { [client] in try await client.updateMe(body) }) { store, result in
            store.account.answerNotifications(result.map { $0.0 })
            if case .success(let (user, json)) = result {
                store.refreshUser(user, json: json)
                store.refreshSchedule()
            }
        }
    }

    // MARK: - Usage

    /// AccountActions.refreshUsage (the Usage screen appeared, or its refresh button).
    func refreshUsage() {
        guard !tornDown else { return }
        usageTask?.cancel()
        account.beginUsage()
        // M9: the Usage panel's range comes along (cached for 30 s, AccountBoard.usageStatsFreshness).
        loadUsageStats(account.usageScreen.range)
        usageTask = Task { [client] in
            let result = await Self.result { try await client.usage() }
            guard !Task.isCancelled, !tornDown else { return }
            switch result {
            case .success(let usage):
                account.applyUsage(usage)
                markOnline()
            case .failure(let error):
                noteFailure(error)
                account.failUsage(reason: TaskBoard.reason(for: error))
            }
        }
    }

    /// "Reset for free" (cardRequests[RequestKey.fullReset]); a 409 shows why and refetches usage.
    func fullReset() {
        let key = ShellState.RequestKey.fullReset
        guard !tornDown, account.begin(key) else { return }
        runTap(key, { [client] in try await client.fullReset() }) { store, result in
            if store.account.answerFullReset(result) { store.refreshUsage() }
        }
    }

    // MARK: - Feedback

    /// profile > Send feedback (cardRequests[RequestKey.feedback]); "Thanks for the feedback"
    /// arrives in chat as an event.
    func sendFeedback(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = ShellState.RequestKey.feedback
        guard !tornDown, !trimmed.isEmpty, account.begin(key) else { return }
        let body = FeedbackRequest(messageId: nil, rating: nil, text: trimmed)
        runTap(key, { [client] in try await client.sendFeedback(body) }) { store, result in
            _ = store.account.answer(key, result)
        }
    }
}
