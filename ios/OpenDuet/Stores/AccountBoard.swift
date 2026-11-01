// The M4 sheets as one value: the OpenDuet sheet ("What OpenDuet has access to", More apps), the
// connector detail with its tool policies, the hosted OAuth page, the profile sheet, the Usage
// screen, which store-driven sheet is up, and the in-flight / failed M4 taps (merged into
// ShellState.cardRequests under the AccountContract RequestKeys). ChatStore does the I/O; this
// stays Foundation + models, so the Mac host tests drive it.
import Foundation

extension ShellState.RequestKey {
    /// Up next's "Show me" (POST /api/up-next/scan): `.failed(reason)` when the scan couldn't start.
    static let scan = "upnext:scan"
}

/// "What OpenDuet has access to" and the More apps catalog, from GET /api/connectors.
enum AccessLayout {
    /// The OpenDuet sheet's rows, in display order (L126).
    static let order: [AccessCategory] = [.files, .mail, .calendar, .teamChat, .payments]

    /// One row per category: the connected connectors of it, and while none is connected the
    /// first catalog connector of it as the dashed "+" target (nil = "+" opens More apps).
    static func rows(_ connectors: [Connector]) -> [AccessRow] {
        order.map { category in
            let inCategory = connectors.filter { $0.category == category }
            return AccessRow(
                category: category,
                connected: inCategory.filter(\.isConnected),
                suggested: inCategory.first { !$0.isConnected }
            )
        }
    }

    /// More apps: connected first, otherwise the server's order. The assistant's computer has its own
    /// row in the OpenDuet sheet (M6), so it isn't listed as an app to connect.
    static func catalog(_ connectors: [Connector]) -> [Connector] {
        let apps = connectors.filter { $0.toolkit != ComputerToolkit.slug }
        return apps.filter(\.isConnected) + apps.filter { !$0.isConnected }
    }

    /// The detail sheet's tools: Read (Always) first, then Write (Ask); common tools first in each
    /// group; otherwise the server's order (L167).
    static func tools(_ tools: [ConnectorTool]) -> [ConnectorTool] {
        tools.enumerated().sorted { a, b in
            let ka = (a.element.access == .read ? 0 : 1, a.element.common ? 0 : 1, a.offset)
            let kb = (b.element.access == .read ? 0 : 1, b.element.common ? 0 : 1, b.offset)
            return ka < kb
        }.map(\.element)
    }

    /// Onboarding's "Connect Slack": Slack in the catalog, by display name, else by slug.
    static func slackToolkit(in connectors: [Connector]) -> String? {
        connectors.first { $0.name.caseInsensitiveCompare("Slack") == .orderedSame }?.toolkit
            ?? connectors.first { $0.toolkit.lowercased().contains("slack") }?.toolkit
    }
}

struct AccountBoard: Sendable {
    var assistant = AssistantAccessState()
    private(set) var connectorDetail: ConnectorDetailState?
    private(set) var oauth: PendingOAuth?
    var profile = ProfileState()
    var usageScreen = UsageScreenState()
    var presented: ShellPresentation?
    /// M4 taps by ShellState.RequestKey (merged into ShellState.cardRequests).
    private(set) var requests: ShellState.CardRequests = [:]
    /// Optimistic policy changes by request key: the tool modes before the change (rollback).
    private var policyRollback: [String: [String: PolicyMode]] = [:]
    /// The notification settings before an optimistic PATCH /api/me.
    private var profileRollback: CurrentUser?
    /// M9: when each Usage panel range was last answered, and the ranges loading now.
    private var usageStatsFetchedAt: [UsageRange: Date] = [:]
    private(set) var usageStatsLoading = Set<UsageRange>()

    // MARK: - Requests

    /// Marks a tap in flight; false when one is already running for this key.
    mutating func begin(_ key: String) -> Bool {
        guard requests[key] != .inFlight else { return false }
        requests[key] = .inFlight
        return true
    }

    mutating func clear(_ key: String) { requests[key] = nil }

    mutating func fail(_ key: String, _ error: any Error) {
        if error is CancellationError { requests[key] = nil } else { requests[key] = .failed(reason: TaskBoard.reason(for: error)) }
    }

    /// The common answer: success clears the request and hands back the value; cancellation
    /// clears it; any other failure leaves `.failed(reason:)` (Retry = the same call).
    mutating func answer<T>(_ key: String, _ result: Result<T, any Error>) -> T? {
        switch result {
        case .success(let value):
            requests[key] = nil
            return value
        case .failure(let error):
            fail(key, error)
            return nil
        }
    }

    // MARK: - OpenDuet sheet

    mutating func beginConnectorsLoad() {
        if assistant.phase != .loaded { assistant.phase = .loading }
    }

