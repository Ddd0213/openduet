// M11 (agent A) UI logic: the chat cards' phases (memory chip, soul proposal, connection request),
// the connection form's draft (what Connect needs, what it sends, what it forgets), the quiet
// address line, the New channel sheet's "What can OpenDuet use here?" picks, and the OpenDuet sheet's
// route by thread.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M11a card phases")
struct UIM11APhaseTests {
    @Test("memory chip: Undo reads Undone at once, a failure puts Undo back with the reason")
    func memoryNote() {
        let done = MemoryNotePhase(.done, request: nil)
        #expect(done == .done)
        #expect(done.canUndo)
        #expect(!done.readsUndone)

        let undoing = MemoryNotePhase(.done, request: .inFlight)
        #expect(undoing == .undoing)
        #expect(undoing.readsUndone, "optimistic")
        #expect(!undoing.canUndo)

        let failed = MemoryNotePhase(.done, request: .failed(reason: "Can't reach your server."))
        #expect(failed == .failed(reason: "Can't reach your server."))
        #expect(failed.canUndo)
        #expect(!failed.readsUndone)

        for request in [nil, CardRequest.inFlight, .failed(reason: "x")] {
            let undone = MemoryNotePhase(.undone, request: request)
            #expect(undone == .undone, "the server's undone wins")
            #expect(undone.readsUndone)
            #expect(!undone.canUndo)
        }
    }

    @Test("soul proposal: open, busy, failed, then decided cards fold")
    func soulProposal() {
        #expect(SoulProposalPhase(.open, request: nil) == .open)
        #expect(SoulProposalPhase(.open, request: .inFlight) == .busy)
        #expect(SoulProposalPhase(.open, request: .failed(reason: "r")) == .failed(reason: "r"))
        #expect(SoulProposalPhase(.applied, request: .inFlight) == .applied)
        #expect(SoulProposalPhase(.dismissed, request: .failed(reason: "r")) == .dismissed)
        #expect(SoulProposalPhase.applied.isDecided)
        #expect(SoulProposalPhase.dismissed.isDecided)
        #expect(!SoulProposalPhase.open.isDecided)
        #expect(!SoulProposalPhase.busy.isDecided)
        #expect(!SoulProposalPhase.failed(reason: "r").isDecided)
    }

    @Test("connection request: the card's request and an app's Composio connect both count")
    func connectionRequest() {
        #expect(ConnectionRequestPhase(.open, request: nil) == .open)
        #expect(ConnectionRequestPhase(.open, request: .inFlight) == .busy)
        #expect(ConnectionRequestPhase(.open, request: nil, connect: .inFlight) == .busy)
        #expect(ConnectionRequestPhase(.open, request: .failed(reason: "Bad key")) == .failed(reason: "Bad key"))
        #expect(ConnectionRequestPhase(.open, request: nil, connect: .failed(reason: "OAuth")) == .failed(reason: "OAuth"))
        #expect(ConnectionRequestPhase(.open, request: .failed(reason: "card"), connect: .failed(reason: "app")) == .failed(reason: "card"))
        #expect(ConnectionRequestPhase(.open, request: .failed(reason: "card"), connect: .inFlight) == .busy)
        #expect(ConnectionRequestPhase(.connected, request: .inFlight) == .connected)
        #expect(ConnectionRequestPhase(.dismissed, request: nil, connect: .inFlight) == .dismissed)

        #expect(ConnectionRequestPhase.open.showsForm)
        #expect(ConnectionRequestPhase.busy.showsForm)
        #expect(ConnectionRequestPhase.failed(reason: "r").showsForm, "a 400 keeps the card open")
        #expect(!ConnectionRequestPhase.connected.showsForm)
        #expect(!ConnectionRequestPhase.dismissed.showsForm)
    }
}

@Suite("M11a connection form")
struct UIM11AConnectionDraftTests {
    private func card(_ payload: [String: Any]) throws -> ConnectionRequestPayload {
        try #require(Fx.connectionPayload(payload))
    }

