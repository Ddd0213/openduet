// M4 additions to the data <-> UI seam (see ShellContract.swift, TasksContract.swift): the side
// menu and channels, the OpenDuet sheet and connectors, the profile sheet, the Usage screen and the
// onboarding's real data. Owned by the main agent; change it only through a handoff request.
//
// Presentation: the assistant / profile / usage sheets follow `ShellState.presented` and the
// connector detail sheet follows `ShellState.connectorDetail`, so alert cards, duet:// links and
// notification taps can open them too. The side menu's slide-in, the New channel sheet and
// pushes inside a sheet (profile > Usage, profile > Memory) stay local to the UI.
import Foundation

// MARK: - Side menu and channels (L124, L125)

struct MenuState: Hashable, Sendable {
    /// the non-archived channels other than the main thread, in the server's order; the main
    /// thread is the menu's "Everything" row
    var channels: [Channel] = []
    /// "Archived": nil until the user opens it (GET /api/channels?archived=true)
    var archived: [Channel]?
    /// loading "Archived" failed: inline grey reason + Retry (calls loadArchived again)
    var archivedError: String?
    /// nil = Everything (the main thread); otherwise the channel the chat and the Tasks tab are on
    var selectedChannelId: String?

    /// the header pill's icon + "#name" and the composer's "Message #name"; nil in the main thread
    var selected: Channel? { channels.first { $0.id == selectedChannelId } }
}

// MARK: - OpenDuet sheet and connectors (L126, L127, L167, L168)

struct AssistantAccessState: Hashable, Sendable {
    /// false when the server has no COMPOSIO_API_KEY: the rows say "isn't set up yet"
    var configured = true
    var phase: TasksState.Phase = .loading
    /// "What OpenDuet has access to" in display order: Files and docs, Mail, Calendar, Team chat,
    /// Payments. ("OpenDuet's computer" joins in M6.)
    var rows: [AccessRow] = []
    /// "More apps ›": the catalog (connected first) for the current search text
    var catalog: [Connector] = []
    var query = ""
}

struct AccessRow: Hashable, Sendable, Identifiable {
    var category: AccessCategory
    /// connected connectors of this category ("Reads your Gmail"); empty = "Can't see your mail yet"
    var connected: [Connector]
    /// what the dashed "+" connects while nothing is connected (the first catalog connector of
    /// the category, e.g. Gmail for Mail); nil = the "+" opens More apps instead
    var suggested: Connector?
    var id: AccessCategory { category }
}

struct ConnectorDetailState: Hashable, Sendable {
    var toolkit: String
    var phase: TasksState.Phase = .loading
    /// logo, name, description and the accounts card (real email addresses); nil until loaded
    var connector: Connector?
    /// Read (Always) group first, then Write (Ask); common tools first in each group (L167)
    var tools: [ConnectorTool] = []

    /// "All tools" picker: the mode every tool shares, nil = "Custom"
    var allMode: PolicyMode? {
        guard let first = tools.first?.mode else { return nil }
        return tools.allSatisfy { $0.mode == first } ? first : nil
    }
}

/// A hosted Composio OAuth page for ASWebAuthenticationSession (L127). The store sets it after
/// POST /api/connectors/:toolkit/connect; `OAuthPresenter` shows it once per id and reports the
/// result, after which the store clears it and refreshes the connections.
struct PendingOAuth: Hashable, Sendable, Identifiable {
    var id: UUID
    var toolkit: String
    var url: URL
    var callbackScheme: String
}

// MARK: - Profile sheet and Usage screen (L128, L129, L166)

struct ProfileState: Hashable, Sendable {
    /// name / email at the top; briefTime and weekendsOn for Notifications
    var user: CurrentUser?
    /// nil until checked; false = notifications are off for the app in iOS Settings
    var notificationsAllowed: Bool?
    /// Memory: view and edit the memory document (loaded when that page opens)
    var memoryPhase: TasksState.Phase = .loading
    var memory: MemoryState?
}

struct UsageScreenState: Hashable, Sendable {
    var phase: TasksState.Phase = .loading
    /// GET /api/usage, then live from `usage` events
    var usage: UsageState?
    /// refresh button in flight (the bars keep showing the last values)
    var refreshing = false
    /// M9: the Usage panel (GET /api/usage/stats). The range the panel shows; its stats load
    /// through AccountActions.loadUsageStats and stay cached per range for the session.
    var range: UsageRange = .sevenDays
    var stats: [UsageRange: UsageStats] = [:]
    /// per range: .loading until the first answer, .failed(reason) for the inline Retry line
    var statsPhase: [UsageRange: TasksState.Phase] = [:]
}

