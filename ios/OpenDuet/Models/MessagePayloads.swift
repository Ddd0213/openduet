// The bubble or card of a Message, one case per wire `kind` (MESSAGE_KINDS in
// backend/src/contract/messages.ts). Unknown kinds from a newer server decode as .unsupported
// so one new card never breaks a whole page.
import Foundation

enum MessageContent: Hashable, Sendable {
    case text(TextPayload)
    case file(FilePayload)
    case image(FilePayload)
    case taskSpawn(TaskSpawnPayload)
    case taskSuggestions(TaskSuggestionsPayload)
    case proactiveSuggestion(ProactiveSuggestionPayload)
    case quickReplies(QuickRepliesPayload)
    case approval(Approval)
    case spendRequest(SpendRequest)
    case confirmation(ConfirmationPayload)
    case alert(AlertPayload)
    case plate(PlatePayload)
    case system(Phrase)
    case usageLimit(resumesAt: Date)
    case artifact(ArtifactPayload)
    case liveBrowser(LiveBrowserPayload)
    case signIn(SignInPayload)
    case skillProposal(SkillProposalPayload)
    /// M9: the assistant's question card (ask_form)
    case form(FormPayload)
    /// M9: the assistant's information card (show_card)
    case card(CardPayload)
    /// M11: the "Remembered · Undo" chip (remember / forget)
    case memoryNote(MemoryNotePayload)
    /// M11: "Change how OpenDuet is?" (propose_soul_change)
    case soulProposal(SoulProposalPayload)
    /// M11: request_connection / request_secret (values go to the server's vault)
    case connectionRequest(ConnectionRequestPayload)
    /// M12: a failed turn with Retry / Switch model (or Set up models)
    case modelError(ModelErrorPayload)
    /// A voice call's one line ("Voice call · 3 min"); tapping opens the transcript
    case call(CallPayload)
    /// M22: the end of setting up "who OpenDuet is" in the chat (propose_soul_setup)
    case soulSetup(SoulSetupPayload)
    case unsupported(kind: String)

    init(kind: String, payload: Decoder) throws {
        switch kind {
        case "text": self = .text(try TextPayload(from: payload))
        case "file": self = .file(try FilePayload(from: payload))
        case "image": self = .image(try FilePayload(from: payload))
        case "task_spawn": self = .taskSpawn(try TaskSpawnPayload(from: payload))
        case "task_suggestions": self = .taskSuggestions(try TaskSuggestionsPayload(from: payload))
        case "proactive_suggestion": self = .proactiveSuggestion(try ProactiveSuggestionPayload(from: payload))
        case "quick_replies": self = .quickReplies(try QuickRepliesPayload(from: payload))
        case "approval": self = .approval(try payload.field(Approval.self, "approval"))
        case "spend_request": self = .spendRequest(try payload.field(SpendRequest.self, "spendRequest"))
        case "confirmation": self = .confirmation(try ConfirmationPayload(from: payload))
        case "alert": self = .alert(try AlertPayload(from: payload))
        case "plate": self = .plate(try PlatePayload(from: payload))
        case "system": self = .system(try payload.field(Phrase.self, "phrase"))
        case "usage_limit": self = .usageLimit(resumesAt: try payload.field(Date.self, "resumesAt"))
        case "artifact": self = .artifact(try ArtifactPayload(from: payload))
        case "live_browser": self = .liveBrowser(try LiveBrowserPayload(from: payload))
        case "sign_in": self = .signIn(try SignInPayload(from: payload))
        case "skill_proposal": self = .skillProposal(try SkillProposalPayload(from: payload))
        case "form": self = .form(try FormPayload(from: payload))
        case "card": self = .card(try CardPayload(from: payload))
        case "memory_note": self = .memoryNote(try MemoryNotePayload(from: payload))
        case "soul_proposal": self = .soulProposal(try SoulProposalPayload(from: payload))
        case "connection_request": self = .connectionRequest(try ConnectionRequestPayload(from: payload))
        case "model_error": self = .modelError(try ModelErrorPayload(from: payload))
        case "call": self = .call(try CallPayload(from: payload))
        case "soul_setup": self = .soulSetup(try SoulSetupPayload(from: payload))
        default: self = .unsupported(kind: kind)
        }
    }
}

struct TextPayload: Decodable, Hashable, Sendable {
    /// The quoted message of a swipe-to-reply (M8 contract §2), shown above the user's bubble.
    struct ReplyTo: Decodable, Hashable, Sendable {
        enum Role: String, AssistantValue, Sendable { case user, assistant }
        var messageId: ID
        var role: Role
        /// The first 160 characters of the quoted text, markdown removed.
        var excerpt: String
    }

    /// The /skill the user invoked, if any.
    var skill: String?
    /// Composer attachments; images render as image bubbles.
    var attachments: [ChannelFile]
    /// Older stored payloads have no `replyTo` (nil).
    var replyTo: ReplyTo?
    /// M18: set on the assistant message with a done task's final result (the text); the bubble gets
    /// a footer that opens the task. Older payloads have none (nil).
    var taskResult: TaskResultInfo? = nil
    /// M18: "chat" on a user message the assistant passed on from the chat into a task's thread
    /// (tell_task). Older payloads: nil.
    var forwarded: String? = nil
    /// M23: only on the morning brief's message: the sources it couldn't read. Older payloads: nil.
    var brief: BriefInfo? = nil

