// M11 (agent A) data logic: the three new message kinds (memory_note, soul_proposal,
// connection_request) decode exactly the zod payloads; a connection card's Connect answer
// (success upserts, 400 keeps the server's words, 409 reloads the thread, cancel clears); the
// New channel request carries the picked access with greet true; the connect body leaves out
// what the user didn't type.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

extension Fx {
    static func memoryNoteJSON(_ id: String = "msg_mem", op: String = "remembered", scope: String = "channel",
                               state: String = "done", updated: Int? = nil) -> [String: Any] {
        cardJSON(id, at: 10, kind: "memory_note", payload: [
            "op": op, "factId": "mem_1", "text": "Prefers invoices as PDF", "scope": scope, "state": state,
        ], updated: updated)
    }

    static func soulProposalJSON(_ id: String = "msg_soul", field: String = "tone", current: String = "",
                                 state: String = "open", updated: Int? = nil) -> [String: Any] {
        cardJSON(id, at: 20, kind: "soul_proposal", payload: [
            "field": field, "current": current, "proposed": "Warm and brief. No exclamation marks.",
            "reason": "You asked me twice to keep it shorter.", "state": state,
        ], updated: updated)
    }

    /// The api_key card of docs/api-samples/m11.json (Weather, one secret field "key").
    static func apiKeyCardPayload(state: String = "open", domain: String? = "api.openweathermap.org",
                                  connectorId: String? = nil) -> [String: Any] {
        [
            "type": "api_key", "name": "Weather", "purpose": "To check tomorrow's rain before the delivery run.",
            "url": NSNull(), "domain": domain ?? NSNull(), "toolkit": NSNull(), "headerName": "X-Api-Key", "valuePrefix": "",
            "fields": [["key": "key", "label": "API key", "secret": true, "placeholder": NSNull()]],
            "state": state, "connectorId": connectorId ?? NSNull(),
        ]
    }

    static func mcpCardPayload(url: String? = "https://mcp.example.com/mcp", state: String = "open") -> [String: Any] {
        [
            "type": "mcp", "name": "Shop inventory", "purpose": "To read stock levels.",
            "url": url ?? NSNull(), "domain": NSNull(), "toolkit": NSNull(), "headerName": NSNull(), "valuePrefix": NSNull(),
            "fields": [
                ["key": "Authorization", "label": "Authorization header", "secret": true, "placeholder": "Bearer …"],
                ["key": "X-Shop", "label": "Shop id", "secret": false, "placeholder": NSNull()],
            ],
            "state": state, "connectorId": NSNull(),
        ]
    }

    static func appCardPayload(state: String = "open") -> [String: Any] {
        [
            "type": "app", "name": "Google Calendar", "purpose": "To put the delivery runs in your calendar.",
            "url": NSNull(), "domain": NSNull(), "toolkit": "googlecalendar", "headerName": NSNull(), "valuePrefix": NSNull(),
            "fields": [], "state": state, "connectorId": NSNull(),
        ]
    }

    static func connectionCard(_ payload: [String: Any], id: String = "msg_conn", updated: Int? = nil) -> Message {
        decode(Message.self, cardJSON(id, at: 30, kind: "connection_request", payload: payload, updated: updated))
    }

    static func connectionPayload(_ payload: [String: Any]) -> ConnectionRequestPayload? {
        if case .connectionRequest(let card) = connectionCard(payload).content { card } else { nil }
    }
}

@Suite("M11a message kinds")
struct DataM11AKindsTests {
    @Test("memory_note decodes op, fact, text, scope and state")
    func memoryNote() {
        let message = Fx.decode(Message.self, Fx.memoryNoteJSON())
        guard case .memoryNote(let note) = message.content else { Issue.record("not a memory note"); return }
        #expect(note == MemoryNotePayload(op: .remembered, factId: "mem_1", text: "Prefers invoices as PDF", scope: .channel, state: .done))

        let forgot = Fx.decode(Message.self, Fx.memoryNoteJSON(op: "forgot", scope: "shared", state: "undone"))
        guard case .memoryNote(let other) = forgot.content else { Issue.record("not a memory note"); return }
        #expect(other.op == .forgot)
        #expect(other.scope == .shared)
        #expect(other.state == .undone)
    }