    @Test("Connect needs every field, plus the URL / domain only when the card has none")
    func canSubmit() throws {
        let apiKey = try card(Fx.apiKeyCardPayload())
        var draft = ConnectionDraft()
        #expect(!ConnectionDraft.needsDomain(apiKey))
        #expect(!ConnectionDraft.needsURL(apiKey))
        #expect(!draft.canSubmit(apiKey))
        draft.values["key"] = "   "
        #expect(!draft.canSubmit(apiKey), "whitespace isn't a key")
        draft.values["key"] = "k-123"
        #expect(draft.canSubmit(apiKey))

        let noDomain = try card(Fx.apiKeyCardPayload(domain: " "))
        #expect(ConnectionDraft.needsDomain(noDomain))
        #expect(!draft.canSubmit(noDomain))
        draft.domain = "api.example.com"
        #expect(draft.canSubmit(noDomain))

        let mcp = try card(Fx.mcpCardPayload(url: nil))
        var mcpDraft = ConnectionDraft()
        #expect(ConnectionDraft.needsURL(mcp))
        #expect(!ConnectionDraft.needsDomain(mcp))
        mcpDraft.values = ["Authorization": "Bearer abc", "X-Shop": "42"]
        #expect(!mcpDraft.canSubmit(mcp))
        mcpDraft.url = "https://mcp.example.com/mcp"
        #expect(mcpDraft.canSubmit(mcp))
        mcpDraft.values["X-Shop"] = ""
        #expect(!mcpDraft.canSubmit(mcp))

        let app = try card(Fx.appCardPayload())
        #expect(ConnectionDraft().canSubmit(app), "app cards connect through OAuth")
        #expect(!ConnectionDraft.needsURL(app))
        #expect(!ConnectionDraft.needsDomain(app))
    }

    @Test("the body trims what was typed and sends url / domain only when asked for")
    func submission() throws {
        let apiKey = try card(Fx.apiKeyCardPayload())
        var draft = ConnectionDraft(values: ["key": "  k-123\n", "stray": "x"], url: "https://ignored", domain: "ignored.com")
        #expect(draft.submission(for: apiKey) == ConnectRequestSubmit(name: nil, url: nil, domain: nil, values: ["key": "k-123"]))

        let noDomain = try card(Fx.apiKeyCardPayload(domain: nil))
        draft.domain = " api.example.com "
        #expect(draft.submission(for: noDomain).domain == "api.example.com")
        #expect(draft.submission(for: noDomain).url == nil)

        let mcp = try card(Fx.mcpCardPayload(url: nil))
        let mcpDraft = ConnectionDraft(values: ["Authorization": "Bearer abc", "X-Shop": " 42 "], url: " https://mcp.example.com/mcp ")
        let body = mcpDraft.submission(for: mcp)
        #expect(body.name == nil)
        #expect(body.url == "https://mcp.example.com/mcp")
        #expect(body.domain == nil)
        #expect(body.values == ["Authorization": "Bearer abc", "X-Shop": "42"])

        let withURL = try card(Fx.mcpCardPayload())
        #expect(mcpDraft.submission(for: withURL).url == nil, "the card's own URL isn't sent back")
    }

    @Test("Connect forgets the secrets at once; non-secret values stay for a 400")
    func dropSecrets() throws {
        let mcp = try card(Fx.mcpCardPayload())
        var draft = ConnectionDraft(values: ["Authorization": "Bearer abc", "X-Shop": "42"])
        let body = draft.submission(for: mcp)
        draft.dropSecrets(of: mcp)
        #expect(draft.values == ["X-Shop": "42"])
        #expect(draft.value("Authorization").isEmpty)
        #expect(body.values["Authorization"] == "Bearer abc", "the request still carries it once")
        #expect(!draft.canSubmit(mcp), "the secret has to be typed again")
    }

    @Test("the quiet line drops the scheme; app cards and empty addresses have none")
    func addressLine() throws {
        let cases: [([String: Any], String?)] = [
            (Fx.mcpCardPayload(), "mcp.example.com/mcp"),
            (Fx.mcpCardPayload(url: "HTTP://Local:8080"), "Local:8080"),
            (Fx.mcpCardPayload(url: nil), nil),
            (Fx.apiKeyCardPayload(), "api.openweathermap.org"),
            (Fx.apiKeyCardPayload(domain: "  "), nil),
            (Fx.appCardPayload(), nil),
        ]
        for (payload, line) in cases {
            let shown = ConnectionCardCopy.addressLine(try card(payload))
            #expect(shown == line)
        }
    }
}