    /// M18: shows "From chat" under the user's bubble.
    var isForwardedFromChat: Bool { forwarded == "chat" }
}

extension TextPayload {
    private enum CodingKeys: String, CodingKey { case skill, attachments, replyTo, taskResult, forwarded, brief }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        skill = try c.decodeIfPresent(String.self, forKey: .skill)
        attachments = try c.decode([ChannelFile].self, forKey: .attachments)
        replyTo = try c.decodeIfPresent(ReplyTo.self, forKey: .replyTo)
        // Additive M18 fields: a shape this app doesn't know (say a newer status) drops the
        // footer and keeps the text, instead of failing the whole page.
        taskResult = try? c.decodeIfPresent(TaskResultInfo.self, forKey: .taskResult)
        forwarded = try? c.decodeIfPresent(String.self, forKey: .forwarded)
        brief = try? c.decodeIfPresent(BriefInfo.self, forKey: .brief)
    }
}

/// M18 (backend/src/contract/m18.ts TaskResult): the task behind a result message.
struct TaskResultInfo: Decodable, Hashable, Sendable {
    /// resolved: done, nothing to check; readyForReview: it touched the user's things (an
    /// approval, or a write in one of their apps).
    enum Status: String, Decodable, Sendable {
        case resolved
        case readyForReview = "ready_for_review"
    }
    var taskId: ID
    var title: String
    var status: Status
    /// The task's resources (sources, files, links).
    var sourceCount: Int
}

/// "file" (the assistant's send_file card) and "image" (screenshots and other images).
struct FilePayload: Decodable, Hashable, Sendable {
    var file: ChannelFile
    var caption: String
}

/// The task spawn chip under the user's message, joined by a curved connector.
struct TaskSpawnPayload: Decodable, Hashable, Sendable {
    var task: TaskSummary
    var anchorMessageId: ID?
}

struct TaskSuggestionsPayload: Decodable, Hashable, Sendable {
    struct Item: Decodable, Hashable, Sendable, Identifiable {
        var id: ID
        var title: String
        var prompt: String
        var app: String?
        /// Set once tapped: the card dims and shows a green check.
        var taskId: ID?
        /// M9: the tile's icon the assistant picked; nil = lightbulb
        var icon: CardIcon? = nil
        /// M23: the Up next row for the same item; nil on older cards
        var suggestionId: ID? = nil
    }
    var items: [Item]
}

extension TaskSuggestionsPayload.Item {
    private enum CodingKeys: String, CodingKey { case id, title, prompt, app, taskId, icon, suggestionId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ID.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        prompt = try c.decode(String.self, forKey: .prompt)
        app = try c.decodeIfPresent(String.self, forKey: .app)
        taskId = try c.decodeIfPresent(ID.self, forKey: .taskId)
        icon = try c.decodeIfPresent(CardIcon.self, forKey: .icon)
        suggestionId = try c.decodeIfPresent(ID.self, forKey: .suggestionId)
    }
}

struct ProactiveSuggestionPayload: Decodable, Hashable, Sendable {
    enum State: String, Decodable, Sendable { case open, hidden, started }
    var title: String
    var body: String
    var prompt: String
    var state: State
    var taskId: ID?
    /// M23: the Up next row for the same item (Start / Hide on either updates both); nil on older cards
    var suggestionId: ID? = nil
}

struct QuickRepliesPayload: Decodable, Hashable, Sendable {
    var options: [String]
    var chosen: String?
}

struct ConfirmationPayload: Decodable, Hashable, Sendable {
    var title: String
    var detail: String
    var app: String?
}

/// "One thing needs you" single-action card (also human checks: action open_browser).
struct AlertPayload: Decodable, Hashable, Sendable {
    struct Action: Decodable, Hashable, Sendable {
        enum Kind: String, Decodable, Sendable {
            case openURL = "open_url"
            case openBrowser = "open_browser"
            case openConnector = "open_connector"
            case openUsage = "open_usage"
        }
        var label: Phrase
        var type: Kind
        var url: String?
        var toolkit: String?
    }
    var title: Phrase
    var body: Phrase
    var action: Action
}

/// "Your plate today": a row per item with an outline action pill that sends the action.
struct PlatePayload: Decodable, Hashable, Sendable {
    struct Item: Decodable, Hashable, Sendable, Identifiable {
        struct Action: Decodable, Hashable, Sendable {
            var label: String
            var prompt: String
        }
        var id: ID
        var title: String
        var detail: String
        var action: Action
        var done: Bool
    }
    var items: [Item]
}

struct ArtifactPayload: Decodable, Hashable, Sendable {
    struct Metric: Decodable, Hashable, Sendable {
        var label: String
        var value: Double
        var unit: String?
    }
    var artifact: ArtifactSummary
    /// Live preview, e.g. a 2x2 metric grid.
    var metrics: [Metric]
}

