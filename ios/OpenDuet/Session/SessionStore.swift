// The signed-in session (prompt L131, L184): restores it at launch (GET /api/me; offline with
// the cached user when the server can't be reached; back to sign-in on 401), signs in and
// out, and owns the session's APIClient, ChatStore and (while it shows) the onboarding's
// OnboardingModel. Onboarding follows the server's onboardedAt (OnboardingGate, M4): the first
// run posts /api/onboarding/complete once, retried in the background; a long-press replay is
// local only. Sign-out removes this iPhone's push registration, then revokes the session; it and
// an expired session keep the server address so sign-in comes back prefilled.
import Foundation
import Observation
import OSLog

@MainActor
@Observable
final class SessionStore {
    enum Phase: Equatable { case restoring, signedOut, signedIn }

    private(set) var phase: Phase = .restoring
    private(set) var user: CurrentUser?
    private(set) var client: APIClient?
    private(set) var chat: ChatStore?
    /// Last server signed in to; prefills the sign-in field.
    private(set) var savedServer: ServerAddress? = SessionDefaults.server
    /// When onboarding shows and whether the server still has to hear it finished.
    private(set) var gate: OnboardingGate?
    /// The onboarding's real data (chips, Slack) while the flow shows.
    private(set) var onboarding: OnboardingModel?
    /// Bumped on every replay so the flow starts over with fresh state.
    private(set) var onboardingRun = 0

    /// Signed in and the onboarding flow is up (first run or a long-press replay).
    var needsOnboarding: Bool { gate?.isShowing == true }

    @ObservationIgnored private(set) var server: ServerAddress?
    @ObservationIgnored private var foreground = true
    /// Bumped whenever the session changes, so a late 401 from an old client is ignored.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var completeTask: Task<Void, Never>?

    private static let log = Logger(subsystem: "dev.openduet.OpenDuet", category: "session")

    init() {}

    // MARK: - Launch

    func restore() async {
        guard phase == .restoring else { return }
        guard let server = SessionDefaults.server, let token = TokenStore.token(for: server) else {
            phase = .signedOut
            return
        }
        generation += 1
        let client = makeClient(server: server, token: token)
        do {
            let (user, json) = try await client.me(timeout: 8)
            SessionDefaults.cacheUser(json)
            enter(server: server, client: client, user: user, offline: false)
        } catch APIError.unauthorized {
            endSession()
        } catch {
            // Server unreachable (or failing): open the shell from the cache, marked offline.
            // The cache is written at sign-in and cleared at sign-out, so it is this token's user.
            if let cached = SessionDefaults.cachedUser {
                enter(server: server, client: client, user: cached, offline: true)
            } else {
                // Nothing to show offline: sign-in, prefilled (a new sign-in replaces the token).
                generation += 1
                phase = .signedOut
            }
        }
    }

    // MARK: - Sign in / out

    /// POST /api/session; throws APIError for the sign-in screen's inline line.
    func signIn(server: ServerAddress, username: String, password: String) async throws {
        let (response, userJSON) = try await APIClient(server: server, token: nil).signIn(username: username, password: password)
        if let old = self.server, old != server { TokenStore.delete(for: old) }
        guard TokenStore.save(response.token, for: server) else {
            Self.log.error("Couldn't store the session token in the Keychain")
            throw APIError.invalidResponse
        }
        SessionDefaults.server = server
        savedServer = server
        if let userJSON { SessionDefaults.cacheUser(userJSON) }
        generation += 1
        enter(server: server, client: makeClient(server: server, token: response.token), user: response.user, offline: false)
    }

    /// Profile > Sign out: end locally at once (works offline), then in the background
    /// DELETE /api/devices/:id for this iPhone's push registration and DELETE /api/session.
    func signOut() {
        guard let client else { return }
        let deviceId = server.flatMap { server in user.flatMap { SessionDefaults.deviceId(server: server, userId: $0.id) } }
        endSession()
        // M15: the calls' provider errors kept on this phone belong to this account.
        CallProblems.shared.removeAll()
        Task {
            if let deviceId { try? await client.deleteDevice(id: deviceId) }
            try? await client.signOut()
        }
    }

    // MARK: - Onboarding (L77)

    /// After the celebration. The first run goes to the chat at once and reports itself with
    /// POST /api/onboarding/complete (retried in the background); a replay just closes.
    func finishOnboarding() {
        guard var gate else { return }
        let post = gate.finish()
        self.gate = gate
        onboarding?.close()
        onboarding = nil
        if gate.needsCompletePost, let server, let user {
            SessionDefaults.markOnboardingSeen(server: server, userId: user.id)
        }
        if post { postOnboardingComplete() }
        NotificationsCoordinator.shared.shellMayBeVisible()
    }

