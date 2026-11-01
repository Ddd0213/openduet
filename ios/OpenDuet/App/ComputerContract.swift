// M6 (iOS 1) additions to the data <-> UI seam (see ShellContract.swift): the assistant's computer
// (live browser card, full-screen "OpenDuet's computer", Take over / Hand back, sign-in card,
// human checks) and files from the assistant (file cards, full-screen preview, channel sheet and
// profile Files lists). Prompt L141-L144, L180, DETAILS L172.
//
// Owned by the iOS-1 agent during M6. Besides the state and actions this file holds the pure
// logic of the feature (geometry, typing diffs, pill / body selection, sign-in card phases,
// file kinds and names, the stream URL) so the host tests compile it without UIKit.
//
// Live screen frames (JPEG, several per second) don't go through ShellState: rebuilding the
// whole shell state per frame would re-render everything. `LiveScreen` (an observable object
// owned by the store's ComputerRuntime) carries them; only the live screen views read it.
import Foundation
import Observation

struct ComputerViewState: Hashable, Sendable {
    /// Take over / Hand back to the assistant in progress or failed (inline reason above the button)
    enum Control: Hashable, Sendable {
        case idle
        case taking
        case releasing
        /// M20: "Let it sleep" (POST /api/computer/sleep) in flight
        case sleeping
        case failed(reason: String)
    }

    /// GET /api/computer, then live from `computer` events and the stream; nil until first loaded
    var computer: ComputerState?
    /// the first GET /api/computer (skeleton while loading, grey reason + Retry if it fails)
    var phase: TasksState.Phase = .loading
    /// the full-screen "OpenDuet's computer" view is up (store-driven, so the live browser card,
    /// the Open browser alert, duet://computer and the task's "OpenDuet's browser" row open it)
    var isOpen = false
    var control: Control = .idle
    /// sign-in cards answered in this session, by request id (POST /api/computer/sign-in answers
    /// before the card's own message event arrives); the in-flight / failed tap itself is in
    /// ShellState.cardRequests[RequestKey.signIn(requestId)]
    var signIns: [String: SignInCardResponse.State] = [:]
    /// M20: the full answers of those cards (step .code after the password, the failure reason,
    /// taken over / dismissed), by request id; `signIns` keeps the state for SignInCardPhase
    var signInAnswers: [String: SignInCardResponse] = [:]
    /// M20: from Me.features: off = not deployed on this server (the deploy hint), else the
    /// browser's mode; idleMinutes = "Sleeps after N min idle" (nil = never)
    var mode: ComputerMode = .headless
    var idleMinutes: Int?

    // M27 W6: the full-screen view's own tab strip and address bar (Computer/BrowserBarRules.swift)
    /// GET /api/computer/tabs on open and on reconnect, then every stream `browser_bar` message and
    /// every bar action's answer, cleaned by BrowserBarRules.sanitized; `.unsupported` until then
    var bar: BrowserBar = .unsupported
    /// an answer (or a failed GET) arrived; until then the bar is a skeleton of the full height
    var barKnown = false
    /// the bar action in flight (a spinner in place of ↻); one at a time, the others wait
    var barAction: BrowserBarAction?
    /// the last refused bar action's line under the bar, cleared by the next action or Hand back
    var barRefusal: BrowserBarRules.Refusal?
    /// grows with every refusal, so the same address refused twice still comes back to the field
    var barRefusals = 0
    /// grows when + was answered: the view focuses the field with the new tab's address selected
    var newTabs = 0

    var isUserInControl: Bool { computer?.controller == .user }
    var isBusy: Bool { control == .taking || control == .releasing || control == .sleeping }

    /// The store's answer to a new ComputerState (GET, event, stream or take / release).
    mutating func apply(_ state: ComputerState) {
        computer = state
        phase = .loaded
        // The controller moved on its own (e.g. The assistant was handed control by the server): a
        // take / release that was waiting for exactly that is over.
        switch (control, state.controller) {
        case (.taking, .user), (.releasing, .assistant): control = .idle
        default: break
        }
        if control == .sleeping, state.browser == .off { control = .idle }
    }
}

