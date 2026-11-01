// M27 W6: the pure rules of the full-screen "OpenDuet's computer" view's own tab strip and address
// bar (docs/API.md "## M27 browser"; the security recheck's W6 points 1-10). Pure Foundation, so
// the host tests compile it.
//
// Titles and URLs come from whatever page the assistant or the user opened: they are hostile even after
// the server cleaned them. This file cleans and cuts them for display (controls, zero-width,
// direction marks, overrides and isolates and the BOM dropped, whitespace collapsed, cut by
// grapheme with a trailing …), shows only the host of a parsed http(s) URL in the address field
// (cut from the left so the registrable domain stays; punycode as it is), never a raw string,
// and drops tabs past 50 and ids the contract can't have. The views draw these strings as plain
// text only (Text(verbatim:)), with no link detection and no selection.
import Foundation

enum BrowserBarRules {
    /// About 60 graphemes for a tab title, about 64 characters for the shown host (recheck point 3).
    static let titleLimit = 60
    static let hostLimit = 64
    /// The contract's caps (recheck point 9).
    static let maxTabs = 50
    static let maxIdLength = 200

    // MARK: - Cleaning page strings

    /// Plain one-line text: C0 / C1 controls, U+200B-U+200F, U+202A-U+202E, U+2066-U+2069 and
    /// U+FEFF dropped (plus U+061C, the Arabic letter mark, and U+2060-U+2064, invisible joiners,
    /// which do the same jobs); every run of whitespace (tabs and line breaks included) becomes one
    /// space, trimmed at both ends. A lone surrogate can't reach a Swift String (JSON decoding
    /// fails, or it is U+FFFD), so nothing is left half.
    static func clean(_ raw: String) -> String {
        var out = String.UnicodeScalarView()
        var pendingSpace = false
        for scalar in raw.unicodeScalars {
            if scalar.properties.isWhitespace {
                pendingSpace = !out.isEmpty
                continue
            }
            if isHidden(scalar) { continue }
            if pendingSpace {
                out.append(" ")
                pendingSpace = false
            }
            out.append(scalar)
        }
        return String(out)
    }

