// M9 wire models (backend/src/contract/: common.ts CardIcon / CardTint, messages.ts form and
// card, tasks.ts Routine and RoutineRuns, account.ts UsageStats). Owned by the main agent.
// Unknown enum values from a newer server fall back instead of failing the whole page.
import Foundation

/// The hand-drawn icon set's keys (Components/DuetIcon draws them). The assistant picks one per card.
enum CardIcon: String, Hashable, Sendable, CaseIterable {
    case lightbulb, doc, dashboard, slides, webpage, design, checklist, task, calendar
    case clock, mail, chat, person, people, folder, file, link, search, globe, chart
    case money, cart, gift, pin, house, plane, book, code, sparkle, heart, star
    case bell, warning, check, question, pencil, music, camera
}

extension CardIcon: Decodable {
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CardIcon(rawValue: raw) ?? .sparkle
    }
}

/// A card's tint; the UI maps it to a light / dark colour pair (Palette).
enum CardTint: String, Hashable, Sendable, CaseIterable {
    case orange, blue, green, purple, amber, red, grey
}

extension CardTint: Decodable {
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CardTint(rawValue: raw) ?? .grey
    }
}

// MARK: - Form card (kind "form", ask_form)

struct FormOption: Codable, Hashable, Sendable, Identifiable {
    var id: ID
    var label: String
    var detail: String?
}

struct FormField: Decodable, Hashable, Sendable, Identifiable {
    enum Kind: Hashable, Sendable {
        /// chips, one choice
        case single(options: [FormOption], allowOther: Bool)
        /// chips, any number
        case multi(options: [FormOption], allowOther: Bool)
        case text(placeholder: String?, multiline: Bool)
    }
    var id: ID
    var label: String
    var required: Bool
    var kind: Kind

    private enum CodingKeys: String, CodingKey { case id, type, label, required, options, allowOther, placeholder, multiline }

    init(id: ID, label: String, required: Bool, kind: Kind) {
        self.id = id
        self.label = label
        self.required = required
        self.kind = kind
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ID.self, forKey: .id)
        label = try c.decode(String.self, forKey: .label)
        required = try c.decode(Bool.self, forKey: .required)
        switch try c.decode(String.self, forKey: .type) {
        case "single":
            kind = .single(options: try c.decode([FormOption].self, forKey: .options), allowOther: try c.decode(Bool.self, forKey: .allowOther))
        case "multi":
            kind = .multi(options: try c.decode([FormOption].self, forKey: .options), allowOther: try c.decode(Bool.self, forKey: .allowOther))
        default:
            // "text", and any field type a newer server adds: a plain text answer still works.
            kind = .text(placeholder: try c.decodeIfPresent(String.self, forKey: .placeholder), multiline: (try c.decodeIfPresent(Bool.self, forKey: .multiline)) ?? false)
        }
    }
}

/// An answer: the chosen option ids plus typed text ("Other", or a text field).
struct FormAnswer: Codable, Hashable, Sendable {
    var fieldId: ID
    var optionIds: [ID]
    var text: String?

    private enum CodingKeys: String, CodingKey { case fieldId, optionIds, text }

    /// `text` is always sent, as null when there is none (messages.ts FormAnswer: nullable;
    /// synthesized Encodable would drop the key and an older server answers 400).
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(fieldId, forKey: .fieldId)
        try c.encode(optionIds, forKey: .optionIds)
        try c.encode(text, forKey: .text)
    }
}

struct FormPayload: Decodable, Hashable, Sendable {
    enum State: String, Decodable, Sendable { case open, submitted, dismissed }
    var title: String
    var description: String?
    var icon: CardIcon
    var fields: [FormField]
    /// nil = the UI's own "Submit"
    var submitLabel: String?
    var state: State
    /// set once submitted: the card collapses to these
    var answers: [FormAnswer]?
    /// M29: who closed a dismissed form (nil: the user's Skip, or a card stored before M29)
    var closedBy: CardCloser? = nil
}

// MARK: - Info card (kind "card", show_card)

enum CardBlock: Decodable, Hashable, Sendable {
    struct Row: Decodable, Hashable, Sendable {
        var icon: CardIcon?
        var title: String
        var detail: String?
        var value: String?
    }
    struct Metric: Decodable, Hashable, Sendable {
        enum Trend: String, Decodable, Sendable { case up, down, flat }
        var label: String
        var value: String
        var delta: String?
        var trend: Trend?
    }
    struct CheckItem: Decodable, Hashable, Sendable {
        var text: String
        var done: Bool
        /// M24: set by the server on a checkable checklist (check / uncheck with this itemId);
        /// nil = read-only (older cards, a status list)
        var id: ID? = nil
    }
    struct Bar: Decodable, Hashable, Sendable {
        var label: String
        var value: Double
    }

    case text(String)
    case rows([Row])
    case metrics([Metric])
    case progress(label: String, value: Double, detail: String?)
    case checklist([CheckItem])
    case bars([Bar], unit: String?)
    /// M22: a counted group of rows the server built (show_tasks); rows open `route` on tap
    case group(CardGroup)
    /// M24: a trend, 1-3 series over shared labels (M24Models.swift CardLineChart)
    case lineChart(CardLineChart)
    /// a block type a newer server added: skipped by the UI
    case unsupported(type: String)

