// M27 W6: the full-screen "OpenDuet's computer" view's own tab strip and address bar
// (Computer/BrowserBarRules.swift). Page titles and URLs are hostile: cleaned and cut by grapheme,
// the address field shows only a parsed http(s) host cut from the left, never a raw string; the
// bar is read-only while OpenDuet drives; refusals by code; the request shapes; at most 50 tabs and
// valid ids; a GET answer older than a stream message is dropped.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private func tab(_ id: String, _ url: String, _ title: String = "", active: Bool = false) -> BrowserTab {
    BrowserTab(id: id, url: url, title: title, active: active)
}

private func bar(_ tabs: [BrowserTab], back: Bool = false, forward: Bool = false, supported: Bool = true, inFrame: Bool = false) -> BrowserBar {
    BrowserBar(supported: supported, browserBarInFrame: inFrame, tabs: tabs, canGoBack: back, canGoForward: forward)
}

private func view(_ bar: BrowserBar, user: Bool, known: Bool = true, browser: ComputerState.Browser = .ready, url: String? = nil, domain: String? = nil) -> ComputerViewState {
    var state = ComputerViewState()
    state.computer = ComputerState(available: true, browser: browser, controller: user ? .user : .assistant, url: url, domain: domain, blocked: nil)
    state.phase = .loaded
    state.bar = bar
    state.barKnown = known
    return state
}

@Suite("M27 W6 page strings")
struct UIM27BrowserPageStringTests {
    @Test("Controls, bidi overrides and isolates, zero-width marks and the BOM go; whitespace collapses")
    func cleaning() {
        #expect(BrowserBarRules.clean("\u{202E}gnp.exe\u{0007}\n\r  Report") == "gnp.exe Report")
        #expect(BrowserBarRules.clean("a\u{200B}b\u{200E}c\u{2066}d\u{2069}e\u{FEFF}f\u{0085}g") == "abcdef g")
        #expect(BrowserBarRules.clean("  \t\u{2028}Inbox\u{00A0}\u{00A0}(3)\u{2029} ") == "Inbox (3)")
        #expect(BrowserBarRules.clean("\u{0001}\u{009F}\u{061C}\u{2060}") == "")
        // RTL text stays as it is (only the controls that reorder go)
        #expect(BrowserBarRules.clean("مرحبا بالعالم") == "مرحبا بالعالم")
        #expect(BrowserBarRules.clean("שלום \u{202B}עולם\u{202C}") == "שלום עולם")
    }

    @Test("Cut by grapheme with a trailing …: never inside an emoji or a combining sequence")
    func cutting() {
        let long = String(repeating: "a", count: 59) + "👨‍👩‍👧" + "tail"
        let cut = BrowserBarRules.displayTitle(long)
        #expect(cut.count == 60 && cut.hasSuffix("…"))
        #expect(cut == String(repeating: "a", count: 59) + "…")
        // a skin-toned emoji (2 scalars, 1 grapheme) is kept whole when it fits
        let kept = BrowserBarRules.displayTitle(String(repeating: "a", count: 58) + "👍🏽" + "tail")
        #expect(kept == String(repeating: "a", count: 58) + "👍🏽" + "…")
        // U+200D is in the dropped range (recheck point 3), so a ZWJ family shows as its people
        #expect(BrowserBarRules.clean("👨‍👩‍👧") == "👨👩👧")
        let flags = String(repeating: "🇫🇷", count: 70)
        let shown = BrowserBarRules.displayTitle(flags)
        #expect(shown.count == 60)
        #expect(shown.dropLast().allSatisfy { $0 == "🇫🇷" })
        #expect(BrowserBarRules.displayTitle("e\u{301}") == "e\u{301}")
        #expect(BrowserBarRules.cut("word   " + String(repeating: "b", count: 80), to: 8) == "word…")
        #expect(BrowserBarRules.displayTitle("short") == "short")
    }

