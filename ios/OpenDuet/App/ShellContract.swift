// The seam between the data layer (Networking/, Session/, Stores/, SignIn/, App/ - "iOS-A") and the
// shell + chat UI (Shell/, Chat/ - "iOS-B"). Owned by the main agent; change it only through a
// handoff request. The UI renders these values and calls these actions; it never talks to the
// network. The stores produce these values from the server's events; they never build views.
import Foundation
import SwiftUI

// MARK: - State the UI renders

/// Everything the main shell shows. Built by the stores on the main actor.
struct ShellState: Hashable, Sendable {
    /// header right circle: PersonNameComponentsFormatter monogram source; nil = person glyph
    var userName: String?
    /// live status for the pill + mascot morph; nil = idle (pill hidden in the main thread)
    var status: StatusKey?
    var connection: ConnectionState = .online
    /// red badge on ≡ (M4) and on the Tasks tab (M3); 0 hides it
    var unreadChannels = 0
    var tasksNeedingUser = 0
    var thread = ThreadState()
    /// M16: the channel `thread` belongs to (the main channel for Everything); the thread view
    /// takes a new identity when it changes, so scroll state starts over at the bottom
    var threadChannelId = ""
    var composer = ComposerState()
    /// M3 (TasksContract.swift): the Tasks tab, the open task detail (nil = none) and the
    /// in-flight / failed card taps by message id
    var tasks = TasksState()
    var taskDetail: TaskDetailState?
    var cardRequests: CardRequests = [:]
    /// M4 (AccountContract.swift): the side menu and the selected channel, the OpenDuet sheet, the
    /// open connector detail (nil = none), the OAuth page to show, the profile sheet, the Usage
    /// screen and which store-driven sheet is up (nil = none)
    var menu = MenuState()
    var assistant = AssistantAccessState()
    var connectorDetail: ConnectorDetailState?
    var oauth: PendingOAuth?
    var profile = ProfileState()
    var usageScreen = UsageScreenState()
    var presented: ShellPresentation?
    /// the tab on screen, as the UI last reported it (actions.tabChanged)
    var tab: ShellTab = .chat
    /// the store wants the UI to switch to a tab (route / notification tap); nil = none yet
    var tabRequest: ShellTabRequest?
    /// M6 (ComputerContract.swift): the assistant's computer and files from the assistant
    var computer = ComputerViewState()
    var files = FilesState()
    /// M6 (MakeContract.swift): the Make tab and its viewers, and the chat extras (/ skills)
    var make = MakeState()
    var chatExtras = ChatExtrasState()
    /// M9: a short line the shell floats for a moment when what the user had open went away
    /// (a deleted task's detail closed, a deleted channel fell back to Everything); nil = none
    var notice: ShellNotice?
    /// M12: the session's user has a usable default model (Me.features.models). While false the
    /// composer shows "No model set up yet · Set up".
    var modelsConfigured = true
}

/// M9: "Task deleted" / "Channel deleted", floated ShellNotice.seconds by the shell host.
struct ShellNotice: Hashable, Sendable, Identifiable {
    enum Kind: Hashable, Sendable { case taskDeleted, channelDeleted }
    var kind: Kind
    var id = UUID()

    /// How long it stays.
    static let seconds: Double = 2.6
}

/// "Can't reach your server · Retrying" bar under the header while offline (L184).
enum ConnectionState: Hashable, Sendable { case online, offline }