struct FilesState: Hashable, Sendable {
    /// the full-screen preview of a file downloaded through the signed-in session; nil = none
    var preview: FilePreviewState?
    /// the channel sheet (tap on a channel's header pill): its details and Files list; nil = none
    var channelSheet: ChannelSheetState?
    /// profile > Files: the main thread's files (GET /api/channels/<main>/files, newest first)
    var mainFiles = FileListState()
}

/// A Files list (channel sheet, profile > Files): skeleton rows, the files or a grey reason.
/// M26: shown in groups by origin (FileGroups).
struct FileListState: Hashable, Sendable {
    var phase: TasksState.Phase = .loading
    /// newest first
    var files: [ChannelFile] = []
    /// M9: long-press Delete in flight or failed, by file id (FileActions.delete); the row dims
    /// while in flight and shows the reason under it on failure. M26: the failure says what to do
    /// next (Retry, or delete the chat's copy only).
    var deleting: [String: FileDeleteRequest] = [:]
    /// M26: when the last delete asked for the original too and it was already gone: a short
    /// note under the list (FileDeleteRules.keepsNote: cleared by the next delete and by a refresh
    /// after the reload that follows the preview closing); nil = no note
    var workspaceGoneAt: Date?
}

struct FilePreviewState: Hashable, Sendable, Identifiable {
    enum Phase: Hashable, Sendable {
        case loading
        /// downloaded to a temporary file for Quick Look / WKWebView / Share
        case ready(localURL: URL)
        case failed(reason: String)
    }
    var file: ChannelFile
    var phase: Phase = .loading
    /// M26: the ⋯ menu's Delete in flight or refused (the confirmation at the preview's bottom)
    var deleting: FileDeleteRequest?
    var id: String { file.id }
    /// Quick Look or the app's own WKWebView (HTML)
    var kind: FileKind { FileKind(mime: file.mime, name: file.name) }
}

struct ChannelSheetState: Hashable, Sendable {
    var channelId: String
    /// icon, name and purpose at the top (the selected channel when the pill was tapped)
    var channel: Channel?
    var phase: TasksState.Phase = .loading
    /// GET /api/channels/:id/files, newest first
    var files: [ChannelFile] = []
    /// M9: long-press Delete in flight or failed, by file id
    var deleting: [String: FileDeleteRequest] = [:]
    /// M26: FileListState.workspaceGoneAt
    var workspaceGoneAt: Date?

    var list: FileListState {
        FileListState(phase: phase, files: files, deleting: deleting, workspaceGoneAt: workspaceGoneAt)
    }
}

@MainActor
struct ComputerActions {
    /// live browser card tap, Open browser alert, duet://computer, "OpenDuet's browser" resource,
    /// "OpenDuet's computer" row: GET /api/computer and open the full-screen view
    var open: () -> Void = {}
    var close: () -> Void = {}
    /// Take over / Hand back to the assistant (POST /api/computer/take, /release)
    var take: () -> Void = {}
    var release: () -> Void = {}
    /// the failed first GET /api/computer's Retry
    var reload: () -> Void = {}
    /// a tap, drag, scroll, typed text or key for the browser (only sent while the user is in
    /// control; coordinates are 0...1 fractions of the frame)
    var input: (_ message: ComputerClientMessage) -> Void = { _ in }
    /// sign-in card's "Send to OpenDuet's browser" (cardRequests keyed by the request id). The
    /// password is passed straight to the request body and never stored or logged.
    var sendSignIn: (_ messageId: String, _ requestId: String, _ email: String, _ password: String) -> Void = { _, _, _, _ in }
    /// M20: the sign-in card's verification code (same request key as sendSignIn); the code goes
    /// straight to the request body and is never stored or logged
    var sendSignInCode: (_ messageId: String, _ requestId: String, _ code: String) -> Void = { _, _, _ in }
    /// M20: the sign-in card's "Take control instead": the card closes, the user gets the browser
    /// and the full-screen "OpenDuet's computer" opens
    var takeOverSignIn: (_ messageId: String, _ requestId: String) -> Void = { _, _ in }
    /// M20: the sign-in card's "Not now"
    var dismissSignIn: (_ messageId: String, _ requestId: String) -> Void = { _, _ in }
    /// M20: the full-screen toolbar's "Let it sleep" (control .sleeping while in flight; 409
    /// computer_busy shows its reason inline like Take over's failures)
    var sleep: () -> Void = {}
    /// M20: a tap on the asleep view: ends the hold after "Let it sleep" and starts the stream
    /// again (which wakes the browser)
    var wake: () -> Void = {}
    /// the live frames; views attach while they are on screen (the socket runs only then)
    var screen: LiveScreen?
    /// M27 W6: the full-screen view appeared: GET /api/computer/tabs (skipped while one runs)
    var loadBar: () -> Void = {}
    /// M27 W6: a tab strip or address bar action after Take over (waits behind the one in flight)
    var browserBar: (_ action: BrowserBarAction) -> Void = { _ in }
    /// M27 W6: a tap on the refusal line under the bar
    var dismissBarRefusal: () -> Void = {}
}

