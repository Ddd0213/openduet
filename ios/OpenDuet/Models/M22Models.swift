// M22 contract (backend/src/contract/m22.ts, tasks.ts NeedsYou, messages.ts group block and
// soul_setup): what a task needs from you, why it failed, Needs you, Setup, and setting up
// "who OpenDuet is" in the chat. Every enum here reads an unknown value from a newer server
// without failing the payload around it.
import Foundation

// MARK: - What a task needs from you

/// TaskSummary.nextStep: the one thing the task waits on the user for, shown on the row in place of
/// the latest update. `messageId`: the card in the task's thread to scroll to.
struct TaskNextStep: Decodable, Hashable, Sendable {
    enum Kind: String, Decodable, Sendable {
        case answer, form, approve, review, retry, reply, connect
        case signIn = "sign_in"
    }
    /// nil: a kind this build doesn't know (the text still shows)
    var kind: Kind?
    var text: Phrase
    var messageId: ID?

    private enum CodingKeys: String, CodingKey { case kind, text, messageId }

    init(kind: Kind?, text: Phrase, messageId: ID? = nil) {
        self.kind = kind
        self.text = text
        self.messageId = messageId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try? c.decode(Kind.self, forKey: .kind)
        text = try c.decode(Phrase.self, forKey: .text)
        messageId = try c.decodeIfPresent(ID.self, forKey: .messageId)
    }
}

/// TaskSummary.failure: the task's last run failed. Try again (POST /api/tasks/:id/retry) only
/// when `retryable`.
struct TaskFailure: Decodable, Hashable, Sendable {
    var reason: Phrase
    var retryable: Bool
    var at: Date
}

/// Routine.pausedBy: "failures" = the fatigue rule paused it after 3 failed runs in a row.
enum RoutinePausedBy: String, Decodable, Sendable {
    case user, failures
}

// MARK: - Needs you

/// GET /api/needs-you: everything waiting on the user; `count` is the Tasks tab badge.
struct NeedsYou: Decodable, Hashable, Sendable {
    var count: Int
    var items: [NeedsYouItem]
}

enum NeedsYouItem: Decodable, Hashable, Sendable {
    /// A card outside any task (approval, form, sign-in, connection request).
    struct Card: Decodable, Hashable, Sendable {
        enum Kind: String, Decodable, Sendable {
            case approval, form, connection
            case signIn = "sign_in"
        }
        var kind: Kind
        var messageId: ID
        var channelId: ID
        var title: String
        var detail: Phrase
        /// duet://channels/<channelId>?message=<messageId>
        var route: String
        var at: Date
    }

    case task(TaskSummary)
    case card(Card)
    /// a kind a newer server added: not shown, still counted in `count`
    case unsupported(kind: String)

    private enum CodingKeys: String, CodingKey { case kind, task }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "task": self = .task(try c.decode(TaskSummary.self, forKey: .task))
        case "approval", "form", "sign_in", "connection": self = .card(try Card(from: decoder))
        default: self = .unsupported(kind: kind)
        }
    }
}

// MARK: - Setup

/// GET /api/setup and POST /api/setup/check: one row per server dependency. The phone's own
/// notification permission is the app's row, not the server's.
struct SetupInfo: Decodable, Hashable, Sendable {
    var items: [SetupItem]
}

struct SetupItem: Decodable, Hashable, Sendable, Identifiable {
    enum Status: String, Decodable, Sendable {
        case ready
        case notChecked = "not_checked"
        case needsSetup = "needs_setup"
    }
    enum Fix: Decodable, Hashable, Sendable {
        /// an in-app page: duet://settings/models | apps | voice, duet://computer
        case route(String)
        /// a server setting (backend/.env names) the app can't change; `hint` says what to do
        case env(names: [String], hint: Phrase)
        case unsupported

        private enum CodingKeys: String, CodingKey { case kind, route, names, hint }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            switch try c.decode(String.self, forKey: .kind) {
            case "route": self = .route(try c.decode(String.self, forKey: .route))
            case "env": self = .env(names: try c.decode([String].self, forKey: .names), hint: try c.decode(Phrase.self, forKey: .hint))
            default: self = .unsupported
            }
        }
    }

    /// model | search | apps | computer | push | voice (kept as text: a newer row still shows)
    var id: String
    /// nil: a status this build doesn't know (shown like not checked)
    var status: Status?
    var required: Bool
    var title: Phrase
    var detail: Phrase
    var fix: Fix?
    var checkedAt: Date?

    private enum CodingKeys: String, CodingKey { case id, status, required, title, detail, fix, checkedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = try? c.decode(Status.self, forKey: .status)
        required = try c.decode(Bool.self, forKey: .required)
        title = try c.decode(Phrase.self, forKey: .title)
        detail = try c.decode(Phrase.self, forKey: .detail)
        fix = try c.decodeIfPresent(Fix.self, forKey: .fix)
        checkedAt = try c.decodeIfPresent(Date.self, forKey: .checkedAt)
    }
}

// MARK: - "Who OpenDuet is" in the chat

/// soul_setup: every field the user chose in the chat, "now → new". Apply (action "apply") writes
/// them all; Not now ("dismiss") changes nothing; a newer card turns this one `superseded`.
/// M24: decoding is tolerant: a field a newer server adds is dropped (the rest still show) and a
/// state this build doesn't know reads nil (the card shows read-only, like superseded).
struct SoulSetupPayload: Decodable, Hashable, Sendable {
    struct Field: Decodable, Hashable, Sendable {
        /// soulExtra never comes here (it is per channel)
        var field: SoulProposalPayload.Field
        var current: String
        var proposed: String
    }
    enum State: String, Decodable, Sendable { case open, applied, dismissed, superseded }
    var fields: [Field]
    var reason: String
    /// nil: a state from a newer server
    var state: State?
}

extension SoulSetupPayload {
    private enum CodingKeys: String, CodingKey { case fields, reason, state }

    /// One element of `fields`, kept only when this build knows its field.
    private struct KnownField: Decodable {
        var value: Field?
        init(from decoder: Decoder) throws { value = try? Field(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fields = (try c.decodeIfPresent([KnownField].self, forKey: .fields) ?? []).compactMap(\.value)
        reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
        state = try? c.decodeIfPresent(State.self, forKey: .state)
    }
}

/// POST /api/up-next ("Save for Up next", body CreateTaskRequest) -> 201: the kept suggestion.
struct SaveForLaterResponse: Decodable, Hashable, Sendable {
    var suggestion: Suggestion
}

/// POST /api/soul/intro -> 202: the chat setup started (or queued) in the main thread.
struct SoulIntroResponse: Decodable, Hashable, Sendable {
    var channelId: ID
    var runId: ID
}

// MARK: - The card's group block

/// CardBlock.group (show_tasks): "Needs you 2" with up to five rows; `empty` is the line shown when
/// it has none. A row's `route` is duet://tasks/<id> or duet://suggestions/<id> (tap starts it).
struct CardGroup: Decodable, Hashable, Sendable {
    struct Row: Decodable, Hashable, Sendable {
        var title: String
        var detail: String?
        var route: String?
    }
    var title: String
    var count: Int
    var empty: String?
    var rows: [Row]
}