    /// Long-press on the initials: replay the pages locally; the server isn't told.
    func replayOnboarding() {
        guard var gate, let client else { return }
        gate.replay()
        self.gate = gate
        onboardingRun += 1
        onboarding?.close()
        onboarding = OnboardingModel(client: client) { [weak self] in self?.finishOnboarding() }
    }

    /// POST /api/onboarding/complete until it goes through (a few tries now, again on the next
    /// foreground or launch). Never for a replay.
    private func postOnboardingComplete() {
        guard completeTask == nil, let client, gate?.needsCompletePost == true else { return }
        let generation = generation
        completeTask = Task {
            defer { if self.generation == generation { completeTask = nil } }
            for attempt in 0..<4 {
                if attempt > 0 { try? await Task.sleep(for: .seconds(Double(2 << attempt))) }
                guard !Task.isCancelled, self.generation == generation else { return }
                do {
                    let (response, json) = try await client.completeOnboarding()
                    guard self.generation == generation else { return }
                    gate?.serverConfirmed()
                    user = response.user
                    if let json { chat?.refreshUser(response.user, json: json) }
                    return
                } catch APIError.unauthorized {
                    return
                } catch {
                    Self.log.notice("POST /api/onboarding/complete failed (attempt \(attempt + 1)); retrying")
                }
            }
        }
    }

    // MARK: - Foreground

    func setForeground(_ active: Bool) {
        foreground = active
        chat?.setActive(active)
        if active, gate?.needsCompletePost == true { postOnboardingComplete() }
    }

    // MARK: - Private

    private func enter(server: ServerAddress, client: APIClient, user: CurrentUser, offline: Bool) {
        chat?.teardown()
        onboarding?.close()
        completeTask?.cancel()
        completeTask = nil
        self.server = server
        self.client = client
        self.user = user
        let gate = OnboardingGate(
            onboardedAt: user.onboardedAt,
            finishedLocally: SessionDefaults.hasSeenOnboarding(server: server, userId: user.id)
        )
        self.gate = gate
        onboarding = gate.isShowing ? OnboardingModel(client: client) { [weak self] in self?.finishOnboarding() } : nil
        let chat = ChatStore(client: client, user: user, cursor: EventCursor(server: server, userId: user.id), offline: offline)
        chat.onUserRefreshed = { [weak self] user, json in
            self?.user = user
            self?.gate?.userRefreshed(onboardedAt: user.onboardedAt)
            SessionDefaults.cacheUser(json)
        }
        chat.onNotification = { event, notification in
            NotificationsCoordinator.shared.deliver(event, notification)
        }
        // M21: a decided approval's notification leaves Notification Center.
        chat.onApproval = { approval in
            NotificationsCoordinator.shared.approvalChanged(approval)
        }
        // M29: the app icon badge follows the Tasks tab's Waiting on you count.
        chat.onWaitingOnYou = { count in
            NotificationsCoordinator.shared.waitingOnYouChanged(count)
        }
        self.chat = chat
        chat.start()
        chat.setActive(foreground)
        phase = .signedIn
        NotificationsCoordinator.shared.sessionStarted(server: server, client: client, user: user)
        if gate.needsCompletePost { postOnboardingComplete() }
    }

    private func makeClient(server: ServerAddress, token: String) -> APIClient {
        let generation = generation
        return APIClient(server: server, token: token) { [weak self] in
            Task { @MainActor in
                guard let self, self.generation == generation, self.phase != .signedOut else { return }
                Self.log.notice("Session expired; back to sign-in")
                self.endSession()
            }
        }
    }

    /// Back to sign-in: drop the token, the cached user, the event cursor, the push device id
    /// (sign-out deletes it on the server first) and cached files.
    private func endSession() {
        generation += 1
        chat?.teardown()
        onboarding?.close()
        onboarding = nil
        completeTask?.cancel()
        completeTask = nil
        if let server {
            TokenStore.delete(for: server)
            if let user {
                EventCursor(server: server, userId: user.id).clear()
                SessionDefaults.setDeviceId(nil, server: server, userId: user.id)
            }
        } else if let saved = SessionDefaults.server {
            TokenStore.delete(for: saved)
        }
        SessionDefaults.clearUser()
        HTTPSessions.purgeFiles()
        NotificationsCoordinator.shared.sessionEnded()
        chat = nil
        client = nil
        user = nil
        server = nil
        gate = nil
        savedServer = SessionDefaults.server
        phase = .signedOut
    }
}