@MainActor
struct FileActions {
    /// file card / image bubble long-press / Files list row / duet://files/<id>
    var open: (_ fileId: String) -> Void = { _ in }
    var closePreview: () -> Void = {}
    /// the preview's Retry after a failed download
    var retryPreview: () -> Void = {}
    /// tap on the channel's header pill (the main thread's files live in the profile sheet)
    var openChannelSheet: () -> Void = {}
    var closeChannelSheet: () -> Void = {}
    /// the channel sheet's Retry
    var refreshChannelFiles: () -> Void = {}
    /// profile sheet > Files appeared (and its Retry): the main thread's Files list
    var refreshMainFiles: () -> Void = {}
    /// M9: long-press a Files row > Delete, after the in-place confirmation (DELETE /api/files/:id;
    /// FileListState.deleting[id]). The row leaves once the server answers; a failure stays under it.
    /// M26: `alsoWorkspace` = the confirmation's "Also delete from OpenDuet's computer" switch.
    var delete: (_ fileId: String, _ alsoWorkspace: Bool) -> Void = { _, _ in }
    /// M26: the preview's ⋯ › Delete, after the confirmation at its bottom (FilePreviewState.deleting);
    /// a success closes the preview.
    var deletePreviewed: (_ alsoWorkspace: Bool) -> Void = { _ in }
    /// M26: a task group's title (duet://tasks/<id>) and an artifact's page (duet://artifacts/<id>).
    /// The surface that shows the list closes first where it would cover what opens (the profile
    /// sheet and the channel sheet set their own); the default opens the route as it is.
    var openLink: (_ url: URL) -> Void = { _ in }
}

extension ShellState.RequestKey {
    /// a sign-in card's "Send to OpenDuet's browser", by the card's request id
    static func signIn(_ requestId: String) -> String { "signin:\(requestId)" }
}

/// The toolkit key of the assistant's computer (its tools and their Ask / Always policies). The backend
/// serves it on its own routes (GET /api/computer/tools, PUT /api/computer/policy), not in the
/// Composio catalog; it has its own row in the OpenDuet sheet, so More apps hides it too.
enum ComputerToolkit {
    static let slug = "duet_computer"
}

// MARK: - Live screen

/// The latest JPEG frame of the assistant's browser and the stream's state. Owned by the store's
/// ComputerRuntime; views only read it and say while they are on screen (`attach` / `detach`),
/// so the WebSocket runs only while something shows the live screen.
@MainActor
@Observable
final class LiveScreen {
    enum Connection: Hashable, Sendable {
        /// no socket (nothing on screen, or the server has no computer)
        case idle
        case connecting
        case live
        /// lost; retrying with backoff (the last frame stays, dimmed)
        case reconnecting
    }