    @Test("A title with a lone \\ud83d never shows half a pair: the title is dropped and the tab shows its domain")
    func loneSurrogate() throws {
        // The tolerant BrowserTab reads a title that won't decode as "" (the rest of the tab stays).
        let broken = #"{"type":"browser_bar","bar":{"supported":true,"tabs":[{"id":"T1","url":"https://a.example/","title":"x\ud83d","active":true}]}}"#
        let kept = try JSONCoding.decoder().decode(ComputerServerMessage.self, from: Data(broken.utf8))
        guard case .browserBar(let lone) = kept else { Issue.record("not a bar"); return }
        #expect(lone.tabs.count == 1 && lone.tabs[0].title.isEmpty)
        #expect(BrowserBarRules.tabName(lone.tabs[0]) == .domain("a.example"))
        // A browser_bar message that doesn't decode at all is skipped by ComputerStream (the
        // last good bar stays).
        let garbled = #"{"type":"browser_bar","bar":"x\ud83d"}"#
        #expect((try? JSONCoding.decoder().decode(ComputerServerMessage.self, from: Data(garbled.utf8))) == nil)
        let paired = #"{"type":"browser_bar","bar":{"supported":true,"tabs":[{"id":"T1","url":"https://a.example/","title":"x\ud83d\ude00","active":true}]}}"#
        let message = try JSONCoding.decoder().decode(ComputerServerMessage.self, from: Data(paired.utf8))
        guard case .browserBar(let decoded) = message else { Issue.record("not a bar"); return }
        #expect(decoded.tabs.first?.title == "x😀")
        #expect(BrowserBarRules.displayTitle(decoded.tabs[0].title) == "x😀")
    }

    @Test("The tab's name: the cleaned title, else the domain, else New tab; no title for non-web pages")
    func tabNames() {
        #expect(BrowserBarRules.tabName(tab("T", "https://www.npmjs.com/package/zod", "zod - npm")) == .title("zod - npm"))
        #expect(BrowserBarRules.tabName(tab("T", "https://www.npmjs.com/package/zod", " \u{200B}\n")) == .domain("npmjs.com"))
        #expect(BrowserBarRules.tabName(tab("T", "http://shop.example.invalid/", "")) == .domain("shop.example.invalid"))
        #expect(BrowserBarRules.tabName(tab("T", "", "")) == .newTab)
        #expect(BrowserBarRules.tabName(tab("T", "about:blank", "about:blank")) == .newTab)
        #expect(BrowserBarRules.tabName(tab("T", "javascript:alert(1)", "https://bank.example")) == .newTab)
        #expect(BrowserBarRules.tabName(tab("T", "not a url", "Title")) == .newTab)
        #expect(BrowserBarRules.tabItems(bar([])) == [BrowserBarRules.TabItem(id: BrowserBarRules.placeholderId, name: .newTab, active: true, placeholder: true)])
    }
}

@Suite("M27 W6 address field")
struct UIM27BrowserAddressTests {
    @Test("The shown host: no scheme, user name, password, port, path or query; punycode kept")
    func shownHost() {
        #expect(BrowserBarRules.shownHost("https://user:pass@www.Example.com:8443/a/b?q=secret#x") == "www.example.com")
        #expect(BrowserBarRules.shownHost("https://bank.com@evil.com/login") == "evil.com")
        #expect(BrowserBarRules.shownHost("https://xn--80ak6aa92e.com/") == "xn--80ak6aa92e.com")
        // a Unicode host is shown as its punycode, never as the look-alike letters
        #expect(BrowserBarRules.shownHost("https://аррӏе.com/") == "xn--80ak6aa92e.com")
        #expect(BrowserBarRules.shownHost("http://192.168.0.1/x") == "192.168.0.1")
        #expect(BrowserBarRules.shownHost("https://[::1]:8080/") == "[::1]")
    }

    @Test("Non-web pages and junk show an empty field, never the raw string")
    func emptyField() {
        for url in ["", "about:blank", "javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd",
                    "chrome://settings", "https://", "https:alert(1)", "ht tp://x", "not a url", "https://%41.com/"] {
            #expect(BrowserBarRules.shownHost(url) == "", "\(url)")
            #expect(BrowserBarRules.editText(url) == "", "\(url)")
        }
    }

    @Test("A long host is cut from the left, so the registrable domain stays")
    func cutFromTheLeft() {
        let host = String(repeating: "secure.", count: 6) + "paypal.com.account-verify.evil.example"
        let shown = BrowserBarRules.shownHost("https://\(host)/")
        #expect(shown.count <= BrowserBarRules.hostLimit)
        #expect(shown.hasPrefix("…"))
        #expect(shown.hasSuffix("paypal.com.account-verify.evil.example"))
        #expect(BrowserBarRules.shortenHost("a.b.c.secure.paypal.com.evil.example", limit: 31) == "…secure.paypal.com.evil.example")
        #expect(BrowserBarRules.shortenHost("a.b.c.secure.paypal.com.evil.example", limit: 30) == "…paypal.com.evil.example")
        // one huge label: the last characters, still the real end
        let label = String(repeating: "x", count: 80) + ".example"
        #expect(BrowserBarRules.shortenHost(label).hasSuffix("xxx.example"))
        #expect(BrowserBarRules.shortenHost(label).count == BrowserBarRules.hostLimit)
        #expect(BrowserBarRules.shortenHost("short.example") == "short.example")
    }