    @Test("soul_proposal decodes every field name and state")
    func soulProposal() {
        let fields: [(String, SoulProposalPayload.Field)] = [
            ("name", .name), ("addressAs", .addressAs), ("identity", .identity),
            ("persona", .persona), ("tone", .tone), ("soulExtra", .soulExtra),
        ]
        for (raw, field) in fields {
            let message = Fx.decode(Message.self, Fx.soulProposalJSON(field: raw))
            guard case .soulProposal(let card) = message.content else { Issue.record("not a soul proposal: \(raw)"); continue }
            #expect(card.field == field)
            #expect(card.current.isEmpty)
            #expect(card.proposed == "Warm and brief. No exclamation marks.")
            #expect(card.reason == "You asked me twice to keep it shorter.")
            #expect(card.state == .open)
        }
        for (raw, state) in [("applied", SoulProposalPayload.State.applied), ("dismissed", .dismissed)] {
            let message = Fx.decode(Message.self, Fx.soulProposalJSON(current: "Plain.", state: raw))
            guard case .soulProposal(let card) = message.content else { Issue.record("not a soul proposal"); continue }
            #expect(card.state == state)
            #expect(card.current == "Plain.")
        }
    }

    @Test("connection_request decodes api_key, mcp and app cards with their nulls")
    func connectionRequest() {
        let apiKey = Fx.connectionPayload(Fx.apiKeyCardPayload())
        #expect(apiKey?.type == .apiKey)
        #expect(apiKey?.name == "Weather")
        #expect(apiKey?.domain == "api.openweathermap.org")
        #expect(apiKey?.url == nil)
        #expect(apiKey?.toolkit == nil)
        #expect(apiKey?.headerName == "X-Api-Key")
        #expect(apiKey?.valuePrefix == "")
        #expect(apiKey?.fields == [ConnectionRequestPayload.Field(key: "key", label: "API key", secret: true, placeholder: nil)])
        #expect(apiKey?.state == .open)
        #expect(apiKey?.connectorId == nil)

        let mcp = Fx.connectionPayload(Fx.mcpCardPayload(state: "connected"))
        #expect(mcp?.type == .mcp)
        #expect(mcp?.url == "https://mcp.example.com/mcp")
        #expect(mcp?.domain == nil)
        #expect(mcp?.headerName == nil)
        #expect(mcp?.fields.map(\.key) == ["Authorization", "X-Shop"])
        #expect(mcp?.fields.first?.placeholder == "Bearer …")
        #expect(mcp?.state == .connected)

        let app = Fx.connectionPayload(Fx.appCardPayload(state: "dismissed"))
        #expect(app?.type == .app)
        #expect(app?.toolkit == "googlecalendar")
        #expect(app?.fields.isEmpty == true)
        #expect(app?.state == .dismissed)

        let connected = Fx.connectionPayload(Fx.apiKeyCardPayload(state: "connected", connectorId: "cc_2"))
        #expect(connected?.connectorId == "cc_2")
    }

    @Test("an unknown kind still decodes as unsupported")
    func unknownKind() {
        let message = Fx.decode(Message.self, Fx.cardJSON("msg_x", at: 1, kind: "hologram", payload: [:]))
        #expect(message.content == .unsupported(kind: "hologram"))
    }
}

@Suite("M11a connection card answer")
struct DataM11AConnectTests {
    private func shownCard(_ main: ThreadReducer) -> ConnectionRequestPayload? {
        if case .connectionRequest(let card)? = main.thread.messages.first?.content { card } else { nil }
    }

    private func setUp() -> (TaskBoard, ThreadReducer) {
        var main = ThreadReducer(channelId: Fx.main)
        main.applyFirstPage(Fx.page([Fx.connectionCard(Fx.apiKeyCardPayload(), updated: 30)]))
        return (TaskBoard(), main)
    }

    @Test("success clears the request and upserts the connected card")
    func success() {
        var (board, main) = setUp()
        let began = board.beginRequest("msg_conn")
        #expect(began)
        let again = board.beginRequest("msg_conn")
        #expect(!again, "one Connect at a time")
        let connected = Fx.connectionCard(Fx.apiKeyCardPayload(state: "connected", connectorId: "cc_2"), updated: 40)
        let follow = board.answerConnection(messageId: "msg_conn", .success(connected), main: &main)
        #expect(follow == .nothing)
        #expect(board.cardRequests["msg_conn"] == nil)
        #expect(shownCard(main)?.state == .connected)
        #expect(shownCard(main)?.connectorId == "cc_2")
        #expect(main.thread.messages.count == 1)
    }