    private(set) var connection: Connection = .idle
    /// the newest JPEG; nil until the first frame of this session
    private(set) var frame: Data?
    /// grows with every frame (views decode on change)
    private(set) var frameNumber = 0
    /// from `frame_meta`: the page size in pixels (zero until known)
    private(set) var pixelWidth = 0
    private(set) var pixelHeight = 0

    @ObservationIgnored private(set) var viewers = 0
    /// installed by the store: true when the first viewer appears, false after the last leaves
    @ObservationIgnored var onDemand: ((Bool) -> Void)?

    init() {}

    func attach() {
        viewers += 1
        if viewers == 1 { onDemand?(true) }
    }

    func detach() {
        guard viewers > 0 else { return }
        viewers -= 1
        if viewers == 0 { onDemand?(false) }
    }

    var hasViewers: Bool { viewers > 0 }

    func setConnection(_ value: Connection) {
        if connection != value { connection = value }
    }

    func show(_ jpeg: Data) {
        frame = jpeg
        frameNumber &+= 1
        if connection != .live { connection = .live }
    }

    func setSize(width: Int, height: Int) {
        if pixelWidth != width { pixelWidth = width }
        if pixelHeight != height { pixelHeight = height }
    }

    /// Sign-out: forget the frames (the viewers keep their counts; their views go away).
    func reset() {
        connection = .idle
        frame = nil
        pixelWidth = 0
        pixelHeight = 0
    }
}

// MARK: - Pure logic: geometry and input

enum ComputerGeometry {
    /// The page frame used before `frame_meta` arrives (a desktop-like 16:10 page).
    static let defaultAspect: Double = 10.0 / 16.0

    /// The size of a frame fitted to the width of `container`, shrunk only if it would be
    /// taller than the container (landscape).
    static func fitted(frame: CGSize, in container: CGSize) -> CGSize {
        guard frame.width > 0, frame.height > 0, container.width > 0, container.height > 0 else { return .zero }
        let scale = min(container.width / frame.width, container.height / frame.height)
        return CGSize(width: frame.width * scale, height: frame.height * scale)
    }

    /// M20b: a portrait frame (the whole Chrome window) shrunk below this share of the
    /// full-screen view's width isn't readable any more (portrait with the keyboard up, or a very
    /// large text size on a small phone): it is shown at the full width instead, top first, and
    /// pans (two fingers while the user drives) to reach the rest.
    static let minimumShrink: CGFloat = 0.5
    /// The pinch-zoom limit over the fitted frame (as before M20b)
    static let maximumZoom: CGFloat = 4
    /// The double-tap zoom while the assistant drives (as before M20b)
    static let doubleTapZoom: CGFloat = 2.5

    /// How the full-screen view lays out a frame (RemoteScreenView). `size` is the frame at zoom
    /// 1, the space every input point is measured in (0...1 fractions of the whole frame);
    /// `startZoom` > 1 starts it zoomed in to the full width, scrolled to the top.
    struct ScreenFit: Equatable {
        var size: CGSize
        /// M27 W6: every frame sits right under the view's top: under the app's own tab strip and
        /// address bar (the 1280 × 800 page, so the two read as one browser window), or a portrait
        /// window's own bar under the top bar. The space below stays empty above the capsule.
        var topAligned: Bool
        var startZoom: CGFloat
        var maxZoom: CGFloat
        /// the double-tap zoom while the assistant drives (never below `startZoom`)
        var doubleTapZoom: CGFloat
    }

    /// The frame (M27 C2: the 1280 × 800 page by default; a portrait or headed deployment sends a
    /// portrait page or window) fitted to the width, shrunk to the height when that limits it, at
    /// the top. When the shrink would go below `minimumShrink` of the width (the keyboard is up)
    /// it starts at the full width instead, top first, and pans (M20b's rule, now for both
    /// shapes). `landscape` = sideways (the landscape full screen gives the frame its own rect):
    /// fitted, never zoomed in at the start.
    static func screenFit(frame: CGSize, in container: CGSize, landscape: Bool = false) -> ScreenFit {
        let size = fitted(frame: frame, in: container)
        guard size.width > 0 else {
            return ScreenFit(size: size, topAligned: true, startZoom: 1, maxZoom: maximumZoom, doubleTapZoom: doubleTapZoom)
        }
        let shrink = size.width / container.width
        let startZoom = !landscape && shrink < minimumShrink ? container.width / size.width : 1
        // Zoomed in from the start: pinch up to twice that, and double-tap goes back to it.
        return ScreenFit(
            size: size, topAligned: true, startZoom: startZoom,
            maxZoom: max(maximumZoom, startZoom * 2), doubleTapZoom: max(doubleTapZoom, startZoom)
        )
    }