    @Test("Editing fills the full URL without the user name and password")
    func editText() {
        #expect(BrowserBarRules.editText("https://www.bing.com/search?q=ramen%20near%20me") == "https://www.bing.com/search?q=ramen%20near%20me")
        #expect(BrowserBarRules.editText("https://user:pass@evil.example/x?y=1") == "https://evil.example/x?y=1")
    }

    @Test("Go sends what was typed, trimmed; empty sends nothing; with no tab it opens one")
    func submit() {
        #expect(BrowserBarAction.submit("  weather in paris \n", hasTab: true) == .navigate(.address("weather in paris")))
        #expect(BrowserBarAction.submit("example.com", hasTab: false) == .newTab(address: "example.com"))
        #expect(BrowserBarAction.submit("   ", hasTab: true) == nil)
        // never turned into a URL or a search URL by the app
        #expect(BrowserBarAction.submit("file:///etc", hasTab: true) == .navigate(.address("file:///etc")))
    }

    @Test("Editing: the draft, the selection, Go, and an address refusal putting the text back")
    func editing() {
        var editing = BrowserAddressEditing()
        editing.begin(text: "https://a.example/")
        #expect(editing.isEditing && editing.selectAll && editing.session == 1)
        editing.draft = "  file:///etc "
        #expect(editing.submit() == "file:///etc")
        #expect(!editing.isEditing && editing.draft.isEmpty)
        editing.refused()
        #expect(editing.isEditing && editing.draft == "file:///etc" && !editing.selectAll && editing.session == 2)
        editing.cancel()
        #expect(!editing.isEditing && editing.draft.isEmpty)
        editing.answered()
        editing.refused()
        #expect(!editing.isEditing)
        editing.begin(text: "")
        #expect(editing.submit() == nil)
    }
}

@Suite("M27 W6 bar states")
struct UIM27BrowserBarStateTests {
    private let tabs = [tab("T1", "https://www.npmjs.com/package/zod", "zod - npm"),
                        tab("T2", "https://www.bing.com/search?q=ramen", "ramen - Search", active: true)]

    @Test("While OpenDuet drives: tabs, titles and the host follow OpenDuet; nothing is usable")
    func readOnly() {
        let model = BrowserBarRules.model(view(bar(tabs, back: true, forward: true), user: false), resting: false)
        #expect(model.presence == .live && model.layout == .tabs)
        #expect(model.tabs.map(\.id) == ["T1", "T2"] && model.activeId == "T2")
        #expect(model.host == "www.bing.com")
        #expect(model.controls == BrowserBarRules.Controls())
    }

    @Test("After Take over: switch, close, + and ↻; ← → follow canGoBack / canGoForward")
    func takenOver() {
        let model = BrowserBarRules.model(view(bar(tabs, back: true, forward: false), user: true), resting: false)
        #expect(model.controls == BrowserBarRules.Controls(
            interactive: true, canSwitch: true, canClose: true, canAdd: true,
            canGoBack: true, canGoForward: false, canReload: true, canEdit: true
        ))
        #expect(model.editText == "https://www.bing.com/search?q=ramen")
        // no tabs yet: one placeholder "New tab", + still works, nothing to close or reload
        let empty = BrowserBarRules.model(view(bar([]), user: true), resting: false)
        #expect(empty.tabs.count == 1 && empty.tabs[0].placeholder && empty.host.isEmpty && empty.showsPlaceholder)
        #expect(empty.controls.canAdd && !empty.controls.canClose && !empty.controls.canReload)
    }

    @Test("An older computer: one read-only address row with ComputerState.url's host")
    func olderComputer() {
        let older = view(bar([], supported: false), user: true, url: "https://user:pw@shop.example.invalid/a?b=1", domain: "shop.example.invalid")
        let model = BrowserBarRules.model(older, resting: false)
        #expect(model.layout == .addressOnly)
        #expect(model.host == "shop.example.invalid")
        #expect(model.controls == BrowserBarRules.Controls())
        #expect(!model.showsPlaceholder)
        // before the first answer the full-height skeleton shows, not the older row
        #expect(BrowserBarRules.model(view(bar([], supported: false), user: false, known: false), resting: false).layout == .tabs)
    }

    @Test("When the bar shows: skeleton while loading or waking, dimmed asleep, hidden for headed or no computer")
    func presence() {
        #expect(BrowserBarRules.presence(ComputerViewState(), resting: false) == .skeleton)
        #expect(BrowserBarRules.presence(view(bar(tabs), user: false, browser: .starting), resting: false) == .skeleton)
        #expect(BrowserBarRules.presence(view(bar(tabs), user: false, browser: .off), resting: true) == .dimmed)
        #expect(BrowserBarRules.presence(view(bar(tabs), user: false), resting: true) == .dimmed)
        #expect(BrowserBarRules.presence(view(bar(tabs), user: false, known: false), resting: false) == .skeleton)
        #expect(BrowserBarRules.presence(view(bar(tabs, inFrame: true), user: false), resting: false) == .hidden)
        var off = ComputerViewState()
        off.mode = .off
        #expect(BrowserBarRules.presence(off, resting: false) == .hidden)
        var failed = ComputerViewState()
        failed.phase = .failed(reason: "x")
        #expect(BrowserBarRules.presence(failed, resting: false) == .hidden)
        // asleep and dimmed: nothing usable even after Take over
        #expect(BrowserBarRules.model(view(bar(tabs), user: true), resting: true).controls == BrowserBarRules.Controls())
    }
}