/// Sheets the store can present: the centre mascot (the assistant), the initials (profile) and the
/// usage-limit line / alert open_usage (Usage on its own; from the profile it is a push).
enum ShellPresentation: Hashable, Sendable {
    case assistant, profile, usage
    /// M12: "Set up models": the settings (the profile sheet, M16) opened at its Models page
    case models
    /// M16: the voice call's "Set up voice": the settings opened at its Voice page
    case voice
}

/// M11: which OpenDuet sheet `.assistant` shows. It follows the thread on screen: Everything (the main
/// thread) opens the configuration centre, a channel opens that channel's own sheet.
enum AssistantSheetRoute: Hashable, Sendable {
    case everything
    case channel(Channel)

    init(menu: MenuState) {
        if menu.selectedChannelId != nil, let channel = menu.selected {
            self = .channel(channel)
        } else {
            self = .everything
        }
    }
}

// MARK: - Tabs

/// The tab bar's tabs (Make arrives in M6; a pinned artifact becomes a 4th tab there).
/// `pinned` (M6): the artifact added to the tab bar (MakeState.pinned), the 4th tab.
enum ShellTab: Hashable, Sendable { case chat, tasks, make, pinned }

/// The store asks the UI to switch tabs (a notification or duet:// link to a channel -> Chat; a
/// task detail opens over whatever tab is showing). A new `id` each time, so asking for the same
/// tab twice still switches back.
struct ShellTabRequest: Hashable, Sendable {
    var id: UUID
    var tab: ShellTab
}

// MARK: - Tasks > Scheduled (L118)

struct ScheduleState: Hashable, Sendable {
    var phase: TasksState.Phase = .loading
    /// Morning brief and Check-in rows with their run history; nil until loaded
    var info: ScheduleInfo?
}

// MARK: - Request keys

extension ShellState {
    /// `cardRequests` keys for M4 taps (the M3 keys are described in TasksContract.swift).
    enum RequestKey {
        static let createChannel = "channel:create"
        static let saveMemory = "memory:save"
        static let saveProfile = "profile:save"
        static let fullReset = "usage:reset"
        static let feedback = "feedback:send"
        static func connect(_ toolkit: String) -> String { "connect:\(toolkit)" }
        /// one tool, or "All tools" when tool is nil
        static func policy(_ toolkit: String, tool: String?) -> String { "policy:\(toolkit):\(tool ?? "*")" }
        static func disconnect(_ accountId: String) -> String { "disconnect:\(accountId)" }
        static func archive(_ channelId: String) -> String { "archive:\(channelId)" }
        static func runNow(_ kind: RunNowRequest.Kind) -> String { "schedule:\(kind.rawValue)" }
        // M9
        static func updateChannel(_ channelId: String) -> String { "channel:update:\(channelId)" }
        static func deleteChannel(_ channelId: String) -> String { "channel:delete:\(channelId)" }
        static func deleteTask(_ taskId: String) -> String { "task:delete:\(taskId)" }
        static func pinTask(_ taskId: String) -> String { "task:pin:\(taskId)" }
        /// a routine's Run now / Pause / Resume / time or title change
        static func routine(_ taskId: String) -> String { "routine:\(taskId)" }
        /// a routine sheet's history (GET /api/tasks/:id/runs): skeleton while in flight, the
        /// reason with Retry on failure
        static func routineRuns(_ taskId: String) -> String { "routine:runs:\(taskId)" }
        /// long-press Mark as read on a channel row (a failure shows under the row)
        static func markRead(_ channelId: String) -> String { "channel:read:\(channelId)" }
        /// long-press Delete on a file row (FileActions.delete)
        static func deleteFile(_ fileId: String) -> String { "file:delete:\(fileId)" }
    }
}

// MARK: - Onboarding with real data (L77)

/// Read by OnboardingFlow: page 2's chips (GET /api/onboarding) and page 5's Slack row, whose
/// "+" starts a real Composio connection through the same PendingOAuth flow.
struct OnboardingDataState: Hashable, Sendable {
    var chips: [OnboardingInfo.Chip] = []
    var slackConnected = false
    /// POST connect / the OAuth page in progress (the "+" shows a small spinner)
    var slackConnecting = false
    var oauth: PendingOAuth?
}

@MainActor
struct OnboardingActions {
    var connectSlack: () -> Void = {}
    var oauthFinished: (_ id: UUID, _ callback: URL?) -> Void = { _, _ in }
    /// After the celebration. The first time: POST /api/onboarding/complete (the assistant's welcome
    /// and the first-day scan arrive as events). A local replay (long-press) never posts again.
    var finish: () -> Void = {}
}

