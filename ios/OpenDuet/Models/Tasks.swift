// Tasks tab, task detail, the Scheduled group and Up next (backend/src/contract/tasks.ts).
// The type is TaskSummary, never `Task`, which would shadow Swift concurrency's Task.
import Foundation

enum TaskStatus: String, Decodable, CaseIterable, Sendable {
    case working
    case needsInput = "needs_input"
    case readyForReview = "ready_for_review"
    case scheduled
    case resolved
}

struct TaskStep: Decodable, Hashable, Sendable, Identifiable {
    enum State: String, Decodable, Sendable { case planned, current, done }
    var id: ID
    var text: String
    var state: State
}

/// A "Decisions and updates" row; server-built updates (the restart pause) use a phrase key.
struct TaskUpdate: Decodable, Hashable, Sendable {
    var text: Phrase
    /// Source label, e.g. "Gmail" or "OpenDuet".
    var source: String
    /// the latest time (for a merged row, when it last happened)
    var at: Date
    /// M16: the same server-built row again right after itself, merged: how many times (nil: once)
    var count: Int? = nil
    /// M16: when the first of a merged row happened
    var since: Date? = nil
}

struct TaskResource: Decodable, Hashable, Sendable {
    enum Kind: String, Decodable, Sendable { case doc, email, event, link, file, artifact, browser }
    var title: String
    var type: Kind
    /// An https URL or an in-app route (duet://files/<id>, duet://artifacts/<id>, duet://computer).
    var link: String
    var app: String?
}

struct TaskSummary: Decodable, Hashable, Sendable, Identifiable {
    enum Source: String, Decodable, Sendable { case user, proactive }
    var id: ID
    var channelId: ID
    var title: String
    var status: TaskStatus
    var source: Source
    /// The latest update, shown after the status word ("Working · Just started").
    var latestUpdate: TaskUpdate?
    var updateCount: Int
    var schedule: Schedule?
    var archived: Bool
    var createdAt: Date
    var updatedAt: Date
    /// M9: long-press Pin; pinned tasks sort first in Active ("Pinned" group)
    var pinned: Bool = false
    /// M9: set for a scheduled task (a routine); nil for every other task
    var routine: Routine? = nil
    /// M22: what the task waits on the user for (Models/M22Models.swift); nil when nothing
    var nextStep: TaskNextStep? = nil
    /// M22: why the last run failed; nil when it didn't
    var failure: TaskFailure? = nil
    /// M22: when it was last resolved (Active keeps resolved tasks for 7 days)
    var resolvedAt: Date? = nil
    /// M22: the app of the suggestion it came from ("From Gmail"); nil when none
    var app: String? = nil
}

// M9: `pinned` and `routine` are missing from older servers' payloads. Decoding lives in an
// extension so the memberwise init (fixtures, tests) keeps working.
extension TaskSummary {
    private enum CodingKeys: String, CodingKey {
        case id, channelId, title, status, source, latestUpdate, updateCount, schedule, archived, createdAt, updatedAt, pinned, routine
        case nextStep, failure, resolvedAt, app
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ID.self, forKey: .id)
        channelId = try c.decode(ID.self, forKey: .channelId)
        title = try c.decode(String.self, forKey: .title)
        status = try c.decode(TaskStatus.self, forKey: .status)
        source = try c.decode(Source.self, forKey: .source)
        latestUpdate = try c.decodeIfPresent(TaskUpdate.self, forKey: .latestUpdate)
        updateCount = try c.decode(Int.self, forKey: .updateCount)
        schedule = try c.decodeIfPresent(Schedule.self, forKey: .schedule)
        archived = try c.decode(Bool.self, forKey: .archived)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
        routine = try c.decodeIfPresent(Routine.self, forKey: .routine)
        // M22: additive; a shape this build doesn't know drops the field, not the task.
        nextStep = try? c.decodeIfPresent(TaskNextStep.self, forKey: .nextStep)
        failure = try? c.decodeIfPresent(TaskFailure.self, forKey: .failure)
        resolvedAt = try c.decodeIfPresent(Date.self, forKey: .resolvedAt)
        app = try? c.decodeIfPresent(String.self, forKey: .app)
    }
}

