// M29 fixes: a channel link's message older than the newest page is looked for on older pages
// (RouteFocus.step, at most maxOlderPages; task links as before), and a form / connection request
// card's optional `closedBy` ("assistant" = the assistant withdrew it; missing, null, "user" or
// anything unknown = the user's Skip / Not now) never fails the card.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M29 deep link paging")
struct DataM29RouteFocusTests {
    private let page = [Fx.message("m30", at: 30), Fx.message("m31", at: 31)]

    @Test("The message on the loaded pages: found, whatever is before")
    func found() {
        let focus = RouteFocus(target: .channel(Fx.main), messageId: "m31")
        #expect(focus.step(page, hasMoreBefore: true) == .found)
        #expect(focus.step(page, hasMoreBefore: false) == .found)
    }

    @Test("A channel link pages back while there is more before, up to maxOlderPages")
    func pagesBack() {
        var focus = RouteFocus(target: .channel(Fx.main), messageId: "m3")
        #expect(focus.step(page, hasMoreBefore: true) == .loadOlder)
        #expect(focus.step(page, hasMoreBefore: false) == .giveUp, "the oldest page is loaded: open at the bottom")
        focus.olderPages = RouteFocus.maxOlderPages - 1
        #expect(focus.step(page, hasMoreBefore: true) == .loadOlder)
        focus.olderPages = RouteFocus.maxOlderPages
        #expect(focus.step(page, hasMoreBefore: true) == .giveUp, "10 older pages without it: open at the bottom")
        #expect(RouteFocus.maxOlderPages == 10)
    }

    @Test("A task link only looks at its newest page, as before")
    func taskAsBefore() {
        let focus = RouteFocus(target: .task("t_1"), messageId: "m3")
        #expect(focus.step(page, hasMoreBefore: true) == .giveUp)
        #expect(RouteFocus(target: .task("t_1"), messageId: "m30").step(page, hasMoreBefore: true) == .found)
    }

    @Test("Counting pages doesn't change what the thread is told to scroll to")
    func focusUnchanged() {
        let token = UUID()
        var focus = RouteFocus(target: .channel("ch_1"), messageId: "m1", token: token)
        let before = focus.thread(channelId: "ch_1")
        focus.olderPages = 4
        #expect(focus.thread(channelId: "ch_1") == before)
        #expect(RouteFocus(URL(string: "duet://channels/ch_1?message=m1")!)?.olderPages == 0)
    }
}

@Suite("M29 closedBy on form and connection request cards")
struct DataM29ClosedByTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.decoder().decode(T.self, from: Data(json.utf8))
    }

    /// A dismissed form card's payload with `extra` before the closing brace.
    private func form(_ extra: String) -> String {
        #"{"title":"Launch checklist","description":null,"icon":"chat","fields":[{"id":"f_1","type":"text","label":"Notes","required":false,"placeholder":null,"multiline":false}],"submitLabel":null,"state":"dismissed","answers":null\#(extra)}"#
    }

    private func connection(_ extra: String, state: String = "dismissed") -> String {
        #"{"type":"app","name":"Google Calendar","purpose":"To add the launch dates.","url":null,"domain":null,"toolkit":"googlecalendar","headerName":null,"valuePrefix":null,"fields":[],"state":"\#(state)","connectorId":null\#(extra)}"#
    }

    @Test("Form: \"assistant\" is withdrawn; missing, null, \"user\" and unknown values are the user's")
    func formValues() throws {
        let withdrawn = try decode(FormPayload.self, form(#","closedBy":"assistant""#))
        #expect(withdrawn.closedBy == .assistant)
        #expect(withdrawn.isWithdrawn)
        let missing = try decode(FormPayload.self, form(""))
        #expect(missing.closedBy == nil, "cards stored before M29")
        #expect(!missing.isWithdrawn)
        #expect(try decode(FormPayload.self, form(#","closedBy":null"#)).closedBy == nil)
        #expect(try decode(FormPayload.self, form(#","closedBy":"user""#)).closedBy == .user)
        let unknown = try decode(FormPayload.self, form(#","closedBy":"system""#))
        #expect(unknown.closedBy == .user, "a newer value reads as the user's")
        #expect(!unknown.isWithdrawn)
        #expect(try decode(FormPayload.self, form(#","closedBy":7"#)).closedBy == .user, "a wrong type doesn't fail the card")
    }

    @Test("Connection request: the same reading; only a dismissed card is withdrawn")
    func connectionValues() throws {
        let withdrawn = try decode(ConnectionRequestPayload.self, connection(#","closedBy":"assistant""#))
        #expect(withdrawn.closedBy == .assistant && withdrawn.isWithdrawn)
        #expect(try decode(ConnectionRequestPayload.self, connection("")).isWithdrawn == false)
        #expect(try decode(ConnectionRequestPayload.self, connection(#","closedBy":"bot""#)).closedBy == .user)
        let open = try decode(ConnectionRequestPayload.self, connection(#","closedBy":"assistant""#, state: "open"))
        #expect(!open.isWithdrawn)
    }

    @Test("A whole form message from the stream carries closedBy")
    func messageDecodes() throws {
        let raw = form(#","closedBy":"assistant""#)
        let json = #"{"id":"msg_f","channelId":"ch_1","taskId":null,"role":"assistant","kind":"form","text":"A few questions:","status":"sent","clientId":null,"reactions":[],"createdAt":"2026-10-31T08:00:00.000Z","updatedAt":"2026-10-31T08:05:00.000Z","payload":\#(raw)}"#
        let message = try decode(Message.self, json)
        guard case .form(let payload) = message.content else { Issue.record("not a form"); return }
        #expect(payload.state == .dismissed)
        #expect(payload.isWithdrawn)
    }
}