    @Test("a 400 keeps the card open with the server's own words")
    func validationFailure() {
        var (board, main) = setUp()
        _ = board.beginRequest("msg_conn")
        let error = APIError.validationFailed(field: "values", message: "The server answered 401: check the key.")
        let follow = board.answerConnection(messageId: "msg_conn", .failure(error), main: &main)
        #expect(follow == .nothing)
        #expect(board.cardRequests["msg_conn"] == .failed(reason: "The server answered 401: check the key."))
        #expect(shownCard(main)?.state == .open)
        // Retry is a new Connect.
        let retry = board.beginRequest("msg_conn")
        #expect(retry)
    }

    @Test("a 400 without a message falls back to the usual reason")
    func emptyValidationMessage() {
        var (board, main) = setUp()
        _ = board.beginRequest("msg_conn")
        let error = APIError.validationFailed(field: nil, message: "  ")
        _ = board.answerConnection(messageId: "msg_conn", .failure(error), main: &main)
        #expect(board.cardRequests["msg_conn"] == .failed(reason: error.localizedReason))
    }

    @Test("a 409 says the card was answered and reloads the card's thread")
    func conflict() {
        for error in [APIError.staleVersion, .server(status: 409, code: "conflict")] {
            var (board, main) = setUp()
            _ = board.beginRequest("msg_conn")
            let follow = board.answerConnection(messageId: "msg_conn", .failure(error), main: &main)
            #expect(follow == .reload(.main))
            #expect(board.cardRequests["msg_conn"] == .failed(reason: String(localized: "This card was already answered.")))
        }
        #expect(ConnectionAnswer.isConflict(.server(status: 409, code: "other")))
        #expect(ConnectionAnswer.isConflict(.server(status: 500, code: "conflict")))
        #expect(!ConnectionAnswer.isConflict(.server(status: 500, code: "internal")))
        #expect(!ConnectionAnswer.isConflict(.notFound))
    }

    @Test("cancel clears; anything else shows the usual reason without a reload")
    func cancelAndOther() {
        var (board, main) = setUp()
        _ = board.beginRequest("msg_conn")
        let cancelled = board.answerConnection(messageId: "msg_conn", .failure(CancellationError()), main: &main)
        #expect(cancelled == .nothing)
        #expect(board.cardRequests["msg_conn"] == nil)

        _ = board.beginRequest("msg_conn")
        let other = board.answerConnection(messageId: "msg_conn", .failure(APIError.unreachable), main: &main)
        #expect(other == .nothing)
        #expect(board.cardRequests["msg_conn"] == .failed(reason: APIError.unreachable.localizedReason))
        #expect(shownCard(main)?.state == .open)
    }
}

@Suite("M11a request bodies")
struct DataM11ABodiesTests {
    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONCoding.encoder().encode(value)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("New channel sends the picked access with greet true")
    func createChannel() throws {
        let body = CreateChannelRequest(
            name: "Bike shop", icon: .checkbox, colorHex: .orange, purpose: "Orders and suppliers",
            access: [AccessRef(kind: .skill, id: "skill_2"), AccessRef(kind: .connector, id: "cc_1")], greet: true
        )
        let object = try json(body)
        #expect(object["name"] as? String == "Bike shop")
        #expect(object["colorHex"] as? String == "#E69F4E")
        #expect(object["greet"] as? Bool == true)
        let access = try #require(object["access"] as? [[String: String]])
        #expect(access == [["kind": "skill", "id": "skill_2"], ["kind": "connector", "id": "cc_1"]])

        let none = try json(CreateChannelRequest(name: "Plain", icon: .chart, colorHex: .berry, purpose: "", access: [], greet: true))
        #expect((none["access"] as? [Any])?.isEmpty == true)
        #expect(none["greet"] as? Bool == true)
    }

    @Test("the connect body leaves out name, url and domain the user didn't type")
    func connectBody() throws {
        let bare = try json(ConnectRequestSubmit(values: ["key": "k-123"]))
        #expect(bare.keys.sorted() == ["values"])
        #expect(bare["values"] as? [String: String] == ["key": "k-123"])

        let full = try json(ConnectRequestSubmit(url: "https://mcp.example.com/mcp", domain: nil, values: ["Authorization": "Bearer abc123"]))
        #expect(full.keys.sorted() == ["url", "values"])
    }
}
