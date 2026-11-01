// Run records (backend/src/contract/runs.ts, M8 contract §1): every run of the model (a chat
// turn, a task's work, the brief, a check-in, the first-day scan, a Make build) with its steps.
// GET /api/runs lists them newest first; GET /api/runs/:id adds the steps (oldest first). While
// a run is queued or running the app polls its detail (no SSE event).
import Foundation

enum RunKind: String, Decodable, CaseIterable, Sendable {
    case chat, task, brief, checkin, scan, build
    /// M9: a scheduled task's run (schedule_task)
    case routine
}

/// M21 (contract/m21.ts ActiveRun): the turn running in a channel's own thread.
struct ActiveRun: Decodable, Hashable, Sendable {
    var runId: String
    var kind: RunKind
    var startedAt: Date
}

/// M21: the artifact event's editStatus / refreshStatus.
struct ArtifactWorkStatus: Decodable, Hashable, Sendable {
    enum State: String, Decodable, Sendable { case working, failed }
    var state: State
    /// failed only: why (a server phrase)
    var reason: Phrase?
}

enum RunStatus: String, Decodable, CaseIterable, Sendable {
    case queued, running, completed, resolved, skipped, failed

    /// Still going: the detail is polled about every 2 s.
    var isOpen: Bool { self == .queued || self == .running }
}

struct RunStep: Decodable, Hashable, Sendable, Identifiable {
    enum Kind: String, Decodable, CaseIterable, Sendable { case tool, text, thinking, error }
    enum Status: String, Decodable, CaseIterable, Sendable {
        case running, ok, error, denied
        case awaitingApproval = "awaiting_approval"
    }

    var id: ID
    var index: Int
    var kind: Kind
    /// The model's tool name for kind "tool" ("computer_exec", "web_search", "GMAIL_SEND_EMAIL").
    var tool: String?
    /// App display name ("OpenDuet's computer", "Gmail").
    var app: String?
    /// A key from the contract's fixed list (run.step.*), or text (Composio tool display names).
    var title: Phrase
    /// One grey line under the title: a command, URL, path, query or the first line of text.
    var detail: String
    var status: Status
    /// Expandable bodies, already redacted and capped by the server; nil when there is nothing.
    var input: String?
    var output: String?
    var approvalId: ID?
    var startedAt: Date
    var finishedAt: Date?

    /// The chevron shows only when there is a body to expand.
    var isExpandable: Bool { !(input ?? "").isEmpty || !(output ?? "").isEmpty }
}

struct RunSummary: Decodable, Hashable, Sendable, Identifiable {
    struct Latest: Decodable, Hashable, Sendable {
        var title: Phrase
        var detail: String
    }

    var id: ID
    var kind: RunKind
    var channelId: ID?
    var taskId: ID?
    /// chat: the user's message; task: the task title (text); others: key run.title.<kind>.
    var title: Phrase
    var status: RunStatus
    var stepCount: Int
    /// The latest step's title + detail (the row subtitle); nil with no steps.
    var latest: Latest?
    var error: Phrase?
    var createdAt: Date
    var startedAt: Date?
    var finishedAt: Date?
}

/// GET /api/runs?taskId=|channelId=&before=&limit= (newest first).
struct RunList: Decodable, Sendable {
    var runs: [RunSummary]
    var hasMore: Bool
}

/// GET /api/runs/:id: the summary fields plus the steps (one flat JSON object).
struct RunDetail: Decodable, Hashable, Sendable, Identifiable {
    var summary: RunSummary
    /// Oldest first; at most the newest 300.
    var steps: [RunStep]

    var id: ID { summary.id }

    private enum CodingKeys: String, CodingKey { case steps }

    init(summary: RunSummary, steps: [RunStep]) {
        self.summary = summary
        self.steps = steps
    }

    init(from decoder: Decoder) throws {
        summary = try RunSummary(from: decoder)
        steps = try decoder.container(keyedBy: CodingKeys.self).decode([RunStep].self, forKey: .steps)
    }
}