    private enum CodingKeys: String, CodingKey { case type, text, rows, items, label, value, detail, unit }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "text": self = .text(try c.decode(String.self, forKey: .text))
        case "rows": self = .rows(try c.decode([Row].self, forKey: .rows))
        case "metrics": self = .metrics(try c.decode([Metric].self, forKey: .items))
        case "progress":
            self = .progress(label: try c.decode(String.self, forKey: .label), value: try c.decode(Double.self, forKey: .value), detail: try c.decodeIfPresent(String.self, forKey: .detail))
        case "checklist": self = .checklist(try c.decode([CheckItem].self, forKey: .items))
        case "bars": self = .bars(try c.decode([Bar].self, forKey: .items), unit: try c.decodeIfPresent(String.self, forKey: .unit))
        case "group": self = .group(try CardGroup(from: decoder))
        case "line_chart": self = .lineChart(try CardLineChart(from: decoder))
        default: self = .unsupported(type: type)
        }
    }
}

struct CardAction: Decodable, Hashable, Sendable {
    enum Kind: String, Decodable, Sendable {
        /// send `value` as the user (CardActions.sendText)
        case send
        /// an https URL in the in-app Safari sheet
        case openURL = "open_url"
        /// a duet:// route (ShellActions.openRoute)
        case openRoute = "open_route"
    }
    enum Style: String, Decodable, Sendable { case primary, secondary }
    var label: String
    var type: Kind
    var value: String
    var style: Style
}

struct CardPayload: Decodable, Hashable, Sendable {
    var icon: CardIcon
    var tint: CardTint
    var title: String
    var subtitle: String?
    var blocks: [CardBlock]
    var actions: [CardAction]
}

// MARK: - Routines (scheduled tasks)

/// A scheduled task's state (TaskSummary.routine). Its TaskSummary.schedule has the times.
struct Routine: Decodable, Hashable, Sendable {
    enum LastStatus: String, Decodable, Sendable { case completed, resolved, skipped, failed }
    var paused: Bool
    var quiet: Bool
    /// nil while paused, or after a "once" routine ran
    var nextRunAt: Date?
    var lastRunAt: Date?
    var lastRunStatus: LastStatus?
    /// M22: failed runs in a row; at 3 the routine pauses itself (pausedBy .failures)
    var failStreak: Int = 0
    /// M22: who paused it; nil while it runs (or from an older server)
    var pausedBy: RoutinePausedBy? = nil
}

extension Routine {
    private enum CodingKeys: String, CodingKey { case paused, quiet, nextRunAt, lastRunAt, lastRunStatus, failStreak, pausedBy }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        paused = try c.decode(Bool.self, forKey: .paused)
        quiet = try c.decode(Bool.self, forKey: .quiet)
        nextRunAt = try c.decodeIfPresent(Date.self, forKey: .nextRunAt)
        lastRunAt = try c.decodeIfPresent(Date.self, forKey: .lastRunAt)
        lastRunStatus = try c.decodeIfPresent(LastStatus.self, forKey: .lastRunStatus)
        failStreak = try c.decodeIfPresent(Int.self, forKey: .failStreak) ?? 0
        pausedBy = try? c.decodeIfPresent(RoutinePausedBy.self, forKey: .pausedBy)
    }
}

/// GET /api/tasks/:id/runs
struct RoutineRuns: Decodable, Hashable, Sendable {
    var runs: [RunRecord]
}

// MARK: - Usage panel

enum UsageRange: String, Codable, Hashable, Sendable, CaseIterable {
    case today
    case sevenDays = "7d"
    case thirtyDays = "30d"
    case all
}

/// GET /api/usage/stats?range=
struct UsageStats: Decodable, Hashable, Sendable {
    struct Counts: Decodable, Hashable, Sendable {
        var inputTokens: Int
        var outputTokens: Int
        var runs: Int
        var total: Int { inputTokens + outputTokens }
    }
    struct ModelRow: Decodable, Hashable, Sendable, Identifiable {
        var model: String
        var label: String
        var provider: String?
        var inputTokens: Int
        var outputTokens: Int
        var runs: Int
        var id: String { "\(provider ?? "")/\(model)" }
        var total: Int { inputTokens + outputTokens }
    }
    struct KindRow: Decodable, Hashable, Sendable, Identifiable {
        enum Kind: String, Decodable, Sendable { case chat, task, build, proactive }
        var kind: Kind
        var inputTokens: Int
        var outputTokens: Int
        var runs: Int
        var id: Kind { kind }
        var total: Int { inputTokens + outputTokens }
    }
    enum Bucket: String, Decodable, Sendable { case hour, day, month }
    struct Point: Decodable, Hashable, Sendable, Identifiable {
        var start: Date
        var inputTokens: Int
        var outputTokens: Int
        var id: Date { start }
        var total: Int { inputTokens + outputTokens }
    }
    var range: UsageRange
    var since: Date?
    var until: Date
    var totals: Counts
    /// some counted runs' tokens were estimated (the gateway didn't report usage)
    var estimated: Bool
    var byModel: [ModelRow]
    var byKind: [KindRow]
    var bucket: Bucket
    var series: [Point]
}