@Suite("M11a New channel access")
struct UIM11AAccessTests {
    private func item(_ kind: AccessKind, _ id: String, _ scope: AccessScope) -> ChannelAccess.Item {
        ChannelAccess.Item(kind: kind, id: id, name: id, description: "", scope: scope, enabled: true)
    }

    /// The main thread's list: every item enabled, the server's order (by kind, then name).
    private var list: [ChannelAccess.Item] {
        [
            item(.skill, "skill_all", .all), item(.skill, "skill_2", .channels),
            item(.connector, "cc_1", .channels), item(.connector, "cc_all", .all),
            item(.app, "gmail", .all), item(.app, "googlecalendar", .channels),
        ]
    }

    @Test("scope all is on and locked; scope channels starts off and can be picked")
    func lockAndToggle() {
        var access = NewChannelAccess(items: list)
        let locked = list[0], pickable = list[1]
        #expect(access.isLocked(locked))
        #expect(access.isOn(locked))
        #expect(!access.isLocked(pickable))
        #expect(!access.isOn(pickable), "off by default, even though the main thread has it enabled")
        #expect(access.access.isEmpty)

        access.toggle(locked)
        #expect(access.isOn(locked), "can't be turned off here")
        #expect(access.access.isEmpty, "the server turns scope all on by itself")

        access.toggle(pickable)
        #expect(access.isOn(pickable))
        #expect(access.access == [AccessRef(kind: .skill, id: "skill_2")])
        access.toggle(pickable)
        #expect(!access.isOn(pickable))
        #expect(access.access.isEmpty)

        access.toggle(item(.skill, "skill_gone", .channels))
        #expect(access.access.isEmpty, "only listed items can be picked")
    }

    @Test("the picks go out in the list's order, whatever the tap order")
    func accessOrder() {
        var access = NewChannelAccess(items: list)
        access.toggle(list[5])
        access.toggle(list[2])
        access.toggle(list[1])
        #expect(access.access == [
            AccessRef(kind: .skill, id: "skill_2"),
            AccessRef(kind: .connector, id: "cc_1"),
            AccessRef(kind: .app, id: "googlecalendar"),
        ])
    }

    @Test("a new list keeps the picks that are still pickable")
    func reload() {
        var access = NewChannelAccess(items: list)
        access.toggle(list[1])
        access.toggle(list[2])
        // skill_2 became scope all (Share with all channels); cc_1 is still pickable.
        var next = list
        next[1].scope = .all
        access.load(next)
        #expect(access.isOn(next[1]))
        #expect(access.isLocked(next[1]))
        #expect(access.access == [AccessRef(kind: .connector, id: "cc_1")])
        // cc_1 deleted.
        access.load(next.filter { $0.id != "cc_1" })
        #expect(access.access.isEmpty)
        // It comes back: not picked again by itself.
        access.load(next)
        #expect(access.access.isEmpty)
    }

    @Test("sections: skills, custom connectors, apps; empty kinds left out")
    func sections() {
        let access = NewChannelAccess(items: list)
        #expect(access.sections.map(\.kind) == [.skill, .connector, .app])
        #expect(access.sections.map { $0.items.map(\.id) } == [["skill_all", "skill_2"], ["cc_1", "cc_all"], ["gmail", "googlecalendar"]])
        #expect(!access.isEmpty)

        let appsOnly = NewChannelAccess(items: list.filter { $0.kind == .app })
        #expect(appsOnly.sections.map(\.kind) == [.app])
        #expect(NewChannelAccess().sections.isEmpty)
        #expect(NewChannelAccess().isEmpty)
    }
}

@Suite("M11a OpenDuet sheet route")
struct UIM11AAssistantRouteTests {
    @Test("the main thread opens Everything; a channel opens its own sheet")
    func route() {
        let shop = Fx.decode(Channel.self, Fx.channel("ch_shop"))
        var menu = MenuState(channels: [shop])
        #expect(AssistantSheetRoute(menu: menu) == .everything)
        menu.selectedChannelId = "ch_shop"
        #expect(AssistantSheetRoute(menu: menu) == .channel(shop))
        menu.selectedChannelId = "ch_gone"
        #expect(AssistantSheetRoute(menu: menu) == .everything, "a channel that isn't listed falls back to Everything")
    }
}
