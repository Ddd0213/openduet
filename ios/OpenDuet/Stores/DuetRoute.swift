// In-app links (docs/API.md "Conventions"): duet://tasks/<id>, duet://artifacts/<id>,
// duet://channels/<id>, duet://files/<id>, duet://computer. M3 opens tasks; the rest are M4+.
// M21: channel and task links may name the message to scroll to (?message=<messageId>, from
// pushes and `notification` events); RouteFocus carries it until that thread shows it.
// M22: duet://suggestions/<id> (an Up next suggestion: tapping starts it, show_tasks card rows) and
// duet://settings/<page> (Setup's fixes and Everything's pages: models, apps, voice, setup, soul).
// M25: ComposeRequest, the main thread's composer opened with a prefilled draft (Create with OpenDuet).
import Foundation
import Observation

enum DuetRoute: Hashable, Sendable {
    case task(id: String)
    case artifact(id: String)
    case channel(id: String)
    case file(id: String)
    case computer
    /// M22: an Up next suggestion; opening it starts it (POST /api/up-next/:id/add), then the task
    case suggestion(id: String)
    /// M22: a page of Everything (Setup's fixes)
    case settings(SettingsPage)

    /// M22: the Everything pages a link can open.
    enum SettingsPage: String, Hashable, Sendable {
        case models, apps, voice, setup, soul
    }

    init?(_ url: URL) {
        guard url.scheme?.lowercased() == "duet", let host = url.host()?.lowercased() else { return nil }
        let id = url.pathComponents.first { $0 != "/" }?.removingPercentEncoding
        switch (host, id) {
        case ("tasks", let id?) where !id.isEmpty: self = .task(id: id)
        case ("artifacts", let id?) where !id.isEmpty: self = .artifact(id: id)
        case ("channels", let id?) where !id.isEmpty: self = .channel(id: id)
        case ("files", let id?) where !id.isEmpty: self = .file(id: id)
        case ("computer", _): self = .computer
        case ("suggestions", let id?) where !id.isEmpty: self = .suggestion(id: id)
        case ("settings", let page?):
            guard let page = SettingsPage(rawValue: page.lowercased()) else { return nil }
            self = .settings(page)
        default: return nil
        }
    }

    /// The tab a route needs on screen: a channel's thread lives on Chat; a task detail (and the
    /// M5/M6 viewers) opens as an overlay over whatever tab is showing, so nil = stay.
    var tab: ShellTab? {
        if case .channel = self { .chat } else { nil }
    }

    /// M21: the message a link names (`?message=<id>`, percent-decoded); nil when there is none
    /// or it is empty.
    static func messageId(in url: URL) -> String? {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        guard let value = items?.first(where: { $0.name == "message" })?.value, !value.isEmpty else { return nil }
        return value
    }
}

/// M25: "open the main thread with this in the composer" (Settings › Skills › Create with OpenDuet).
/// Not a duet:// link: the draft is the shell's own state (MainShellView), which ChatStore's
/// openRoute doesn't reach. The shell takes the text when `token` changes; nothing is sent.
@MainActor @Observable
final class ComposeRequest {
    static let shared = ComposeRequest()

    @ObservationIgnored private(set) var text: String?
    /// bumped by every ask, so the same text asked twice opens the composer twice
    private(set) var token = 0

    func ask(_ text: String) {
        self.text = text
        token += 1
    }

    /// The asked text, once.
    func take() -> String? {
        defer { text = nil }
        return text
    }
}

/// M21: a channel or task link that names a message: the thread it opens scrolls to that
/// message once the message is loaded. Gone when it was shown (ShellActions.focusShown), when
/// the thread's fresh page doesn't have it (open as before), or when the user goes elsewhere.
/// M29: a channel link whose message is older than the newest page pages back for it (`step`).
struct RouteFocus: Hashable, Sendable {
    enum Target: Hashable, Sendable {
        case channel(String)
        case task(String)
    }

    /// What a thread's loaded messages mean for the focus (`step`).
    enum Step: Hashable, Sendable {
        /// the message is loaded: the thread scrolls to it
        case found
        /// a channel thread without it yet: load the page before its oldest message
        case loadOlder
        /// not there (and not looked for further): the thread opens as before, at the bottom
        case giveUp
    }

    /// Older pages a channel link may load while looking for its message.
    static let maxOlderPages = 10

    var target: Target
    var messageId: String
    /// a new tap on the same link scrolls again
    var token = UUID()
    /// M29: older pages loaded so far while looking for the message
    var olderPages = 0

    /// The focus a route asks for: a channel or task link with `?message=`; nil otherwise.
    init?(_ url: URL) {
        guard let route = DuetRoute(url), let messageId = DuetRoute.messageId(in: url) else { return nil }
        switch route {
        case .channel(let id): target = .channel(id)
        case .task(let id): target = .task(id)
        default: return nil
        }
        self.messageId = messageId
    }

    init(target: Target, messageId: String, token: UUID = UUID()) {
        self.target = target
        self.messageId = messageId
        self.token = token
    }

    /// What the chat thread of `channelId` should scroll to (nil when it targets anything else).
    func thread(channelId: String) -> ThreadFocus? {
        target == .channel(channelId) ? ThreadFocus(messageId: messageId, token: token) : nil
    }

    /// What the detail of `taskId` should scroll to.
    func thread(taskId: String) -> ThreadFocus? {
        target == .task(taskId) ? ThreadFocus(messageId: messageId, token: token) : nil
    }

    /// The target's fresh page came: the focus stays only while that page has the message
    /// (unknown or older than the page = the thread opens as before).
    func survives(_ messages: [Message]) -> Bool {
        messages.contains { $0.id == messageId }
    }

    /// M29: after a page of the target thread came. A channel thread pages back (at most
    /// `maxOlderPages`) while it has more before; a task's thread only looks at its newest page,
    /// as before.
    func step(_ messages: [Message], hasMoreBefore: Bool) -> Step {
        if survives(messages) { return .found }
        guard case .channel = target, hasMoreBefore, olderPages < Self.maxOlderPages else { return .giveUp }
        return .loadOlder
    }
}