    /// M20b: a frame in a fixed box (the chat's live browser card and the computer page's 16:10
    /// preview): it fills the box, top-aligned, centred across, the overflow cropped. A portrait
    /// window is fitted to the box width and loses its bottom, so the tab strip, address bar and
    /// top of the page show; a 16:10 page fills it exactly. The rect is in the box's coordinates.
    static func cardFill(frame: CGSize, in box: CGSize) -> CGRect {
        guard frame.width > 0, frame.height > 0, box.width > 0, box.height > 0 else { return .zero }
        let scale = max(box.width / frame.width, box.height / frame.height)
        let size = CGSize(width: frame.width * scale, height: frame.height * scale)
        return CGRect(x: (box.width - size.width) / 2, y: 0, width: size.width, height: size.height)
    }

    /// A point on the shown frame (0,0 at its top-left) as 0...1 fractions for the server.
    static func fraction(of point: CGPoint, in shown: CGSize) -> ComputerClientMessage.Point? {
        guard shown.width > 0, shown.height > 0 else { return nil }
        let x = min(max(point.x / shown.width, 0), 1)
        let y = min(max(point.y / shown.height, 0), 1)
        return ComputerClientMessage.Point(x: Double(x), y: Double(y))
    }

    /// A one-finger pan over the shown frame as a page scroll in page pixels: dragging up
    /// scrolls the page down, like a touch screen.
    static func scroll(translation: CGSize, shown: CGSize, page: CGSize) -> (dx: Double, dy: Double) {
        guard shown.width > 0, shown.height > 0 else { return (0, 0) }
        let sx = page.width / shown.width
        let sy = page.height / shown.height
        return (Double(-translation.width * sx), Double(-translation.height * sy))
    }
}

/// The keyboard bar's text field as browser input: what was added is typed, what was removed
/// is backspaced (autocorrect replacing a word gives both).
enum ComputerTyping {
    static func messages(from old: String, to new: String) -> [ComputerClientMessage] {
        guard old != new else { return [] }
        let a = Array(old), b = Array(new)
        var common = 0
        while common < a.count, common < b.count, a[common] == b[common] { common += 1 }
        var out = Array(repeating: ComputerClientMessage.key(.backspace), count: a.count - common)
        if common < b.count { out.append(.text(String(b[common...]))) }
        return out
    }
}

// MARK: - Pure logic: what the screens show

enum ComputerPresentation {
    /// The status pill under the mascot in "OpenDuet's computer".
    enum Pill: Hashable, Sendable {
        /// "You're in control"
        case inControl
        /// "Waking OpenDuet's workspace" while the browser is off or starting
        case waking
        /// the run's live status while the assistant works ("Working in your browser")
        case status(StatusKey)
        /// "OpenDuet's own computer" while the assistant isn't doing anything
        case idle
    }

    /// What fills the middle of "OpenDuet's computer".
    enum Body: Hashable, Sendable {
        case loading
        case failed(reason: String)
        /// the server has no computer configured
        case unavailable
        case waking
        case screen
    }

    static func pill(computer: ComputerState?, status: StatusKey?) -> Pill {
        if computer?.controller == .user { return .inControl }
        if let computer, computer.available, computer.browser != .ready { return .waking }
        if let status { return .status(status) }
        return .idle
    }

    static func body(_ view: ComputerViewState) -> Body {
        guard let computer = view.computer else {
            if case .failed(let reason) = view.phase { return .failed(reason: reason) }
            return .loading
        }
        if !computer.available { return .unavailable }
        if computer.browser != .ready { return .waking }
        return .screen
    }

