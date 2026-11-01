// M27 contract C: the full-screen view's own tab strip and address bar. BrowserBar (GET
// /api/computer/tabs, every tab and navigate answer, the stream's browser_bar message) decodes
// tolerantly: a tab it can't read is skipped, missing fields read their defaults, and a computer
// from before M27 (supported false, or a shape with nothing in it) leaves only the address. The
// two requests encode exactly what the server takes (strict on its side).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M27 browser contract")
struct DataM27BrowserContractTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.decoder().decode(T.self, from: Data(json.utf8))
    }

    private func object<T: Encodable>(_ value: T) throws -> NSDictionary {
        let data = try JSONCoding.encoder().encode(value)
        return try #require(try JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    private let bar = #"""
    {"supported":true,"browserBarInFrame":false,
     "tabs":[{"id":"T1","url":"https://www.npmjs.com/package/zod","title":"zod - npm","active":false},
             {"id":"T2","url":"https://www.bing.com/search?q=ramen","title":"ramen - Search","active":true},
             {"id":"T3","url":"","title":"","active":false}],
     "canGoBack":true,"canGoForward":false}
    """#

    @Test("A bar decodes in the browser's order; activeTab is the one OpenDuet follows")
    func fullBar() throws {
        let value = try decode(BrowserBar.self, bar)
        #expect(value.supported && !value.browserBarInFrame && value.canGoBack && !value.canGoForward)
        #expect(value.tabs.map(\.id) == ["T1", "T2", "T3"])
        #expect(value.activeTab?.id == "T2" && value.activeTab?.url == "https://www.bing.com/search?q=ramen")
        #expect(value.tabs[2] == BrowserTab(id: "T3", url: "", title: "", active: false))
    }

    @Test("A tab without an id or of the wrong type is skipped; a tab's missing fields read empty / false")
    func tolerantTabs() throws {
        let json = #"""
        {"supported":true,"tabs":[{"url":"https://a.example/","title":"no id","active":true},
                                   "not a tab",
                                   {"id":"T9"},
                                   {"id":"T8","url":7,"title":null,"active":"yes"}],
         "canGoBack":false,"canGoForward":true}
        """#
        let value = try decode(BrowserBar.self, json)
        #expect(value.tabs == [BrowserTab(id: "T9", url: "", title: "", active: false),
                               BrowserTab(id: "T8", url: "", title: "", active: false)])
        #expect(value.activeTab == nil && value.canGoForward && !value.browserBarInFrame)
    }

    @Test("An older computer (supported false) and an empty or odd shape read as no tab strip")
    func unsupported() throws {
        let older = try decode(BrowserBar.self, #"{"supported":false,"browserBarInFrame":false,"tabs":[],"canGoBack":false,"canGoForward":false}"#)
        #expect(older == .unsupported)
        #expect(try decode(BrowserBar.self, "{}") == .unsupported)
        let odd = try decode(BrowserBar.self, #"{"supported":"yes","tabs":{"id":"T1"},"canGoBack":"yes"}"#)
        #expect(odd == .unsupported && odd.activeTab == nil)
    }

    @Test("Headed (window) mode: browserBarInFrame true, the app draws no bar of its own")
    func barInFrame() throws {
        let value = try decode(BrowserBar.self, #"{"supported":true,"browserBarInFrame":true,"tabs":[{"id":"B1","url":"https://example.com/","title":"Example Domain","active":true}],"canGoBack":false,"canGoForward":false}"#)
        #expect(value.browserBarInFrame && value.activeTab?.title == "Example Domain")
    }

    @Test("The stream's browser_bar message decodes; frame_meta and state as before; an unknown type still throws")
    func streamMessage() throws {
        let message = try decode(ComputerServerMessage.self, #"{"type":"browser_bar","bar":\#(bar)}"#)
        guard case let .browserBar(value) = message else {
            Issue.record("expected browserBar, got \(message)")
            return
        }
        #expect(value.tabs.count == 3 && value.activeTab?.id == "T2")
        #expect(try decode(ComputerServerMessage.self, #"{"type":"frame_meta","width":430,"height":660}"#) == .frameMeta(width: 430, height: 660))
        #expect(throws: (any Error).self) { try decode(ComputerServerMessage.self, #"{"type":"tab_favicon","bar":{}}"#) }
    }

    @Test("POST /api/computer/tabs: {} for the start page, {address} for what was typed")
    func newTab() throws {
        #expect(try object(NewTabRequest(address: nil)) == [:] as NSDictionary)
        #expect(try object(NewTabRequest(address: "weather in paris")) == ["address": "weather in paris"] as NSDictionary)
        #expect(try decode(NewTabRequest.self, "{}").address == nil)
        #expect(try decode(NewTabRequest.self, #"{"address":"news.ycombinator.com"}"#).address == "news.ycombinator.com")
    }

    @Test("POST /api/computer/navigate: exactly one of address or action")
    func navigate() throws {
        #expect(try object(NavigateRequest.address("example.com")) == ["address": "example.com"] as NSDictionary)
        for action in [NavigateRequest.Action.back, .forward, .reload] {
            #expect(try object(NavigateRequest.action(action)) == ["action": action.rawValue] as NSDictionary)
            #expect(try decode(NavigateRequest.self, #"{"action":"\#(action.rawValue)"}"#) == .action(action))
        }
        #expect(try decode(NavigateRequest.self, #"{"address":"github.com"}"#) == .address("github.com"))
        #expect(throws: (any Error).self) { try decode(NavigateRequest.self, #"{"action":"stop"}"#) }
        #expect(throws: (any Error).self) { try decode(NavigateRequest.self, "{}") }
    }

    @Test("The refusal codes come through as plain strings")
    func refusals() throws {
        for code in ["take_over_first", "tabs_unsupported"] {
            let body = try decode(ApiErrorBody.self, #"{"error":{"code":"\#(code)","message":"m"}}"#)
            #expect(body.error.code == code && body.error.field == nil)
        }
    }
}
