// The OpenDuet sheet and connectors (AccessLayout, AccountBoard): the access rows' grouping and
// dashed-"+" suggestion, More apps (connected first, search answers), the detail's tool order
// and "All tools" mode, optimistic policy changes with rollback, and the OAuth lifecycle
// (connect -> PendingOAuth -> finished -> cleared, toolkit handed back for the refresh).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Connectors")
struct DataConnectorsTests {
    private let list = Fx.connectors([
        Fx.connectorJSON("googledocs", category: "files"),
        Fx.connectorJSON("gmail", category: "mail"),
        Fx.connectorJSON("outlook", category: "mail", connected: true),
        Fx.connectorJSON("googlecalendar", category: "calendar"),
        Fx.connectorJSON("notion", category: nil, connected: true),
        Fx.connectorJSON("dropbox", category: "files"),
    ])

    @Test("access rows: fixed order, connected per category, first unconnected one as the suggestion")
    func rows() {
        let rows = AccessLayout.rows(list.connectors)
        #expect(rows.map(\.category) == [.files, .mail, .calendar, .teamChat, .payments])
        #expect(rows[0].connected.isEmpty)
        #expect(rows[0].suggested?.toolkit == "googledocs")
        #expect(rows[1].connected.map(\.toolkit) == ["outlook"])
        #expect(rows[1].suggested?.toolkit == "gmail")
        #expect(rows[2].suggested?.toolkit == "googlecalendar")
        #expect(rows[3].connected.isEmpty && rows[3].suggested == nil)
        #expect(rows[4].suggested == nil)
    }

    @Test("More apps lists connected first, otherwise the server's order")
    func catalog() {
        #expect(AccessLayout.catalog(list.connectors).map(\.toolkit) == ["outlook", "notion", "googledocs", "gmail", "googlecalendar", "dropbox"])
    }

    @Test("connector lists: rows from the full list, the catalog follows the search text, stale answers are dropped")
    func search() {
        var board = AccountBoard()
        board.beginConnectorsLoad()
        #expect(board.assistant.phase == .loading)
        board.applyConnectors(list, query: nil)
        #expect(board.assistant.phase == .loaded)
        #expect(board.assistant.catalog.count == 6)

        board.setQuery("gm")
        let gmail = Fx.connectors([Fx.connectorJSON("gmail", category: "mail")])
        board.applyConnectors(Fx.connectors([Fx.connectorJSON("dropbox", category: "files")]), query: "dr")
        #expect(board.assistant.catalog.count == 6)
        board.applyConnectors(gmail, query: "gm")
        #expect(board.assistant.catalog.map(\.toolkit) == ["gmail"])
        #expect(board.assistant.rows[1].connected.map(\.toolkit) == ["outlook"])

        board.applyConnectors(Fx.connectors([], configured: false), query: nil)
        #expect(board.assistant.configured == false)
        #expect(board.assistant.catalog.map(\.toolkit) == ["gmail"])
    }

    @Test("detail tools: Read before Write, common first in each group; All tools mode")
    func detailTools() {
        var board = AccountBoard()
        board.openDetail("gmail")
        #expect(board.connectorDetail?.phase == .loading)
        board.applyDetail(Fx.connectorDetail("gmail", tools: [
            Fx.toolJSON("SEND", access: "write", common: true, mode: "ask"),
            Fx.toolJSON("LABEL", access: "write", common: false, mode: "ask"),
            Fx.toolJSON("SEARCH", access: "read", common: false, mode: "always"),
            Fx.toolJSON("FETCH", access: "read", common: true, mode: "always"),
        ]))
        let detail = board.connectorDetail
        #expect(detail?.phase == .loaded)
        #expect(detail?.tools.map(\.slug) == ["FETCH", "SEARCH", "SEND", "LABEL"])
        #expect(detail?.allMode == nil)

        board.applyDetail(Fx.connectorDetail("other", tools: []))
        #expect(board.connectorDetail?.toolkit == "gmail")
        board.closeDetail()
        #expect(board.connectorDetail == nil)
    }