    /// What a page could use to hide or reorder text.
    static func isHidden(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x0000...0x001F, 0x007F...0x009F: true
        case 0x200B...0x200F, 0x202A...0x202E, 0x2066...0x2069, 0xFEFF: true
        case 0x061C, 0x2060...0x2064: true
        default: false
        }
    }

    /// Cut by grapheme (never inside an emoji or a combining sequence), with a trailing "…".
    static func cut(_ text: String, to limit: Int) -> String {
        guard limit > 1, text.count > limit else { return text }
        var head = String(text.prefix(limit - 1))
        while head.last?.isWhitespace == true { head.removeLast() }
        return head + "…"
    }

    /// The cleaned and cut title, "" when nothing is left.
    static func displayTitle(_ raw: String) -> String {
        cut(clean(raw), to: titleLimit)
    }

    // MARK: - The tab's name

    enum TabName: Hashable, Sendable {
        /// the page's cleaned title
        case title(String)
        /// no title: the page's domain (www. dropped), cut from the left
        case domain(String)
        /// a blank tab, a non-web page or no tab yet: "New tab" (the view's localized string)
        case newTab
    }

    /// The cleaned title, else the domain, else "New tab". A page that isn't a parsed http(s) URL
    /// (``, about:blank, another scheme, junk) is "New tab" whatever its title says (recheck 5).
    static func tabName(_ tab: BrowserTab) -> TabName {
        guard let host = webHost(tab.url) else { return .newTab }
        let title = displayTitle(tab.title)
        if !title.isEmpty { return .title(title) }
        return .domain(shortenHost(dropWWW(host), limit: titleLimit))
    }

    static func dropWWW(_ host: String) -> String {
        host.hasPrefix("www.") && host.count > 4 ? String(host.dropFirst(4)) : host
    }

    // MARK: - The address

    /// The host of a parsed http(s) URL: no scheme, user name, password, port, path or query.
    /// Lowercased; punycode stays punycode (URLComponents' `host` would turn it into Unicode,
    /// so this reads `encodedHost`). nil for "", about:blank, other schemes and junk.
    static func webHost(_ url: String) -> String? {
        guard !url.isEmpty, url.count <= 8192, let parts = URLComponents(string: url) else { return nil }
        guard let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        guard let host = parts.encodedHost?.lowercased(), isHostText(host) else { return nil }
        return host
    }

    /// ASCII letters, digits, ".", "-" and "_" (a punycode name, an IPv4 address), or an IPv6
    /// literal in brackets. Anything else is shown as nothing rather than guessed at.
    static func isHostText(_ host: String) -> Bool {
        guard !host.isEmpty, host.utf8.count <= 253 + 2 else { return false }
        if host.hasPrefix("[") {
            guard host.hasSuffix("]"), host.count > 2 else { return false }
            return host.dropFirst().dropLast().unicodeScalars.allSatisfy { scalar in
                scalar.isASCII && (scalar.properties.isASCIIHexDigit || scalar == ":" || scalar == ".")
            }
        }
        guard host.contains(where: { $0 != "." }) else { return false }
        return host.unicodeScalars.allSatisfy { scalar in
            scalar.isASCII && (("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) || scalar == "." || scalar == "-" || scalar == "_")
        }
    }

    /// Shortened from the left so the end, the registrable domain, stays: whole labels where they
    /// fit ("…secure.paypal.com.evil.example"), else the last characters.
    static func shortenHost(_ host: String, limit: Int = hostLimit) -> String {
        guard limit > 1, host.count > limit else { return host }
        let budget = limit - 1
        var kept: [Substring] = []
        var length = 0
        for label in host.split(separator: ".", omittingEmptySubsequences: false).reversed() {
            let add = label.count + (kept.isEmpty ? 0 : 1)
            if length + add > budget { break }
            kept.insert(label, at: 0)
            length += add
        }
        // At least the last two labels, or the shown end would be a guess.
        guard kept.count >= 2 else { return "…" + String(host.suffix(budget)) }
        return "…" + kept.joined(separator: ".")
    }

    /// The address field while idle: the active tab's host, shortened; "" for none.
    static func shownHost(_ url: String) -> String {
        webHost(url).map { shortenHost($0) } ?? ""
    }

    /// What the field holds when the user taps it: the full URL (ASCII, percent-encoded, as the
    /// server sent it) without a user name or password; "" for a non-web page (recheck 5, 7).
    static func editText(_ url: String) -> String {
        guard webHost(url) != nil, var parts = URLComponents(string: url) else { return "" }
        if parts.user != nil || parts.password != nil {
            parts.user = nil
            parts.password = nil
        }
        guard let text = parts.string, text.unicodeScalars.allSatisfy({ $0.value > 0x20 && $0.value < 0x7F }) else { return "" }
        return text
    }

    // MARK: - Decoding defensively

    /// A tab id the contract can have: ^[A-Za-z0-9_-]{1,200}$.
    static func isValidId(_ id: String) -> Bool {
        guard !id.isEmpty, id.utf8.count <= maxIdLength else { return false }
        return id.unicodeScalars.allSatisfy { scalar in
            scalar.isASCII && (scalar.properties.isAlphabetic || ("0"..."9").contains(scalar) || scalar == "_" || scalar == "-")
        }
    }

    /// At most 50 tabs with valid, distinct ids, at most one active (the first). If the active tab
    /// would be cut, it takes the 50th place, so the field never loses it.
    static func sanitized(_ bar: BrowserBar) -> BrowserBar {
        var seen = Set<String>()
        var hasActive = false
        var tabs: [BrowserTab] = []
        for var tab in bar.tabs where isValidId(tab.id) && !seen.contains(tab.id) {
            seen.insert(tab.id)
            if tab.active {
                if hasActive { tab.active = false } else { hasActive = true }
            }
            tabs.append(tab)
        }
        if tabs.count > maxTabs {
            let active = tabs.firstIndex(where: \.active)
            var kept = Array(tabs.prefix(maxTabs))
            if let active, active >= maxTabs { kept[maxTabs - 1] = tabs[active] }
            tabs = kept
        }
        var out = bar
        out.tabs = tabs
        return out
    }

    // MARK: - What the bar shows

    /// One tab of the strip as drawn: its cleaned name and ✕, no icon (no site icons in M27).
    struct TabItem: Hashable, Sendable, Identifiable {
        var id: String
        var name: TabName
        var active: Bool
        /// "New tab" while the browser has none yet: nothing to switch to or close
        var placeholder = false
    }

    /// Can't collide with a real id (a space is never in one).
    static let placeholderId = "new tab"

    /// The strip's tabs; one placeholder "New tab" while the browser has none yet.
    static func tabItems(_ bar: BrowserBar) -> [TabItem] {
        guard !bar.tabs.isEmpty else { return [TabItem(id: placeholderId, name: .newTab, active: true, placeholder: true)] }
        return bar.tabs.map { TabItem(id: $0.id, name: tabName($0), active: $0.active) }
    }

    /// Whether the bar is there and how it looks.
    enum Presence: Hashable, Sendable {
        /// not set up, its state failed to load, or Chrome's own bar is in the frames (headed)
        case hidden
        /// loading, waking, or before the first answer: a disabled bar of the same height
        case skeleton
        /// after "Let it sleep": dimmed, untappable
        case dimmed
        case live
    }

    enum Layout: Hashable, Sendable {
        /// the tab strip over ← → ↻ and the address field
        case tabs
        /// an older computer (no tabs): one read-only address row
        case addressOnly
    }

    static func presence(_ view: ComputerViewState, resting: Bool) -> Presence {
        if view.bar.browserBarInFrame { return .hidden }
        switch ComputerDeployRules.body(view) {
        case .unavailable, .failed: return .hidden
        case .loading: return .skeleton
        case .waking: return resting ? .dimmed : .skeleton
        case .screen:
            if resting { return .dimmed }
            return view.barKnown ? .live : .skeleton
        }
    }

    /// Tabs unless the computer is known to predate them (supported false in an answer, or a POST
    /// answered tabs_unsupported).
    static func layout(_ view: ComputerViewState) -> Layout {
        view.barKnown && !view.bar.supported ? .addressOnly : .tabs
    }

    /// What can be used. Read-only while the assistant drives: no ✕, no +, ← → ↻ dimmed, the field not
    /// editable; the frames stay the same (the ✕ and + keep their space) so Take over doesn't jump.
    struct Controls: Hashable, Sendable {
        var interactive = false
        var canSwitch = false
        var canClose = false
        var canAdd = false
        var canGoBack = false
        var canGoForward = false
        var canReload = false
        var canEdit = false
    }

    static func controls(_ view: ComputerViewState, presence: Presence, layout: Layout) -> Controls {
        guard presence == .live, layout == .tabs, view.bar.supported, view.isUserInControl else { return Controls() }
        return Controls(
            interactive: true, canSwitch: true, canClose: !view.bar.tabs.isEmpty, canAdd: true,
            canGoBack: view.bar.canGoBack, canGoForward: view.bar.canGoForward,
            canReload: view.bar.activeTab != nil, canEdit: true
        )
    }

    /// Everything the bar view draws.
    struct Model: Hashable, Sendable {
        var presence: Presence
        var layout: Layout
        var tabs: [TabItem]
        var activeId: String?
        /// the address field while idle: the host only ("" = the placeholder, or nothing)
        var host: String
        /// a blank tab: "Search or type a web address"
        var showsPlaceholder: Bool
        /// what the field holds once tapped: the full URL, or ""
        var editText: String
        var controls: Controls
        /// a bar action is in flight (a spinner in place of ↻)
        var busy: Bool
    }

    static func model(_ view: ComputerViewState, resting: Bool) -> Model {
        let presence = presence(view, resting: resting)
        let layout = layout(view)
        let tabs = tabItems(view.bar)
        let active = view.bar.activeTab
        let host: String
        switch layout {
        case .tabs: host = presence == .skeleton ? "" : shownHost(active?.url ?? "")
        case .addressOnly: host = olderHost(view.computer)
        }
        return Model(
            presence: presence, layout: layout, tabs: tabs,
            activeId: tabs.first(where: \.active)?.id,
            host: host,
            showsPlaceholder: layout == .tabs && presence == .live && host.isEmpty,
            editText: editText(active?.url ?? ""),
            controls: controls(view, presence: presence, layout: layout),
            busy: view.barAction != nil
        )
    }

    /// An older computer: the domain the top bar showed before (ComputerState.url's host, else
    /// its domain when that is a plain host), read-only.
    static func olderHost(_ computer: ComputerState?) -> String {
        if let url = computer?.url, let host = webHost(url) { return shortenHost(host) }
        if let domain = computer?.domain?.lowercased(), isHostText(domain) { return shortenHost(domain) }
        return ""
    }

    // MARK: - Refusals (one line under the bar, cleared by the next action)

    enum Refusal: Hashable, Sendable {
        case takeOverFirst
        case needsUpdate
        case notAWebAddress
        case credentials
        case searchTooLong
        case addressTooLong
        case tooManyTabs
        case tooFast
        /// anything else: APIError.localizedReason
        case other(String)

        /// Address refusals keep the typed text and the focus.
        var keepsAddress: Bool {
            switch self {
            case .notAWebAddress, .credentials, .searchTooLong, .addressTooLong: true
            default: false
            }
        }

        /// The line shown (never the server's own English text).
        var message: String {
            switch self {
            case .takeOverFirst: String(localized: "Take over to use the browser.")
            case .needsUpdate: String(localized: "OpenDuet's computer needs an update for tabs.")
            case .notAWebAddress: String(localized: "That isn't a web address.")
            case .credentials: String(localized: "Addresses with a user name or password can't be opened.")
            case .searchTooLong: String(localized: "That's too long to search for.")
            case .addressTooLong: String(localized: "That address is too long.")
            case .tooManyTabs: String(localized: "Close a tab first. At most 20 can be open.")
            case .tooFast: String(localized: "Too many actions. Wait a moment.")
            case .other(let reason): reason
            }
        }
    }

    /// What a bar action's answer does to the bar.
    enum Outcome: Hashable, Sendable {
        /// a refusal line under the bar
        case refused(Refusal)
        /// the tab closed meanwhile (404): nothing shown, the tabs are read again
        case refetch
        /// cancelled, or a 2xx that didn't decode: the bar stays as it is (the stream follows)
        case none
    }

    /// The refusal (or quiet outcome) of a failed bar action. `newTab`: a 409 `conflict` on + is the
    /// 20-tab cap.
    static func outcome(of error: any Error, newTab: Bool = false) -> Outcome {
        if error is CancellationError { return .none }
        guard let api = error as? APIError else { return .refused(.other(String(localized: "Something went wrong."))) }
        switch api {
        case .notFound: return .refetch
        case .invalidResponse: return .none
        case .rateLimited: return .refused(.tooFast)
        case .validationFailed(field: "address", let message): return .refused(addressRefusal(message))
        case .server(_, "take_over_first"): return .refused(.takeOverFirst)
        case .server(_, "tabs_unsupported"): return .refused(.needsUpdate)
        case .server(_, "conflict") where newTab: return .refused(.tooManyTabs)
        default: return .refused(.other(api.localizedReason))
        }
    }

    /// A 400 `address` refusal by the server message's ending (docs/API.md "## M27 browser").
    static func addressRefusal(_ message: String) -> Refusal {
        let text = message.lowercased()
            .replacingOccurrences(of: "\u{2019}", with: "'")
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        if text.hasSuffix("user name or password can't be opened") { return .credentials }
        if text.hasSuffix("too long to search for") { return .searchTooLong }
        if text.hasSuffix("too long") { return .addressTooLong }
        return .notAWebAddress
    }
}

/// One bar action after Take over (docs/API.md "## M27 browser"): its route and body. Every one
/// answers the new BrowserBar once the page has started loading.
enum BrowserBarAction: Hashable, Sendable {
    /// + (nil = the start page, and the field is focused after it) or Go without a tab
    case newTab(address: String?)
    case activate(tabId: String)
    case close(tabId: String)
    case navigate(NavigateRequest)

    enum Body: Hashable, Sendable {
        case none
        case newTab(NewTabRequest)
        case navigate(NavigateRequest)
    }

    /// The path, the tab id percent-encoded as one segment (recheck point 9).
    var path: String {
        switch self {
        case .newTab: "/api/computer/tabs"
        case .activate(let id): "/api/computer/tabs/\(id.pathSegment)/activate"
        case .close(let id): "/api/computer/tabs/\(id.pathSegment)/close"
        case .navigate: "/api/computer/navigate"
        }
    }

    var body: Body {
        switch self {
        case .newTab(let address): .newTab(NewTabRequest(address: address))
        case .activate, .close: .none
        case .navigate(let request): .navigate(request)
        }
    }

    /// + on its own (the field is focused on the new tab's start page afterwards).
    var isBlankNewTab: Bool { self == .newTab(address: nil) }
    var isNewTab: Bool { if case .newTab = self { true } else { false } }

    /// Go in the address field: what was typed, trimmed and sent as it is (the server reads it as
    /// an address or a search by the user's region; the app never builds a URL). Empty = nothing.
    static func submit(_ typed: String, hasTab: Bool) -> BrowserBarAction? {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return hasTab ? .navigate(.address(text)) : .newTab(address: text)
    }
}

/// Which bar answer is newest. Stream messages and POST answers always replace the bar; a GET
/// /api/computer/tabs answer that arrives after either of them is older and is dropped (counted).
struct BrowserBarFeed: Hashable, Sendable {
    private(set) var version = 0
    /// GET answers dropped as stale (for the logs and the tests)
    private(set) var droppedFetches = 0

    struct Ticket: Hashable, Sendable {
        fileprivate var version: Int
    }

    /// Taken when the GET starts.
    func ticket() -> Ticket { Ticket(version: version) }

    /// A stream message or a POST answer arrived: it wins over any GET still on its way.
    mutating func noteNewer() { version &+= 1 }

    /// The GET answered: true if nothing newer came meanwhile (then it counts as the newest).
    mutating func accept(_ ticket: Ticket) -> Bool {
        guard ticket.version == version else {
            droppedFetches += 1
            return false
        }
        version &+= 1
        return true
    }
}

/// One bar action at a time; taps meanwhile wait behind it (no double sends: the same action
/// already running or waiting is dropped, and at most `maxWaiting` wait).
struct BrowserBarQueue: Hashable, Sendable {
    static let maxWaiting = 4
    private(set) var running: BrowserBarAction?
    private(set) var waiting: [BrowserBarAction] = []

    /// false = dropped (a repeat, or too many waiting)
    @discardableResult
    mutating func enqueue(_ action: BrowserBarAction) -> Bool {
        guard action != running, !waiting.contains(action), waiting.count < Self.maxWaiting else { return false }
        waiting.append(action)
        return true
    }

    /// The next one to send, if none is running.
    mutating func next() -> BrowserBarAction? {
        guard running == nil, !waiting.isEmpty else { return nil }
        running = waiting.removeFirst()
        return running
    }

    mutating func finish() { running = nil }

    /// Hand back, or a refusal every waiting action would get too.
    mutating func dropWaiting() { waiting = [] }
}

/// The address field's editing, kept by the full-screen view so it lasts while the layout turns
/// (upright and landscape draw different fields). The draft is only on screen: never stored.
struct BrowserAddressEditing: Hashable, Sendable {
    private(set) var isEditing = false
    var draft = ""
    /// select the whole text when editing begins (a tap, +), else the caret goes to the end
    private(set) var selectAll = false
    /// grows on every begin, so the field selects again
    private(set) var session = 0
    /// what Go sent, until its answer: an address refusal puts it back in the field
    private(set) var submitted: String?

    /// A tap on the field (the full URL, selected) or + (the new tab's address, selected).
    mutating func begin(text: String, selectAll: Bool = true) {
        isEditing = true
        draft = text
        self.selectAll = selectAll
        session &+= 1
    }

    /// Cancel, a tap on the page, the keyboard button, Hand back: the shown host comes back.
    mutating func cancel() {
        isEditing = false
        draft = ""
    }

    /// Go: what to send (trimmed; nil = nothing to send), and editing ends.
    mutating func submit() -> String? {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        isEditing = false
        draft = ""
        submitted = text.isEmpty ? nil : text
        return submitted
    }

    /// The server refused the address: the text and the focus come back (caret at the end).
    mutating func refused() {
        guard let text = submitted else { return }
        begin(text: text, selectAll: false)
    }

    /// Any other answer to Go.
    mutating func answered() { submitted = nil }
}