// MARK: - Actions the UI calls

@MainActor
struct MenuActions {
    /// the menu opened: refresh the channels and their unread counts
    var refresh: () -> Void = {}
    /// nil = Everything. Switches the chat thread and the Tasks scope; the UI closes the menu.
    var select: (_ channelId: String?) -> Void = { _ in }
    /// "Archived": fills MenuState.archived
    var loadArchived: () -> Void = {}
    /// New channel sheet's Create (cardRequests[RequestKey.createChannel]). On success the
    /// store selects the new channel (its thread then shows the assistant's hello) and clears the
    /// request; the UI dismisses the sheet when the request goes away without failing.
    var create: (_ name: String, _ purpose: String, _ icon: ChannelIcon, _ color: ChannelColor) -> Void = { _, _, _, _ in }
    /// M11: the New channel flow's Create after "What can OpenDuet use here?": the same request and
    /// rules as `create`, plus the picked skills / connectors / apps (CreateChannelRequest.access)
    /// and greet true (the assistant's greeting then arrives over events).
    var createWithAccess: (_ name: String, _ purpose: String, _ icon: ChannelIcon, _ color: ChannelColor, _ access: [AccessRef]) -> Void = { _, _, _, _, _ in }
    /// Archive / Unarchive (cardRequests[RequestKey.archive(id)])
    var setArchived: (_ channelId: String, _ archived: Bool) -> Void = { _, _ in }
    /// M9: long-press Edit (the New channel sheet in edit mode): PATCH name / purpose / icon /
    /// colour (cardRequests[RequestKey.updateChannel(id)]); the UI dismisses on success
    var update: (_ channelId: String, _ name: String, _ purpose: String, _ icon: ChannelIcon, _ color: ChannelColor) -> Void = { _, _, _, _, _ in }
    /// M9: long-press Delete, after the in-place confirmation (cardRequests[RequestKey.deleteChannel(id)]).
    /// The channel leaves the menu on channel_deleted; a selected channel falls back to Everything.
    var delete: (_ channelId: String) -> Void = { _ in }
    /// M9: long-press Mark as read (POST /api/channels/:id/read with now)
    var markRead: (_ channelId: String) -> Void = { _ in }
}

@MainActor
struct ConnectorActions {
    /// the OpenDuet sheet or profile > Connected apps appeared
    var refresh: () -> Void = {}
    /// "More apps" search field (the store debounces)
    var search: (_ query: String) -> Void = { _ in }
    var openDetail: (_ toolkit: String) -> Void = { _ in }
    var closeDetail: () -> Void = {}
    /// dashed "+" and "+ Add account": POST connect, then ShellState.oauth
    var connect: (_ toolkit: String) -> Void = { _ in }
    /// the OAuth page finished: the callback URL, or nil when cancelled or failed
    var oauthFinished: (_ id: UUID, _ callback: URL?) -> Void = { _, _ in }
    /// Ask / Always for one tool, or "All tools" when tool is nil
    var setPolicy: (_ toolkit: String, _ tool: String?, _ mode: PolicyMode) -> Void = { _, _, _ in }
    /// Disconnect at the bottom of the detail sheet, per account
    var disconnect: (_ toolkit: String, _ accountId: String) -> Void = { _, _ in }
}

@MainActor
struct AccountActions {
    var dismiss: () -> Void = {}
    /// the profile sheet appeared (user, notification permission)
    var refreshProfile: () -> Void = {}
    var loadMemory: () -> Void = {}
    var saveMemory: (_ document: String) -> Void = { _ in }
    /// profile > Notifications: brief time and weekends (PATCH /api/me, RequestKey.saveProfile)
    var updateNotifications: (_ briefTime: LocalTime?, _ weekendsOn: Bool?) -> Void = { _, _ in }
    /// notifications are off in iOS Settings: open the app's Settings page
    var openNotificationSettings: () -> Void = {}
    var refreshUsage: () -> Void = {}
    /// M9: the Usage panel picked a range (or appeared / pulled to refresh): sets
    /// UsageScreenState.range and loads GET /api/usage/stats?range= into stats[range]
    var loadUsageStats: (_ range: UsageRange) -> Void = { _ in }
    /// "Reset for free" (RequestKey.fullReset). M9: the Usage panel no longer shows it.
    var fullReset: () -> Void = {}
    /// profile > Send feedback (RequestKey.feedback); "Thanks for the feedback" arrives in chat
    var sendFeedback: (_ text: String) -> Void = { _ in }
    var signOut: () -> Void = {}
}