    /// Take over is offered once the screen is there; Hand back whenever the user drives.
    static func canToggleControl(_ view: ComputerViewState) -> Bool {
        if view.isBusy { return false }
        if view.isUserInControl { return true }
        return body(view) == .screen
    }
}

/// The sign-in card's look (L141), from its payload, this session's answer and the tap.
/// M20: the card goes on to a code step when the site asks for one, and closes as "You took
/// control" or "Not now". Failure reasons arrive as Phrases and are rendered by the caller.
enum SignInCardPhase: Hashable, Sendable {
    /// email + password
    case form
    case sending
    case sent
    /// M20: the one-time code field; `reason` = why the last code didn't work (rendered)
    case code(reason: String?)
    /// `reason` rendered (nil = the card's generic line); `takeControl`: the main action is
    /// "Take control" instead of Retry (the sign-in moved to another site or page)
    case failed(reason: String?, takeControl: Bool = false)
    case expired
    /// M20: closed by "Take control instead"
    case takenOver
    /// M20: closed by "Not now"
    case dismissed

    /// Failures that Retry can't fix: the user signs in themselves.
    static let takeControlReasons: Set<String> = ["signin.moved", "signin.wrong_page"]

    var isClosed: Bool { self == .expired || self == .takenOver || self == .dismissed }

    /// Pre-M20 call (states only), kept for older callers and tests.
    static func resolve(
        payload: SignInPayload.State,
        answer: SignInCardResponse.State?,
        request: CardRequest?
    ) -> SignInCardPhase {
        resolve(
            payload: SignInPayload(requestId: "", domain: "", state: payload),
            answer: answer.map { SignInCardResponse(requestId: "", state: $0) },
            request: request,
            render: { _ in nil }
        )
    }

    /// - answer: this session's latest answer for the card (`answer(state:full:)`)
    /// - afterCode: the card's last send was a code; a "sent" answer then means signed in. The
    ///   server answers signed in with step "credentials"; this also covers one that said "code"
    /// - render: a server Phrase as text (PhraseText.string in the app)
    static func resolve(
        payload: SignInPayload,
        answer: SignInCardResponse?,
        request: CardRequest?,
        afterCode: Bool = false,
        render: (Phrase) -> String?
    ) -> SignInCardPhase {
        if request == .inFlight { return .sending }
        if payload.state == .expired || answer?.state == .expired {
            switch answer?.outcome ?? payload.outcome {
            case .takenOver: return .takenOver
            case .dismissed: return .dismissed
            case nil: return .expired
            }
        }
        if payload.state == .sent { return .sent }
        if case .failed(let reason) = request { return .failed(reason: reason) }
        if let answer, answer.state == .sent {
            return answer.step == .code && !afterCode ? .code(reason: nil) : .sent
        }
        if let answer, answer.state == .failed { return failure(answer.reason, render: render) }
        if payload.state == .failed { return failure(payload.reason, render: render) }
        if payload.step == .code { return .code(reason: payload.reason.flatMap(render).flatMap { $0.isEmpty ? nil : $0 }) }
        return .form
    }

    /// Which form Retry shows again: the code field once the site asked for one.
    static func retryStep(payload: SignInPayload, answer: SignInCardResponse?) -> SignInStep {
        answer?.step == .code || payload.step == .code ? .code : .credentials
    }

    /// The session's answer for a card: the full one while it matches the state the store keeps
    /// (an expired 404 / 410 only sets the state), else just that state.
    static func answer(state: SignInCardResponse.State?, full: SignInCardResponse?) -> SignInCardResponse? {
        guard let state else { return nil }
        if let full, full.state == state { return full }
        return SignInCardResponse(requestId: full?.requestId ?? "", state: state)
    }

    private static func failure(_ reason: Phrase?, render: (Phrase) -> String?) -> SignInCardPhase {
        let text = reason.flatMap(render).flatMap { $0.isEmpty ? nil : $0 }
        let takeControl = reason?.key.map { takeControlReasons.contains($0) } ?? false
        return .failed(reason: text, takeControl: takeControl)
    }
}