struct ThreadState: Hashable, Sendable {
    enum Phase: Hashable, Sendable {
        /// first load: skeleton bubbles
        case loading
        case loaded
        /// first load failed: inline grey line with the reason + Retry (never an alert)
        case failed(reason: String)
    }
    var phase: Phase = .loading
    /// oldest first, as the server sent them (upserted by id from `message` events)
    var messages: [Message] = []
    /// typed while offline or not yet echoed by the server (clock badge while waiting)
    var pending: [PendingMessage] = []
    /// three-dot typing indicator under the last message
    var typing = false
    /// small grey status bubble ("Checking", "Reading now") while a run works, nil otherwise
    var statusBubble: StatusKey?
    /// the "New" wavy divider goes above the first message after this time; nil = none
    var lastReadAt: Date?
    var hasMoreBefore = false
    var loadingOlder = false
    /// picks the composer placeholder: "Message OpenDuet" / "Message #name" / "Reply to OpenDuet"
    var context: ThreadContext = .main
    /// Edits by chat (L163, L182): message id -> what changed in its latest version. When an
    /// entry's version grows, the UI scrolls that card into view and glows the fields ~3 s.
    var edits: [String: CardEdit] = [:]
    /// M21: a link or notification named this message (?message=): the UI scrolls to it once its
    /// row is there and calls ShellActions.focusShown; nil = none.
    var focus: ThreadFocus?
}

/// M21: the message a deep link scrolls a thread to (RouteFocus, set by the store).
struct ThreadFocus: Hashable, Sendable {
    var messageId: String
    /// a new tap on the same link scrolls again
    var token: UUID
}

struct CardEdit: Hashable, Sendable {
    /// the approval version that introduced the change
    var version: Int
    /// preview field names from Approval.changedFields ("subject", "body", "to" ...)
    var fields: [String]
}

enum ThreadContext: Hashable, Sendable {
    case main
    case channel(name: String)
    case task
}

struct PendingMessage: Hashable, Sendable, Identifiable {
    enum State: Hashable, Sendable { case waiting, sending, failed }
    var clientId: String
    var text: String
    var attachments: [ChannelFile]
    var createdAt: Date
    var state: State
    /// M8: the quoted assistant message (SendMessageRequest.replyTo), shown above the bubble.
    var replyTo: ReplyQuote? = nil
    var id: String { clientId }
}

/// M8 (swipe right on an assistant bubble): the message the next send quotes. The excerpt is the
/// app's own plain-text cut for the chip and the pending bubble; the server stores its own.
struct ReplyQuote: Hashable, Sendable {
    var messageId: String
    var excerpt: String
}

struct ComposerState: Hashable, Sendable {
    /// M8: the quote chip above the composer ("Replying to OpenDuet"); the next send carries it.
    var replyTo: ReplyQuote?
    var attachments: [ComposerAttachment] = []
    /// M10: the assistant is replying in this thread (typing or a run in flight) and no stop is pending:
    /// with nothing typed, the waveform turns into ■ (stop responding).
    var replying = false
    /// M10: why the last stop failed, shown by the composer for a moment (nil = none; a 409 is silent).
    var stopFailure: String?
    /// false while any attachment is still uploading or failed
    var canSendAttachments: Bool {
        attachments.allSatisfy { if case .uploaded = $0.upload { true } else { false } }
    }
}

struct ComposerAttachment: Hashable, Sendable, Identifiable {
    enum Upload: Hashable, Sendable {
        /// 0...1, drives the progress ring on the thumbnail
        case uploading(progress: Double)
        case uploaded(ChannelFile)
        /// inline reason under the thumbnail with Retry (e.g. too large, unsupported type)
        case failed(reason: String)
    }
    var id: UUID
    var name: String
    var mime: String
    /// local thumbnail (image data or a file-type glyph is drawn by the UI when nil)
    var thumbnail: Data?
    var upload: Upload
}

/// A file the user picked in the composer (Photos, Camera or Files), before upload.
struct PickedFile: Sendable {
    var name: String
    var mime: String
    var data: Data
}

// MARK: - Actions the UI calls