@Suite("M27 W6 refusals and requests")
struct UIM27BrowserRefusalTests {
    private func error(_ status: Int, _ code: String, _ message: String = "", field: String? = nil) -> APIError {
        var detail: [String: String] = ["code": code, "message": message]
        if let field { detail["field"] = field }
        let body = try? JSONSerialization.data(withJSONObject: ["error": detail])
        return APIError(status: status, body: body ?? Data())
    }

    @Test("The refusal line by code; the server's English is never shown")
    func byCode() {
        typealias R = BrowserBarRules
        #expect(R.outcome(of: error(409, "take_over_first")) == .refused(.takeOverFirst))
        #expect(R.outcome(of: error(501, "tabs_unsupported")) == .refused(.needsUpdate))
        #expect(R.outcome(of: error(400, "validation_failed", "address: only web addresses (http or https) can be opened", field: "address")) == .refused(.notAWebAddress))
        #expect(R.outcome(of: error(400, "validation_failed", "address: not a web address", field: "address")) == .refused(.notAWebAddress))
        #expect(R.outcome(of: error(400, "validation_failed", "address: addresses with a user name or password can't be opened", field: "address")) == .refused(.credentials))
        #expect(R.outcome(of: error(400, "validation_failed", "address: too long to search for", field: "address")) == .refused(.searchTooLong))
        #expect(R.outcome(of: error(400, "validation_failed", "address: too long", field: "address")) == .refused(.addressTooLong))
        #expect(R.outcome(of: error(409, "conflict", "At most 20 tabs can be open. Close one first."), newTab: true) == .refused(.tooManyTabs))
        #expect(R.outcome(of: error(429, "rate_limited")) == .refused(.tooFast))
        #expect(R.outcome(of: error(404, "not_found")) == .refetch)
        #expect(R.outcome(of: CancellationError()) == .none)
        #expect(R.outcome(of: APIError.invalidResponse) == .none)
        #expect(R.outcome(of: APIError.unreachable) == .refused(.other(APIError.unreachable.localizedReason)))
        #expect(R.outcome(of: error(502, "internal")) == .refused(.other(String(localized: "Something went wrong."))))
        // only address refusals keep the typed text and the focus
        #expect(R.Refusal.credentials.keepsAddress && R.Refusal.addressTooLong.keepsAddress && !R.Refusal.tooManyTabs.keepsAddress)
    }

    @Test("The lines the user reads")
    func messages() {
        #expect(BrowserBarRules.Refusal.takeOverFirst.message == "Take over to use the browser.")
        #expect(BrowserBarRules.Refusal.needsUpdate.message == "OpenDuet's computer needs an update for tabs.")
        #expect(BrowserBarRules.Refusal.notAWebAddress.message == "That isn't a web address.")
        #expect(BrowserBarRules.Refusal.credentials.message == "Addresses with a user name or password can't be opened.")
        #expect(BrowserBarRules.Refusal.searchTooLong.message == "That's too long to search for.")
        #expect(BrowserBarRules.Refusal.addressTooLong.message == "That address is too long.")
        #expect(BrowserBarRules.Refusal.tooManyTabs.message == "Close a tab first. At most 20 can be open.")
        #expect(BrowserBarRules.Refusal.tooFast.message == "Too many actions. Wait a moment.")
        #expect(error(409, "take_over_first").localizedReason == "Take over to use the browser.")
        #expect(error(501, "tabs_unsupported").localizedReason == "OpenDuet's computer needs an update for tabs.")
    }

