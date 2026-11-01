// Onboarding with real data (L77): page 2's chips and page 5's Slack row from GET /api/onboarding;
// the Slack "+" starts a real Composio connection (POST /api/connectors/<slack>/connect ->
// PendingOAuth -> OAuthPresenter) and the row is fetched again when the page finishes, whatever
// the callback said. Finishing is SessionStore's (OnboardingGate): the first run posts
// /api/onboarding/complete once, a replay never does.
import Foundation
import Observation
import OSLog

@MainActor
@Observable
final class OnboardingModel {
    private(set) var state = OnboardingDataState()

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let onFinish: () -> Void
    /// The catalog's Slack toolkit (GET /api/connectors?query=slack); "slack" until known.
    @ObservationIgnored private var slackToolkit = "slack"
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var connectTask: Task<Void, Never>?
    @ObservationIgnored private var closed = false

    private static let log = Logger(subsystem: "dev.openduet.OpenDuet", category: "onboarding")

    init(client: APIClient, onFinish: @escaping () -> Void) {
        self.client = client
        self.onFinish = onFinish
    }

    var actions: OnboardingActions {
        var actions = OnboardingActions()
        actions.connectSlack = { [weak self] in self?.connectSlack() }
        actions.oauthFinished = { [weak self] id, callback in self?.oauthFinished(id, callback: callback) }
        actions.finish = { [weak self] in self?.onFinish() }
        return actions
    }

    /// The flow appeared: the chips, the Slack row and the Slack toolkit, side by side.
    func load() {
        guard !closed else { return }
        loadTask?.cancel()
        loadTask = Task { [client] in
            async let info = Self.result { try await client.onboarding() }
            async let slack = Self.result { try await client.connectors(query: "slack") }
            let (infoResult, slackResult) = await (info, slack)
            guard !Task.isCancelled, !closed else { return }
            if case .success(let list) = slackResult, let toolkit = AccessLayout.slackToolkit(in: list.connectors) {
                slackToolkit = toolkit
            }
            switch infoResult {
            case .success(let info): apply(info)
            case .failure(let error): Self.log.error("GET /api/onboarding failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// Page 5's "+": POST connect, then the hosted page (slackConnecting until the row is fetched again).
    func connectSlack() {
        guard !closed, !state.slackConnecting, !state.slackConnected else { return }
        state.slackConnecting = true
        let toolkit = slackToolkit
        connectTask = Task { [client] in
            let result = await Self.result { try await client.connect(toolkit: toolkit) }
            guard !Task.isCancelled, !closed else { return }
            switch result {
            case .success(let response):
                state.oauth = PendingOAuth(id: UUID(), toolkit: toolkit, url: response.url, callbackScheme: response.callbackScheme)
            case .failure(let error):
                Self.log.error("Slack connect failed: \(String(describing: error), privacy: .public)")
                state.slackConnecting = false
            }
        }
    }

    /// The OAuth page finished: Composio's state is the server's, so fetch the row again either
    /// way (after a callback, a couple of retries while Composio settles).
    func oauthFinished(_ id: UUID, callback: URL?) {
        guard state.oauth?.id == id else { return }
        state.oauth = nil
        loadTask?.cancel()
        loadTask = Task { [client] in
            let attempts = callback == nil ? 1 : 3
            for attempt in 0..<attempts {
                if attempt > 0 { try? await Task.sleep(for: .seconds(1.5)) }
                guard !Task.isCancelled, !closed else { return }
                if let info = try? await client.onboarding() {
                    guard !Task.isCancelled, !closed else { return }
                    apply(info)
                    if info.slack.connected { break }
                }
            }
            state.slackConnecting = false
        }
    }

    /// The flow went away (finished, signed out or replaced by a replay).
    func close() {
        closed = true
        loadTask?.cancel()
        connectTask?.cancel()
    }

    private func apply(_ info: OnboardingInfo) {
        state.chips = info.chips
        state.slackConnected = info.slack.connected
    }

    nonisolated private static func result<T: Sendable>(_ body: @Sendable () async throws -> T) async -> Result<T, any Error> {
        do {
            return .success(try await body())
        } catch {
            return .failure(error)
        }
    }
}
