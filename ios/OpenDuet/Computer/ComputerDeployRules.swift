// M20 (prompt L138, plan §3 W5): the assistant's computer is optional and chosen at deploy time. The
// pure rules of what the app shows for it: deployed or not (Me.features.computerMode off, or
// GET /api/computer answering available false: both read the same), the preview card's state
// line ("Asleep · Sleeps after N min idle"), "Let it sleep" in the full-screen toolbar, and the
// full-screen view while the browser was put to sleep there (it stays asleep until a tap wakes
// it). Pure Foundation, so the host tests compile it.
import Foundation

enum ComputerDeployRules {
    /// The command that deploys the assistant's computer (run on the server, in the repository).
    static let deployCommand = "./scripts/setup.sh --computer on"
    /// The headed browser's extra flag (a real window on a virtual display).
    static let headedFlag = "--browser headed"
    /// Whether the deploy hint mentions the headed option. Off for now: the main agent turns it on
    /// once the headed browser is proven on the server (M20 acceptance, plan §3 "有头模式").
    static let offersHeaded = false
    /// The dimmed look of what can't work without the computer (the same as a disabled picker).
    static let dimmedOpacity: Double = 0.5
    /// How long a closing full-screen cover takes before a sheet can come up from the same root
    /// (a cover closes a little slower than the 450 ms the store waits for a sheet).
    static let reopenDelay: Duration = .milliseconds(600)

    /// The assistant's computer is deployed on this server. Until GET /api/computer answers, the mode
    /// from Me.features decides; a computer that says it isn't available is not deployed either.
    static func isDeployed(_ view: ComputerViewState) -> Bool {
        guard view.mode != .off else { return false }
        return view.computer?.available ?? true
    }

    /// Minutes worth showing in "Sleeps after N min idle" (nil or 0 from the server = never).
    static func idleMinutes(_ view: ComputerViewState) -> Int? {
        guard let minutes = view.idleMinutes, minutes > 0 else { return nil }
        return minutes
    }

    // MARK: - The preview card in the computer detail

    /// The state on the right of the preview card's footer.
    enum PreviewTag: Hashable, Sendable {
        /// not deployed, or not loaded yet
        case none
        case live
        case waking
        /// "Asleep · Sleeps after N min idle" ("Asleep" alone when it never sleeps on its own)
        case asleep(idleMinutes: Int?)
    }

    static func previewTag(_ view: ComputerViewState) -> PreviewTag {
        guard isDeployed(view), let computer = view.computer else { return .none }
        switch computer.browser {
        case .ready: return .live
        case .starting: return .waking
        case .off: return .asleep(idleMinutes: idleMinutes(view))
        }
    }

    /// The preview follows the live stream (and keeps it open) only while the browser is up or
    /// waking; it holds still while it sleeps or is being put to sleep (an open stream would
    /// start it again) and never opens a socket to a server without it.
    static func previewIsLive(_ view: ComputerViewState) -> Bool {
        guard isDeployed(view), view.control != .sleeping else { return false }
        guard let computer = view.computer else { return view.phase == .loading }
        return computer.browser != .off
    }

    // MARK: - "Let it sleep"

    enum SleepButton: Hashable, Sendable {
        case hidden
        /// shown dimmed: the assistant is working, the user drives, or another request runs
        case disabled
        case enabled
        /// POST /api/computer/sleep in flight (spinner inside)
        case busy
    }

    /// Shown while the browser is up or starting on a deployed computer; usable only while
    /// nobody uses it (the assistant's status is nil, the assistant has control) and nothing else runs.
    static func sleepButton(_ view: ComputerViewState, status: StatusKey?) -> SleepButton {
        if view.control == .sleeping { return .busy }
        guard isDeployed(view), let computer = view.computer, computer.browser != .off else { return .hidden }
        if view.isBusy || view.isUserInControl || status != nil { return .disabled }
        return .enabled
    }

    /// Take over / Hand back is in flight (the capsule's spinner); "Let it sleep" has its own.
    static func isToggling(_ view: ComputerViewState) -> Bool {
        view.control == .taking || view.control == .releasing
    }

    // MARK: - The full-screen view

    /// "Let it sleep" answered with the browser off: the view now shows it asleep and lets the
    /// live stream go, so the stream doesn't wake the browser again.
    static func startsResting(from old: ComputerViewState.Control, to new: ComputerViewState.Control, browser: ComputerState.Browser?) -> Bool {
        old == .sleeping && new == .idle && browser == .off
    }

    /// The browser came up again (the assistant needed it): the asleep state is over.
    static func endsResting(browser: ComputerState.Browser?) -> Bool {
        browser == .starting || browser == .ready
    }

    /// The full-screen view asks for the live stream (which wakes the browser) except on a server
    /// without the assistant's computer, while it rests, and from the moment "Let it sleep" is tapped
    /// (an open stream would start the browser again).
    static func wantsStream(_ view: ComputerViewState, resting: Bool) -> Bool {
        !resting && view.control != .sleeping && body(view) != .unavailable
    }

    /// What ends the store's hold on the stream after "Let it sleep" (ChatStore+Computer): only
    /// a deliberate wake or the browser coming up on its own, never a live view attaching (SwiftUI
    /// may attach the full-screen view again while it flips to asleep).
    enum StreamEvent: Equatable, Sendable {
        case viewAttached
        case openedFullScreen
        case tappedWake
        case state(ComputerState.Browser)
    }

    static func holdsStream(_ held: Bool, after event: StreamEvent) -> Bool {
        switch event {
        case .viewAttached: held
        case .openedFullScreen, .tappedWake: false
        case .state(let browser): held && browser == .off
        }
    }

    /// The status pill: "You're in control" first; the assistant's own computer (or the assistant's status)
    /// while it rests or isn't deployed, never "Waking OpenDuet's workspace" then.
    static func pill(_ view: ComputerViewState, status: StatusKey?, resting: Bool) -> ComputerPresentation.Pill {
        if view.isUserInControl { return .inControl }
        if resting || !isDeployed(view) { return status.map(ComputerPresentation.Pill.status) ?? .idle }
        return ComputerPresentation.pill(computer: view.computer, status: status)
    }

    /// The middle of the full-screen view: "isn't set up" as soon as the mode says it isn't
    /// deployed (no waiting for GET /api/computer), else as before.
    static func body(_ view: ComputerViewState) -> ComputerPresentation.Body {
        if view.mode == .off { return .unavailable }
        return ComputerPresentation.body(view)
    }

    /// Take over once the screen is there on a deployed computer that isn't resting; Hand back
    /// whenever the user drives.
    static func canToggleControl(_ view: ComputerViewState, resting: Bool) -> Bool {
        if view.isBusy { return false }
        if view.isUserInControl { return true }
        return !resting && isDeployed(view) && body(view) == .screen
    }
}