    @Test("Request shapes: {} for +, {address}, {action}, the tab id as one path segment")
    func shapes() throws {
        func json(_ action: BrowserBarAction) throws -> String {
            switch action.body {
            case .none: return ""
            case .newTab(let body): return String(decoding: try JSONCoding.encoder().encode(body), as: UTF8.self)
            case .navigate(let body): return String(decoding: try JSONCoding.encoder().encode(body), as: UTF8.self)
            }
        }
        #expect(BrowserBarAction.newTab(address: nil).path == "/api/computer/tabs")
        #expect(try json(.newTab(address: nil)) == "{}")
        #expect(try json(.newTab(address: "weather in paris")) == #"{"address":"weather in paris"}"#)
        #expect(try json(.navigate(.address("example.com"))) == #"{"address":"example.com"}"#)
        #expect(try json(.navigate(.action(.reload))) == #"{"action":"reload"}"#)
        #expect(BrowserBarAction.activate(tabId: "F679780A12B34C5D").path == "/api/computer/tabs/F679780A12B34C5D/activate")
        #expect(BrowserBarAction.close(tabId: "a/b?c#d e").path == "/api/computer/tabs/a%2Fb%3Fc%23d%20e/close")
        #expect(BrowserBarAction.navigate(.action(.back)).path == "/api/computer/navigate")
        #expect(BrowserBarAction.activate(tabId: "T").body == .none)
        #expect(BrowserBarAction.newTab(address: nil).isBlankNewTab && !BrowserBarAction.newTab(address: "x").isBlankNewTab)
    }
}

@Suite("M27 W6 bar feed")
struct UIM27BrowserFeedTests {
    @Test("At most 50 tabs (the active one kept), valid distinct ids, one active")
    func sanitizing() {
        var many = (0..<60).map { tab("T\($0)", "https://e\($0).example/") }
        many[55].active = true
        let kept = BrowserBarRules.sanitized(bar(many))
        #expect(kept.tabs.count == 50)
        #expect(kept.tabs.last?.id == "T55" && kept.activeTab?.id == "T55")
        let odd = [tab("", "https://a.example/"), tab("a/b", "https://a.example/"), tab("a b", "https://a.example/"),
                   tab(String(repeating: "x", count: 201), "https://a.example/"), tab("é", "https://a.example/"),
                   tab("ok_1-A", "https://a.example/", active: true), tab("ok_1-A", "https://dup.example/"),
                   tab("two", "https://b.example/", active: true), tab(String(repeating: "y", count: 200), "")]
        let clean = BrowserBarRules.sanitized(bar(odd))
        #expect(clean.tabs.map(\.id) == ["ok_1-A", "two", String(repeating: "y", count: 200)])
        #expect(clean.tabs.filter(\.active).map(\.id) == ["ok_1-A"])
    }

    @Test("A GET answer that arrives after a stream message (or a POST answer) is dropped")
    func staleGet() {
        var feed = BrowserBarFeed()
        let early = feed.ticket()
        feed.noteNewer()
        let lateAnswer = feed.accept(early)
        #expect(!lateAnswer)
        #expect(feed.droppedFetches == 1)
        let fresh = feed.ticket()
        let freshAnswer = feed.accept(fresh)
        #expect(freshAnswer)
        // once accepted it counts as the newest: the same answer can't land twice
        let again = feed.accept(fresh)
        #expect(!again)
        #expect(feed.droppedFetches == 2)
    }

    @Test("One action at a time; repeats are dropped, the others wait their turn")
    func queue() {
        var queue = BrowserBarQueue()
        let reload = BrowserBarAction.navigate(.action(.reload))
        let first = queue.enqueue(reload)
        let running = queue.next()
        let repeated = queue.enqueue(reload)
        let tab = queue.enqueue(.activate(tabId: "T1"))
        let tabTwice = queue.enqueue(.activate(tabId: "T1"))
        let plus = queue.enqueue(.newTab(address: nil))
        let whileRunning = queue.next()
        #expect(first && running == reload && !repeated && tab && !tabTwice && plus && whileRunning == nil)
        queue.finish()
        let second = queue.next()
        #expect(second == .activate(tabId: "T1"))
        queue.finish()
        queue.dropWaiting()
        let none = queue.next()
        #expect(none == nil)
        for index in 0..<10 { queue.enqueue(.close(tabId: "T\(index)")) }
        #expect(queue.waiting.count == BrowserBarQueue.maxWaiting)
    }
}