/// The round letter badge that stands in for a site's favicon (nothing is fetched from the
/// public internet): the first letter of the site's name ("accounts.google.com" -> "G").
enum SiteMonogram {
    static func letter(for domain: String) -> String {
        let host = domain.lowercased()
            .split(separator: "/").first.map(String.init) ?? ""
        var labels = host.split(separator: ".").map(String.init).filter { !$0.isEmpty }
        if labels.first == "www" { labels.removeFirst() }
        var name = labels.first ?? host
        if labels.count >= 2 {
            name = labels[labels.count - 2]
            // "bbc.co.uk": a short second-level label under a two-letter country code
            if labels.count >= 3, labels[labels.count - 1].count == 2, name.count <= 3 { name = labels[labels.count - 3] }
        }
        guard let first = name.first(where: { $0.isLetter || $0.isNumber }) else { return "?" }
        return String(first).uppercased()
    }
}

// MARK: - Pure logic: files

/// A file's type for its glyph and its preview (Quick Look, or the app's WKWebView for HTML).
enum FileKind: Hashable, Sendable {
    case pdf, image, text, csv, document, spreadsheet, presentation, html, archive, other

    init(mime: String, name: String) {
        let mime = mime.lowercased()
        let ext = (name as NSString).pathExtension.lowercased()
        switch (mime, ext) {
        case ("application/pdf", _), (_, "pdf"): self = .pdf
        case (let m, _) where m.hasPrefix("image/"): self = .image
        case ("text/html", _), ("application/xhtml+xml", _), (_, "html"), (_, "htm"): self = .html
        case ("text/csv", _), (_, "csv"): self = .csv
        case (let m, _) where m.contains("spreadsheet") || m.contains("ms-excel"): self = .spreadsheet
        case (_, "xlsx"), (_, "xls"), (_, "numbers"): self = .spreadsheet
        case (let m, _) where m.contains("presentation") || m.contains("powerpoint"): self = .presentation
        case (_, "pptx"), (_, "ppt"), (_, "key"): self = .presentation
        case (let m, _) where m.contains("wordprocessing") || m == "application/msword" || m == "application/rtf": self = .document
        case (_, "docx"), (_, "doc"), (_, "rtf"), (_, "pages"): self = .document
        case (let m, _) where m.contains("zip") || m.contains("tar") || m.contains("gzip"): self = .archive
        case (let m, _) where m.hasPrefix("text/") || m == "application/json": self = .text
        case (_, "md"), (_, "txt"), (_, "json"): self = .text
        default: self = .other
        }
    }

    /// HTML renders in the app's own WKWebView; everything else goes to Quick Look.
    var usesWebView: Bool { self == .html }

    var glyph: String {
        switch self {
        case .pdf: "doc.richtext"
        case .image: "photo"
        case .text: "doc.plaintext"
        case .csv, .spreadsheet: "tablecells"
        case .document: "doc.text"
        case .presentation: "rectangle.on.rectangle"
        case .html: "globe"
        case .archive: "doc.zipper"
        case .other: "doc"
        }
    }
}

/// Names for the temporary copies Quick Look, the web view and Share read.
enum FileNaming {
    /// A safe single path component that keeps the extension Quick Look needs (adds one from
    /// the mime type when the name has none).
    static func localName(_ name: String, mime: String) -> String {
        let forbidden = CharacterSet(charactersIn: "/\\:\u{0}").union(.controlCharacters)
        var safe = String(String.UnicodeScalarView(name.unicodeScalars.filter { !forbidden.contains($0) }))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        while safe.hasPrefix(".") { safe.removeFirst() }
        if safe.isEmpty { safe = "file" }
        if safe.count > 120 {
            let ext = (safe as NSString).pathExtension
            let stem = String((safe as NSString).deletingPathExtension.prefix(100))
            safe = ext.isEmpty ? stem : "\(stem).\(ext)"
        }
        if (safe as NSString).pathExtension.isEmpty, let ext = fileExtension(mime: mime) {
            safe += ".\(ext)"
        }
        return safe
    }