/// GET /api/tasks/:id: the summary fields plus the detail (one flat JSON object).
struct TaskDetail: Decodable, Hashable, Sendable, Identifiable {
    var summary: TaskSummary
    var prompt: String
    var description: String
    var noticedAt: Date?
    var steps: [TaskStep]
    var updates: [TaskUpdate]
    var resources: [TaskResource]

    var id: ID { summary.id }

    private enum CodingKeys: String, CodingKey { case prompt, description, noticedAt, steps, updates, resources }

    init(from decoder: Decoder) throws {
        summary = try TaskSummary(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        prompt = try c.decode(String.self, forKey: .prompt)
        description = try c.decode(String.self, forKey: .description)
        noticedAt = try c.decodeIfPresent(Date.self, forKey: .noticedAt)
        steps = try c.decode([TaskStep].self, forKey: .steps)
        updates = try c.decode([TaskUpdate].self, forKey: .updates)
        resources = try c.decode([TaskResource].self, forKey: .resources)
    }
}

/// GET /api/tasks?channelId=<id>|everything. M22: unfinished tasks plus the ones resolved in the
/// last 7 days; `olderResolved` counts the rest. ?resolved=older&cursor= pages those; ?q= searches.
struct TaskList: Decodable, Sendable {
    var tasks: [TaskSummary]
    /// M22: resolved tasks older than the 7-day window (0 from older servers)
    var olderResolved: Int = 0
    /// M22: ?resolved=older only: the next page's cursor; nil on the last page
    var nextCursor: String? = nil

    private enum CodingKeys: String, CodingKey { case tasks, olderResolved, nextCursor }

    init(tasks: [TaskSummary], olderResolved: Int = 0, nextCursor: String? = nil) {
        self.tasks = tasks
        self.olderResolved = olderResolved
        self.nextCursor = nextCursor
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tasks = try c.decode([TaskSummary].self, forKey: .tasks)
        olderResolved = try c.decodeIfPresent(Int.self, forKey: .olderResolved) ?? 0
        nextCursor = try c.decodeIfPresent(String.self, forKey: .nextCursor)
    }
}

/// POST /api/tasks (the + FAB sheet).
struct CreateTaskRequest: Codable, Hashable, Sendable {
    var prompt: String
    var channelId: ID
}

/// PATCH /api/tasks/:id (Mark complete sends status resolved; ⋯ Archive sends archived).
struct UpdateTaskRequest: Codable, Hashable, Sendable {
    enum Status: String, Codable, Sendable { case resolved }
    var status: Status?
    var archived: Bool?
    /// M9: long-press Pin / Unpin
    var pinned: Bool? = nil
    /// M9, routines only: Pause / Resume and a new time
    var paused: Bool? = nil
    var schedule: Schedule? = nil
    /// M10: Rename works for every task (trimmed, 1-200 characters)
    var title: String? = nil
}

/// One past run of a scheduled job. M9: `routine` for a scheduled task's runs.
struct RunRecord: Decodable, Hashable, Sendable, Identifiable {
    enum Kind: String, Decodable, Sendable { case brief, checkin, scan, routine }
    enum Status: String, Decodable, Sendable { case queued, running, completed, resolved, skipped, failed }
    var id: ID
    var kind: Kind
    var scheduledFor: Date?
    var startedAt: Date?
    var status: Status
}

/// GET /api/schedule: the Scheduled group's Morning brief and Check-in rows.
struct ScheduleInfo: Decodable, Hashable, Sendable {
    struct Brief: Decodable, Hashable, Sendable {
        var time: LocalTime
        var nextRunAt: Date
        var history: [RunRecord]
    }
    struct Checkin: Decodable, Hashable, Sendable {
        var times: [LocalTime]
        var nextRunAt: Date
        var history: [RunRecord]
    }
    var weekendsOn: Bool
    var brief: Brief
    var checkin: Checkin
    /// M9: false (the default) = the server doesn't run the built-in brief and check-ins; the
    /// Scheduled group hides both rows and lists only routines.
    var builtins: Bool = false
}

extension ScheduleInfo {
    private enum CodingKeys: String, CodingKey { case weekendsOn, brief, checkin, builtins }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        weekendsOn = try c.decode(Bool.self, forKey: .weekendsOn)
        brief = try c.decode(Brief.self, forKey: .brief)
        checkin = try c.decode(Checkin.self, forKey: .checkin)
        // Servers before M9 always ran them.
        builtins = try c.decodeIfPresent(Bool.self, forKey: .builtins) ?? true
    }
}