    /// GET /api/connectors answered. The rows always come from the unfiltered list (query nil);
    /// the catalog follows the search text, so a late answer for an older query is dropped.
    mutating func applyConnectors(_ list: ConnectorList, query: String?) {
        let query = query ?? ""
        if query.isEmpty {
            assistant.configured = list.configured
            assistant.rows = AccessLayout.rows(list.connectors)
            if assistant.query.isEmpty { assistant.catalog = AccessLayout.catalog(list.connectors) }
            assistant.phase = .loaded
        } else if query == assistant.query {
            assistant.configured = list.configured
            assistant.catalog = AccessLayout.catalog(list.connectors)
        }
    }

    mutating func failConnectors(reason: String) {
        if assistant.phase != .loaded { assistant.phase = .failed(reason: reason) }
    }

    mutating func setQuery(_ query: String) {
        assistant.query = query
    }

    // MARK: - Connector detail

    /// Opens (or reloads) the detail sheet; another toolkit starts over with the skeleton.
    mutating func openDetail(_ toolkit: String) {
        if connectorDetail?.toolkit != toolkit { connectorDetail = ConnectorDetailState(toolkit: toolkit) }
    }

    mutating func closeDetail() {
        connectorDetail = nil
    }

    /// GET /api/connectors/:toolkit (or a PUT policy answer) for the open sheet.
    mutating func applyDetail(_ detail: ConnectorDetail) {
        guard connectorDetail?.toolkit == detail.connector.toolkit else { return }
        connectorDetail?.connector = detail.connector
        connectorDetail?.tools = AccessLayout.tools(detail.tools)
        connectorDetail?.phase = .loaded
    }

    /// M6: the open detail has nothing to load (the assistant's computer on a server without its
    /// toolkit): loaded, with no tools.
    mutating func emptyDetail(_ toolkit: String) {
        guard connectorDetail?.toolkit == toolkit else { return }
        connectorDetail?.tools = []
        connectorDetail?.phase = .loaded
    }

    mutating func failDetail(_ toolkit: String, reason: String) {
        guard connectorDetail?.toolkit == toolkit, connectorDetail?.phase != .loaded else { return }
        connectorDetail?.phase = .failed(reason: reason)
    }

    // MARK: - Connect (OAuth, L127)

    /// The dashed "+" / "+ Add account": in flight from POST connect until the OAuth page is done.
    mutating func beginConnect(_ toolkit: String) -> Bool {
        guard oauth == nil else { return false }
        return begin(ShellState.RequestKey.connect(toolkit))
    }

    /// POST /api/connectors/:toolkit/connect answered: success shows the hosted page (the request
    /// stays in flight until it finishes); failure leaves the reason.
    mutating func connectAnswered(_ toolkit: String, _ result: Result<ConnectResponse, any Error>, id: UUID = UUID()) {
        let key = ShellState.RequestKey.connect(toolkit)
        switch result {
        case .success(let response):
            guard requests[key] == .inFlight else { return }
            oauth = PendingOAuth(id: id, toolkit: toolkit, url: response.url, callbackScheme: response.callbackScheme)
        case .failure(let error):
            fail(key, error)
        }
    }

    /// The OAuth page finished (callback or cancel): clears it and its request and returns the
    /// toolkit to refresh; nil when `id` isn't the page on screen (a late duplicate).
    mutating func finishOAuth(_ id: UUID) -> String? {
        guard let current = oauth, current.id == id else { return nil }
        oauth = nil
        requests[ShellState.RequestKey.connect(current.toolkit)] = nil
        return current.toolkit
    }

    // MARK: - Tool policies (L167)

    /// Ask / Always for one tool, or every tool (tool nil): applied at once, in flight meanwhile.
    mutating func beginPolicy(_ toolkit: String, tool: String?, mode: PolicyMode) -> Bool {
        guard var detail = connectorDetail, detail.toolkit == toolkit, detail.phase == .loaded else { return false }
        let key = ShellState.RequestKey.policy(toolkit, tool: tool)
        guard begin(key) else { return false }
        var before: [String: PolicyMode] = [:]
        for index in detail.tools.indices where tool == nil || detail.tools[index].slug == tool {
            before[detail.tools[index].slug] = detail.tools[index].mode
            detail.tools[index].mode = mode
        }
        policyRollback[key] = before
        connectorDetail = detail
        return true
    }

    /// PUT policy answered: success takes the server's detail; failure puts the modes back and
    /// leaves the reason.
    mutating func answerPolicy(_ toolkit: String, tool: String?, _ result: Result<ConnectorDetail, any Error>) {
        let key = ShellState.RequestKey.policy(toolkit, tool: tool)
        let before = policyRollback.removeValue(forKey: key) ?? [:]
        switch result {
        case .success(let detail):
            requests[key] = nil
            applyDetail(detail)
        case .failure(let error):
            fail(key, error)
            guard connectorDetail?.toolkit == toolkit, var tools = connectorDetail?.tools else { return }
            for index in tools.indices {
                if let mode = before[tools[index].slug] { tools[index].mode = mode }
            }
            connectorDetail?.tools = tools
        }
    }

    // MARK: - Profile

    mutating func setUser(_ user: CurrentUser) {
        profile.user = user
    }