    static func fileExtension(mime: String) -> String? {
        switch mime.lowercased().split(separator: ";").first.map({ $0.trimmingCharacters(in: .whitespaces) }) ?? "" {
        case "application/pdf": "pdf"
        case "image/png": "png"
        case "image/jpeg": "jpg"
        case "image/gif": "gif"
        case "image/webp": "webp"
        case "image/heic": "heic"
        case "text/plain": "txt"
        case "text/markdown": "md"
        case "text/csv": "csv"
        case "text/html": "html"
        case "application/json": "json"
        case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx"
        case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx"
        case "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx"
        case "application/msword": "doc"
        case "application/vnd.ms-excel": "xls"
        case "application/vnd.ms-powerpoint": "ppt"
        case "application/zip": "zip"
        default: nil
        }
    }

    /// The file name of a Content-Disposition header (filename* first, then filename).
    static func dispositionName(_ header: String?) -> String? {
        guard let header else { return nil }
        let parts = header.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
        if let star = parts.first(where: { $0.lowercased().hasPrefix("filename*=") }) {
            let value = String(star.dropFirst("filename*=".count))
            let encoded = value.range(of: "''").map { String(value[$0.upperBound...]) } ?? value
            if let decoded = encoded.trimmingCharacters(in: CharacterSet(charactersIn: "\"")).removingPercentEncoding, !decoded.isEmpty {
                return decoded
            }
        }
        if let plain = parts.first(where: { $0.lowercased().hasPrefix("filename=") }) {
            let value = String(plain.dropFirst("filename=".count)).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            return value.isEmpty ? nil : value
        }
        return nil
    }
}

enum FileLists {
    /// A file that just arrived (a file card, an attachment) joins a loaded list at the top,
    /// or replaces the copy already in it. M26: a deleted one (deletedAt set, from the `message`
    /// event its delete sent) leaves the list instead.
    static func upsert(_ file: ChannelFile, into files: [ChannelFile]) -> [ChannelFile] {
        var files = files
        if file.isDeleted {
            files.removeAll { $0.id == file.id }
            return files
        }
        if let index = files.firstIndex(where: { $0.id == file.id }) {
            files[index] = file
            return files
        }
        files.append(file)
        return sorted(files)
    }

    /// Newest first (ties keep the server's order).
    static func sorted(_ files: [ChannelFile]) -> [ChannelFile] {
        files.enumerated().sorted { a, b in
            a.element.createdAt != b.element.createdAt ? a.element.createdAt > b.element.createdAt : a.offset < b.offset
        }.map(\.element)
    }

    /// The files a message carries (file / image cards, composer attachments).
    static func files(in message: Message) -> [ChannelFile] {
        switch message.content {
        case .file(let payload), .image(let payload): [payload.file]
        case .text(let payload): payload.attachments
        default: []
        }
    }
}

/// HTML files render in the app's own web view from the bytes the app downloaded: no
/// JavaScript, and a Content-Security-Policy so nothing loads from the network either.
enum HTMLPreview {
    static let policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:"

    static func harden(_ html: String) -> String {
        let meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\">"
        // "<head>" or "<head ...>", never "<header>"
        if let head = html.range(of: "<head(\\s[^>]*)?>", options: [.regularExpression, .caseInsensitive]) {
            var out = html
            out.insert(contentsOf: meta, at: head.upperBound)
            return out
        }
        return meta + html
    }
}

// MARK: - Pure logic: the stream socket

enum ComputerSocket {
    static let path = "/api/computer/stream"

    /// ws:// for an http server, wss:// for https (the same host, port and base path).
    static func url(from http: URL) -> URL? {
        guard var parts = URLComponents(url: http, resolvingAgainstBaseURL: false) else { return nil }
        switch parts.scheme?.lowercased() {
        case "https": parts.scheme = "wss"
        case "http": parts.scheme = "ws"
        case "wss", "ws": break
        default: return nil
        }
        return parts.url
    }
}