/// POST /api/schedule/run ("Run now"); the result arrives as events.
struct RunNowRequest: Codable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable { case brief, checkin }
    var kind: Kind
}

struct RunNowResponse: Decodable, Sendable {
    var run: RunRecord
}

/// An "Up next" item ("From your connectors").
struct Suggestion: Decodable, Hashable, Sendable, Identifiable {
    enum Origin: String, Decodable, Sendable { case checkin, scan, brief, chat }
    var id: ID
    var channelId: ID?
    var title: String
    var body: String
    var app: String?
    var origin: Origin
    var createdAt: Date
    /// M22: kept with "Save for Up next" (nil from older servers)
    var fromUser: Bool? = nil
    /// M23: the email / event it came from; nil when none (or from older servers)
    var sourceRef: SourceRef? = nil
}

/// GET /api/up-next
struct UpNext: Decodable, Sendable {
    var suggestions: [Suggestion]
    var scanning: Bool
}

/// POST /api/up-next/:id/add -> the new task
struct AddSuggestionResponse: Decodable, Sendable {
    var task: TaskSummary
}

/// M16: how "Decisions and updates" shows its rows (decided by the user): the same server-built
/// row right after itself is one row with ×N (the server merges new ones; this merges what was
/// stored before), an approval's summary is one line with its command folded away, and only
/// the latest rows show until "Show N earlier".
enum TaskUpdateRules {
    /// rows shown before "Show N earlier"
    static let visible = 8

    /// One row per run of the same server-built row (key, params and source), counted, with the
    /// first time in `since`. Model-written text is never merged.
    static func merged(_ updates: [TaskUpdate]) -> [TaskUpdate] {
        var out: [TaskUpdate] = []
        for update in updates {
            if let last = out.last, same(last, update) {
                var row = update
                row.count = (last.count ?? 1) + (update.count ?? 1)
                row.since = last.since ?? last.at
                out[out.count - 1] = row
            } else {
                out.append(update)
            }
        }
        return out
    }

    private static func same(_ a: TaskUpdate, _ b: TaskUpdate) -> Bool {
        guard let key = a.text.key, key == b.text.key, a.text.text == nil, b.text.text == nil else { return false }
        return a.source == b.source && a.text.params == b.text.params
    }

    /// The latest `visible` rows unless `expanded`, and how many earlier ones are folded away.
    static func shown(_ rows: [TaskUpdate], expanded: Bool) -> (rows: [TaskUpdate], hidden: Int) {
        guard !expanded, rows.count > visible else { return (rows, 0) }
        return (Array(rows.suffix(visible)), rows.count - visible)
    }

    /// An approval row's summary ("OpenDuet's computer · Run commands: Command ls -la …") split
    /// into the line people read and the folded detail: `parts` are the names before the colon
    /// ("OpenDuet's computer", "Run commands"), `detail` the arguments after it, with a leading
    /// argument label ("Command ") dropped. Nil when the row isn't an approval or has no detail.
    struct Approval: Equatable {
        var parts: [String]
        var detail: String
    }

    static let approvalKeys: Set<String> = ["task.approval_done", "task.approval_failed", "task.approval_declined", "task.approval_expired"]

    static func approval(_ update: TaskUpdate) -> Approval? {
        guard let key = update.text.key, approvalKeys.contains(key),
              case .text(let summary)? = update.text.params?["summary"],
              let colon = summary.range(of: ": ") else { return nil }
        let head = summary[..<colon.lowerBound]
        var detail = summary[colon.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        guard !head.isEmpty, !detail.isEmpty else { return nil }
        for label in ["Command ", "Path ", "Folder "] where detail.hasPrefix(label) {
            detail = String(detail.dropFirst(label.count))
            break
        }
        let parts = head.components(separatedBy: " · ").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return Approval(parts: parts, detail: detail)
    }

    /// A row that reports a failure (shown in the warning colour).
    static func isFailure(_ update: TaskUpdate) -> Bool {
        guard let key = update.text.key else { return false }
        return key.hasPrefix("system.model_") || key == "task.approval_failed" || key.hasSuffix("build_failed")
    }
}
