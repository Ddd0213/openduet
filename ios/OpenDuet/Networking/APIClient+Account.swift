// The M4 JSON routes (docs/API.md "Routes"): the profile (PATCH /api/me), onboarding's real data,
// channels (create, archive, the Archived list), Scheduled and Up next scans, usage, memory,
// devices (remote push), feedback and connectors. Errors map to APIError as everywhere else.
// Connector logos aren't fetched here: `Connector.logoUrl` is a server-relative path the UI loads
// through `authenticatedLoader`.
import Foundation

extension APIClient {
    // MARK: - Me and onboarding

    /// PATCH /api/me (only the fields that changed), with the raw JSON for the offline cache.
    nonisolated func updateMe(_ body: UpdateMeRequest) async throws -> (CurrentUser, Data) {
        let data = try await send(try makeRequest("PATCH", "/api/me", json: body))
        return (try decode(CurrentUser.self, from: data), data)
    }

    /// GET /api/onboarding: page 2's chips and page 5's Slack row.
    nonisolated func onboarding() async throws -> OnboardingInfo {
        try await get("/api/onboarding")
    }

    /// POST /api/onboarding/complete (the assistant's welcome and the first-day scan arrive as events),
    /// with the user's raw JSON for the offline cache.
    nonisolated func completeOnboarding() async throws -> (OnboardingCompleteResponse, Data?) {
        let data = try await send(try makeRequest("POST", "/api/onboarding/complete"))
        return (try decode(OnboardingCompleteResponse.self, from: data), Self.jsonField("user", of: data))
    }

    // MARK: - Channels

    /// GET /api/channels?archived=true: the side menu's "Archived" list.
    nonisolated func archivedChannels() async throws -> [Channel] {
        let list: ChannelList = try await get("/api/channels", query: [URLQueryItem(name: "archived", value: "true")])
        return list.channels
    }

    /// POST /api/channels (the assistant's hello arrives as events).
    nonisolated func createChannel(_ body: CreateChannelRequest) async throws -> Channel {
        try await call("POST", "/api/channels", json: body)
    }

    /// PATCH /api/channels/:id (Archive / Unarchive; M9: Edit channel).
    nonisolated func updateChannel(id: String, _ body: UpdateChannelRequest) async throws -> Channel {
        try await call("PATCH", "/api/channels/\(id.pathSegment)", json: body)
    }

    /// M9: DELETE /api/channels/:id (204; the main thread is 400). channel_deleted follows.
    nonisolated func deleteChannel(id: String) async throws {
        _ = try await send(try makeRequest("DELETE", "/api/channels/\(id.pathSegment)"))
    }

    // MARK: - Scheduled and Up next

    nonisolated func schedule() async throws -> ScheduleInfo {
        try await get("/api/schedule")
    }

    /// POST /api/schedule/run ("Run now"); the run's output arrives as events.
    nonisolated func runNow(_ kind: RunNowRequest.Kind) async throws -> RunRecord {
        let response: RunNowResponse = try await call("POST", "/api/schedule/run", json: RunNowRequest(kind: kind))
        return response.run
    }

    /// POST /api/up-next/scan (202; the suggestions arrive as events, GET /api/up-next says when
    /// the scan is over).
    nonisolated func scanUpNext() async throws {
        _ = try await send(try makeRequest("POST", "/api/up-next/scan"))
    }

    // MARK: - Usage

    nonisolated func usage() async throws -> UsageState {
        try await get("/api/usage")
    }

    /// M9: GET /api/usage/stats?range= (the Usage panel).
    nonisolated func usageStats(range: UsageRange) async throws -> UsageStats {
        try await get("/api/usage/stats", query: [URLQueryItem(name: "range", value: range.rawValue)])
    }

    /// POST /api/usage/full-reset ("Reset for free").
    nonisolated func fullReset() async throws -> UsageState {
        try decode(UsageState.self, from: try await send(try makeRequest("POST", "/api/usage/full-reset")))
    }

    // MARK: - Memory

    nonisolated func memory() async throws -> MemoryState {
        try await get("/api/memory")
    }

    nonisolated func saveMemory(_ document: String) async throws -> MemoryState {
        try await call("PUT", "/api/memory", json: UpdateMemoryRequest(document: document))
    }

    // MARK: - Devices and feedback

    /// POST /api/devices: this iPhone's APNs token.
    nonisolated func registerDevice(_ body: RegisterDeviceRequest) async throws -> String {
        let response: RegisterDeviceResponse = try await call("POST", "/api/devices", json: body)
        return response.deviceId
    }

    /// DELETE /api/devices/:id (sign-out).
    nonisolated func deleteDevice(id: String) async throws {
        _ = try await send(try makeRequest("DELETE", "/api/devices/\(id.pathSegment)"))
    }

    /// POST /api/feedback (204; "Thanks for the feedback" arrives in chat as an event).
    nonisolated func sendFeedback(_ body: FeedbackRequest) async throws {
        _ = try await send(try makeRequest("POST", "/api/feedback", json: body))
    }

    // MARK: - Connectors

    /// GET /api/connectors?query=: connected first, then the catalog.
    nonisolated func connectors(query: String?) async throws -> ConnectorList {
        let items = query.flatMap { $0.isEmpty ? nil : [URLQueryItem(name: "query", value: $0)] } ?? []
        return try await get("/api/connectors", query: items)
    }

    /// GET /api/connectors/:toolkit; the assistant's computer row is GET /api/computer/tools.
    nonisolated func connector(toolkit: String) async throws -> ConnectorDetail {
        if toolkit == ComputerToolkit.slug { return try await get("/api/computer/tools") }
        return try await get("/api/connectors/\(toolkit.pathSegment)")
    }

    /// POST /api/connectors/:toolkit/connect: Composio's hosted OAuth page.
    nonisolated func connect(toolkit: String) async throws -> ConnectResponse {
        try decode(ConnectResponse.self, from: try await send(try makeRequest("POST", "/api/connectors/\(toolkit.pathSegment)/connect")))
    }

    /// DELETE /api/connectors/:toolkit/accounts/:accountId (Disconnect).
    nonisolated func disconnect(toolkit: String, accountId: String) async throws {
        _ = try await send(try makeRequest("DELETE", "/api/connectors/\(toolkit.pathSegment)/accounts/\(accountId.pathSegment)"))
    }

    /// PUT /api/connectors/:toolkit/policy: one tool, or "All tools" when tool is nil
    /// (the assistant's computer: PUT /api/computer/policy).
    nonisolated func setPolicy(toolkit: String, _ body: UpdatePolicyRequest) async throws -> ConnectorDetail {
        if toolkit == ComputerToolkit.slug { return try await call("PUT", "/api/computer/policy", json: body) }
        return try await call("PUT", "/api/connectors/\(toolkit.pathSegment)/policy", json: body)
    }
}
