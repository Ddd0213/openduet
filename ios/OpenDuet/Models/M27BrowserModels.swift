// M27 contract C (backend/src/contract/m27browser.ts): the full-screen "OpenDuet's computer" view's
// own tab strip and address bar. GET /api/computer/tabs, the answer of every tab and navigate
// action, and the stream's "browser_bar" message (ComputerServerMessage.browserBar in Computer.swift).
// Tolerant like the rest: a tab without an id is skipped, missing fields read their defaults, and a
// computer from before M27 (supported false) leaves the bar showing ComputerState.url only.
import Foundation

/// One tab. `url` "" = a blank new tab; `title` "" = none (the strip shows the domain, or "New tab").
struct BrowserTab: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var url: String
    var title: String
    var active: Bool

    init(id: String, url: String, title: String, active: Bool) {
        self.id = id
        self.url = url
        self.title = title
        self.active = active
    }

    private enum CodingKeys: String, CodingKey { case id, url, title, active }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        url = (try? c.decodeIfPresent(String.self, forKey: .url)) ?? ""
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        active = (try? c.decodeIfPresent(Bool.self, forKey: .active)) ?? false
    }
}

/// What the bar shows. `supported` false = a computer from before M27: no tab strip, the address
/// only, read-only. `browserBarInFrame` = the frames are Chrome's whole window (headed), which
/// shows its own bar: the app draws none. Tabs are in the browser's order; empty while it's asleep.
struct BrowserBar: Decodable, Hashable, Sendable {
    var supported: Bool
    var browserBarInFrame: Bool
    var tabs: [BrowserTab]
    var canGoBack: Bool
    var canGoForward: Bool

    /// Before the first answer, and what an older computer means.
    static let unsupported = BrowserBar(supported: false, browserBarInFrame: false, tabs: [], canGoBack: false, canGoForward: false)

    init(supported: Bool, browserBarInFrame: Bool, tabs: [BrowserTab], canGoBack: Bool, canGoForward: Bool) {
        self.supported = supported
        self.browserBarInFrame = browserBarInFrame
        self.tabs = tabs
        self.canGoBack = canGoBack
        self.canGoForward = canGoForward
    }

    /// The tab the assistant follows (and the address field shows), if any.
    var activeTab: BrowserTab? { tabs.first(where: \.active) }

    private enum CodingKeys: String, CodingKey { case supported, browserBarInFrame, tabs, canGoBack, canGoForward }

    /// One entry of `tabs`: a tab, or nil for one this build can't read (never throws, so the list moves on).
    private struct Entry: Decodable {
        let tab: BrowserTab?
        init(from decoder: Decoder) throws { tab = try? BrowserTab(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        supported = (try? c.decodeIfPresent(Bool.self, forKey: .supported)) ?? false
        browserBarInFrame = (try? c.decodeIfPresent(Bool.self, forKey: .browserBarInFrame)) ?? false
        canGoBack = (try? c.decodeIfPresent(Bool.self, forKey: .canGoBack)) ?? false
        canGoForward = (try? c.decodeIfPresent(Bool.self, forKey: .canGoForward)) ?? false
        tabs = ((try? c.decodeIfPresent([Entry].self, forKey: .tabs)) ?? []).compactMap(\.tab)
    }
}

/// POST /api/computer/tabs: a new tab in front. `address` = what was typed (the server reads it as
/// an address or a search); nil = the start page, and the app focuses the address field.
struct NewTabRequest: Codable, Hashable, Sendable {
    var address: String?

    private enum CodingKeys: String, CodingKey { case address }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(address, forKey: .address)
    }
}

/// POST /api/computer/navigate on the active tab: what was typed in the address field, or a button.
enum NavigateRequest: Codable, Hashable, Sendable {
    enum Action: String, Codable, Sendable { case back, forward, reload }
    case address(String)
    case action(Action)

    private enum CodingKeys: String, CodingKey { case address, action }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let address = try c.decodeIfPresent(String.self, forKey: .address) {
            self = .address(address)
        } else {
            self = .action(try c.decode(Action.self, forKey: .action))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .address(address): try c.encode(address, forKey: .address)
        case let .action(action): try c.encode(action, forKey: .action)
        }
    }
}