@MainActor
struct ShellActions {
    /// Send: the UI clears its draft and scrolls to the bottom right away; the store echoes a
    /// PendingMessage until the server's message (matching clientId) replaces it.
    var send: (_ text: String, _ attachmentIds: [UUID]) -> Void = { _, _ in }
    /// M8: swipe right on an assistant bubble sets the composer's quote; its ✕ clears it (nil).
    /// The next `send` carries it as SendMessageRequest.replyTo and clears it.
    var setReplyTo: (_ quote: ReplyQuote?) -> Void = { _ in }
    var addAttachments: (_ files: [PickedFile]) -> Void = { _ in }
    var removeAttachment: (_ id: UUID) -> Void = { _ in }
    var retryAttachment: (_ id: UUID) -> Void = { _ in }
    var retryPending: (_ clientId: String) -> Void = { _ in }
    /// M10: ■ in the composer: stop the assistant's reply in this thread (the main thread or the
    /// selected channel: POST /api/channels/:id/stop). The typing goes at once; a 409 is silent,
    /// other failures set ComposerState.stopFailure. Task detail points it at `stopTask`.
    var stop: () -> Void = {}
    /// M10: the open task's own session (POST /api/tasks/:id/stop), same rules.
    var stopTask: () -> Void = {}
    var reloadThread: () -> Void = {}
    var loadOlder: () -> Void = {}
    /// tapping a quick-reply chip sends its text (SendMessageRequest.quickReply)
    var quickReply: (_ messageId: String, _ option: String) -> Void = { _, _ in }
    /// the thread became visible / scrolled to the bottom
    var markRead: () -> Void = {}
    /// in-app duet:// links (tasks, channels, files...); http(s) links open in a Safari sheet in the UI
    var openRoute: (_ url: URL) -> Void = { _ in }
    /// M21: the thread scrolled to ThreadState.focus (its token): the store forgets the focus
    var focusShown: (_ token: UUID) -> Void = { _ in }
    /// long-press on the initials circle replays onboarding locally (L35/L77)
    var restartOnboarding: () -> Void = {}
    /// ≡: the UI slides the side menu in itself and calls `menu.refresh` (M4)
    var openMenu: () -> Void = {}
    /// centre mascot (OpenDuet sheet), initials tap (profile) and the usage-limit line's
    /// "Get more usage" (Usage screen): set ShellState.presented (M4)
    var openAssistant: () -> Void = {}
    var openProfile: () -> Void = {}
    var openUsage: () -> Void = {}
    /// M12: the settings' Models page ("No model set up yet · Set up", a model_error card's Set up
    /// models); M16: the settings are the profile sheet
    var openModels: () -> Void = {}
    /// M16: the settings' Voice page (a voice call's "Set up")
    var openVoice: () -> Void = {}
    /// M3 (TasksContract.swift)
    var tasks = TaskActions()
    var cards = CardActions()
    /// M4 (AccountContract.swift)
    var menu = MenuActions()
    var connectors = ConnectorActions()
    var account = AccountActions()
    /// the UI switched tabs (also after applying a tabRequest): notification and refresh rules
    /// depend on what's on screen
    var tabChanged: (_ tab: ShellTab) -> Void = { _ in }
    /// M6 (ComputerContract.swift, MakeContract.swift)
    var computer = ComputerActions()
    var files = FileActions()
    var make = MakeActions()
    var chatExtras = ChatExtrasActions()
    /// M11: a connection_request card's Connect (api_key / mcp): POST /api/messages/:id/connect
    /// with what the user typed (cardRequests[messageId]). The values go straight into the request
    /// and are never kept; a 400 leaves the server's reason as `.failed`, success upserts the card.
    /// Undo / Apply / Not now go through `cards.action`; an app card's Connect is `connectors.connect`.
    var submitConnection: (_ messageId: String, _ body: ConnectRequestSubmit) -> Void = { _, _ in }
}

// MARK: - Authenticated loading (L172)

/// Image bubbles and thumbnails load through the signed-in session, never a public URL.
protocol AuthenticatedLoading: Sendable {
    /// `path` is a server-relative path such as ChannelFile.url ("/api/files/<id>/content")
    func data(for path: String) async throws -> Data
}

private struct UnavailableLoader: AuthenticatedLoading {
    func data(for path: String) async throws -> Data { throw URLError(.userAuthenticationRequired) }
}

extension EnvironmentValues {
    /// Set by RootView to the signed-in API client; previews get a loader that always fails.
    @Entry var authenticatedLoader: any AuthenticatedLoading = UnavailableLoader()
}