    /// Notifications (brief time, weekends): shown at once, rolled back if PATCH /api/me fails.
    mutating func beginNotifications(briefTime: LocalTime?, weekendsOn: Bool?) -> Bool {
        guard var user = profile.user, begin(ShellState.RequestKey.saveProfile) else { return false }
        profileRollback = user
        if let briefTime { user.briefTime = briefTime }
        if let weekendsOn { user.weekendsOn = weekendsOn }
        profile.user = user
        return true
    }

    mutating func answerNotifications(_ result: Result<CurrentUser, any Error>) {
        let before = profileRollback
        profileRollback = nil
        if let user = answer(ShellState.RequestKey.saveProfile, result) {
            profile.user = user
        } else if let before, case .failure = result {
            profile.user?.briefTime = before.briefTime
            profile.user?.weekendsOn = before.weekendsOn
        }
    }

    // MARK: - Memory

    mutating func beginMemory() {
        if profile.memoryPhase != .loaded { profile.memoryPhase = .loading }
    }

    mutating func applyMemory(_ memory: MemoryState) {
        profile.memory = memory
        profile.memoryPhase = .loaded
    }

    mutating func failMemory(reason: String) {
        if profile.memoryPhase != .loaded { profile.memoryPhase = .failed(reason: reason) }
    }

    // MARK: - Usage (L129)

    /// The first load shows the skeleton; the refresh button keeps the bars and sets `refreshing`.
    mutating func beginUsage() {
        if usageScreen.phase == .loaded { usageScreen.refreshing = true } else { usageScreen.phase = .loading }
    }

    mutating func applyUsage(_ usage: UsageState) {
        usageScreen.usage = usage
        usageScreen.phase = .loaded
        usageScreen.refreshing = false
    }

    mutating func failUsage(reason: String) {
        usageScreen.refreshing = false
        if usageScreen.phase != .loaded { usageScreen.phase = .failed(reason: reason) }
    }

    /// A `usage` event: the screen follows it live.
    mutating func usageEvent(_ usage: UsageState) {
        usageScreen.usage = usage
        usageScreen.phase = .loaded
        // M9: tokens moved, so the panel's cached ranges are worth fetching again next time.
        usageStatsStale()
    }

    // MARK: - Usage panel (M9, contract §5)

    /// How long a range's stats count as fresh: showing the panel again within it reuses them.
    static let usageStatsFreshness: TimeInterval = 30

    /// AccountActions.loadUsageStats: the panel shows `range`. Returns true when GET
    /// /api/usage/stats should go out: never cached, older than the freshness window (or marked
    /// stale), or failed, and not already loading. A cached range keeps showing meanwhile.
    mutating func beginUsageStats(_ range: UsageRange, now: Date = .now) -> Bool {
        usageScreen.range = range
        guard !usageStatsLoading.contains(range) else { return false }
        if usageScreen.stats[range] != nil, let fetched = usageStatsFetchedAt[range],
           now.timeIntervalSince(fetched) < Self.usageStatsFreshness {
            return false
        }
        usageStatsLoading.insert(range)
        if usageScreen.stats[range] == nil { usageScreen.statsPhase[range] = .loading }
        return true
    }

    mutating func applyUsageStats(_ stats: UsageStats, range: UsageRange, now: Date = .now) {
        usageStatsLoading.remove(range)
        usageScreen.stats[range] = stats
        usageScreen.statsPhase[range] = .loaded
        usageStatsFetchedAt[range] = now
    }

    /// A failed load: a cached range keeps its numbers; otherwise the inline reason + Retry.
    mutating func failUsageStats(_ range: UsageRange, _ error: any Error) {
        usageStatsLoading.remove(range)
        if error is CancellationError {
            if usageScreen.stats[range] == nil { usageScreen.statsPhase[range] = nil }
            return
        }
        if usageScreen.stats[range] == nil { usageScreen.statsPhase[range] = .failed(reason: TaskBoard.reason(for: error)) }
    }

    /// Runs ended or usage moved: every cached range loads again the next time it is shown.
    mutating func usageStatsStale() {
        usageStatsFetchedAt = [:]
    }

    /// "Reset for free" answered. Success shows the new bars; 409 (the reset isn't available, e.g.
    /// already used this month) leaves that reason and asks for a fresh GET /api/usage (true).
    mutating func answerFullReset(_ result: Result<UsageState, any Error>) -> Bool {
        let key = ShellState.RequestKey.fullReset
        switch result {
        case .success(let usage):
            requests[key] = nil
            applyUsage(usage)
            return false
        case .failure(let error as APIError) where error.isConflict:
            requests[key] = .failed(reason: String(localized: "Full reset isn't available right now."))
            return true
        case .failure(let error):
            fail(key, error)
            return false
        }
    }
}

extension APIError {
    /// 409: stale_version, or another code the server answers with a conflict.
    var isConflict: Bool {
        switch self {
        case .staleVersion: true
        case .server(let status, _): status == 409
        default: false
        }
    }
}