    @Test("a policy change shows at once, success takes the server's copy, failure rolls back")
    func policy() {
        var board = AccountBoard()
        board.openDetail("gmail")
        #expect(board.beginPolicy("gmail", tool: nil, mode: .always) == false)
        let tools = [Fx.toolJSON("FETCH", access: "read", common: true, mode: "always"), Fx.toolJSON("SEND", access: "write", common: true, mode: "ask")]
        board.applyDetail(Fx.connectorDetail("gmail", tools: tools))

        let all = ShellState.RequestKey.policy("gmail", tool: nil)
        #expect(board.beginPolicy("gmail", tool: nil, mode: .always) == true)
        #expect(board.connectorDetail?.allMode == .always)
        #expect(board.requests[all] == .inFlight)
        #expect(board.beginPolicy("gmail", tool: nil, mode: .ask) == false)

        board.answerPolicy("gmail", tool: nil, .failure(APIError.unreachable))
        #expect(board.connectorDetail?.tools.map(\.mode) == [.always, .ask])
        #expect(board.requests[all] == .failed(reason: APIError.unreachable.localizedReason))

        let one = ShellState.RequestKey.policy("gmail", tool: "SEND")
        #expect(board.beginPolicy("gmail", tool: "SEND", mode: .always) == true)
        let server = [Fx.toolJSON("FETCH", access: "read", common: true, mode: "always"), Fx.toolJSON("SEND", access: "write", common: true, mode: "always")]
        board.answerPolicy("gmail", tool: "SEND", .success(Fx.connectorDetail("gmail", tools: server)))
        #expect(board.requests[one] == nil)
        #expect(board.connectorDetail?.allMode == .always)
    }

    @Test("OAuth: connect is in flight until the page finishes, then cleared and handed back for the refresh")
    func oauthLifecycle() {
        var board = AccountBoard()
        let key = ShellState.RequestKey.connect("gmail")
        #expect(board.beginConnect("gmail") == true)
        #expect(board.requests[key] == .inFlight)
        #expect(board.beginConnect("gmail") == false)

        let id = UUID()
        board.connectAnswered("gmail", .success(Fx.connectResponse()), id: id)
        #expect(board.oauth == PendingOAuth(id: id, toolkit: "gmail", url: URL(string: "https://connect.composio.dev/link/lk_1")!, callbackScheme: "duet"))
        #expect(board.requests[key] == .inFlight)
        // One hosted page at a time.
        #expect(board.beginConnect("slack") == false)

        #expect(board.finishOAuth(UUID()) == nil)
        #expect(board.oauth != nil)
        #expect(board.finishOAuth(id) == "gmail")
        #expect(board.oauth == nil)
        #expect(board.requests[key] == nil)
        #expect(board.finishOAuth(id) == nil)
    }

    @Test("OAuth: a failed POST connect leaves the reason; cancelling clears it")
    func connectFailure() {
        var board = AccountBoard()
        let key = ShellState.RequestKey.connect("gmail")
        #expect(board.beginConnect("gmail") == true)
        board.connectAnswered("gmail", .failure(APIError.notConfigured))
        #expect(board.oauth == nil)
        #expect(board.requests[key] == .failed(reason: APIError.notConfigured.localizedReason))
        #expect(board.beginConnect("gmail") == true)
        board.connectAnswered("gmail", .failure(CancellationError()))
        #expect(board.requests[key] == nil)
    }

    @Test("onboarding finds Slack in the catalog by name, then by slug")
    func slackToolkit() {
        // The fixture's display name is the capitalized slug ("Slackbot", "Slack").
        let byName = Fx.connectors([Fx.connectorJSON("slackbot", category: "team_chat"), Fx.connectorJSON("slack", category: "team_chat")])
        #expect(AccessLayout.slackToolkit(in: byName.connectors) == "slack")
        let bySlug = Fx.connectors([Fx.connectorJSON("gmail", category: "mail"), Fx.connectorJSON("slack_v2", category: "team_chat")])
        #expect(AccessLayout.slackToolkit(in: bySlug.connectors) == "slack_v2")
        #expect(AccessLayout.slackToolkit(in: []) == nil)
    }
}