/// Live browser card while the assistant browses (tap opens "OpenDuet's computer").
struct LiveBrowserPayload: Decodable, Hashable, Sendable {
    enum State: String, Decodable, Sendable { case live, ended }
    var domain: String
    var state: State
}

/// Sign-in card: the password goes straight to the computer, never to the model, DB or logs.
struct SignInPayload: Decodable, Hashable, Sendable {
    enum State: String, Decodable, Sendable { case pending, sent, expired, failed }
    var requestId: ID
    var domain: String
    var state: State
    /// M20: the form a pending card shows (missing from an older server = .credentials).
    var step: SignInStep = .credentials
    /// M20: why it failed.
    var reason: Phrase?
    /// M20: how a taken-over or dismissed card ended (state .expired).
    var outcome: SignInCardOutcome?
}

extension SignInPayload {
    private enum CodingKeys: String, CodingKey { case requestId, domain, state, step, reason, outcome }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(ID.self, forKey: .requestId)
        domain = try c.decode(String.self, forKey: .domain)
        state = try c.decode(State.self, forKey: .state)
        step = try c.decodeIfPresent(SignInStep.self, forKey: .step) ?? .credentials
        reason = try c.decodeIfPresent(Phrase.self, forKey: .reason)
        outcome = try? c.decodeIfPresent(SignInCardOutcome.self, forKey: .outcome)
    }
}

struct SkillProposalPayload: Decodable, Hashable, Sendable {
    enum State: String, Decodable, Sendable { case open, saved, dismissed }
    var name: String
    var description: String
    var instructions: String
    var state: State
    var skillId: ID?
}

// MARK: - M11

/// "Remembered · Undo" under the assistant's reply. Undo (action "undo") archives a remembered fact or
/// restores a forgotten one; the chip then reads "Undone".
struct MemoryNotePayload: Decodable, Hashable, Sendable {
    enum Op: String, Decodable, Sendable { case remembered, forgot }
    /// shared = "About you"; channel = this channel's own memory
    enum Scope: String, Decodable, Sendable { case shared, channel }
    enum State: String, Decodable, Sendable { case done, undone }
    var op: Op
    var factId: ID
    var text: String
    var scope: Scope
    var state: State
}

/// propose_soul_change: nothing changes until Apply (action "apply"); Not now = "dismiss".
/// `soulExtra` is this channel's addendum ("Here, OpenDuet also…").
struct SoulProposalPayload: Decodable, Hashable, Sendable {
    enum Field: String, Decodable, Sendable { case name, addressAs, identity, persona, tone, soulExtra }
    enum State: String, Decodable, Sendable { case open, applied, dismissed }
    var field: Field
    var current: String
    var proposed: String
    var reason: String
    var state: State
}

/// request_connection / request_secret. What the user types goes to POST /api/messages/:id/connect
/// (the vault), never into the chat. `app` cards connect through Composio's OAuth for `toolkit`.
struct ConnectionRequestPayload: Decodable, Hashable, Sendable {
    enum Kind: String, Decodable, Sendable {
        case mcp
        case apiKey = "api_key"
        case app
    }
    enum State: String, Decodable, Sendable { case open, connected, dismissed }
    /// One input: api_key has one secret field "key"; mcp one per header.
    struct Field: Decodable, Hashable, Sendable, Identifiable {
        var key: String
        var label: String
        var secret: Bool
        var placeholder: String?
        var id: String { key }
    }
    var type: Kind
    var name: String
    /// why the assistant asks
    var purpose: String
    /// mcp: the server URL
    var url: String?
    /// api_key: the bound domain
    var domain: String?
    /// app: the Composio toolkit slug
    var toolkit: String?
    var headerName: String?
    var valuePrefix: String?
    var fields: [Field]
    var state: State
    /// set once connected
    var connectorId: ID?
    /// M29: who closed a dismissed card (nil: the user's Not now, or a card stored before M29)
    var closedBy: CardCloser? = nil
}

/// M29: who closed a form or connection request card (payload `closedBy`, optional). The
/// assistant withdrawing its card writes "assistant" with state "dismissed"; the user's Skip /
/// Not now writes nothing (or "user"). A value this app doesn't know reads as the user's, never
/// as a decoding error.
enum CardCloser: String, Hashable, Sendable, Decodable {
    case user
    case assistant

    init(from decoder: Decoder) throws {
        let raw = try? decoder.singleValueContainer().decode(String.self)
        self = raw.flatMap(Self.init(rawValue:)) ?? .user
    }
}

extension FormPayload {
    /// M29: dismissed because the assistant withdrew it ("Withdrawn"), not skipped by the user.
    var isWithdrawn: Bool { state == .dismissed && closedBy == .assistant }
}

extension ConnectionRequestPayload {
    /// M29: dismissed because the assistant withdrew it ("Withdrawn"), not the user's Not now.
    var isWithdrawn: Bool { state == .dismissed && closedBy == .assistant }
}
