// Shared wire types. They mirror backend/src/contract/ (the source of truth); every shape
// is checked against docs/api-samples/ by OpenDuetTests/ContractSamplesTests.
import Foundation

/// Server ids (cuid strings). Inside an Identifiable type whose `id` isn't a String
/// (DuetEvent), `ID` resolves to that type's own ID, so spell those `String`.
typealias ID = String

/// JSON coding used for every API call: ISO 8601 dates with or without fractional seconds.
enum JSONCoding {
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let plain = Date.ISO8601FormatStyle()

    static func parseDate(_ string: String) -> Date? {
        if let date = try? fractional.parse(string) { return date }
        if let date = try? plain.parse(string) { return date }
        // Offsets such as +08:00 (the formatter above only reads Z / +0800 in some locales).
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: string) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: string)
    }

    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            guard let date = parseDate(string) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO 8601 date: \(string)")
            }
            return date
        }
        return decoder
    }

    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(formatDate(date))
        }
        return encoder
    }

    /// M21: "2026-10-28T09:41:01.601Z", from the date rounded to whole milliseconds. A parsed
    /// ".601" is stored as a Double a hair under it, and the formatter truncates, so it went back
    /// to the server as ".600" (and the newest message never counted as read).
    static func formatDate(_ date: Date) -> String {
        let millis = (date.timeIntervalSince1970 * 1000).rounded()
        let seconds = (millis / 1000).rounded(.down)
        let fraction = Int(millis - seconds * 1000)
        let whole = plain.format(Date(timeIntervalSince1970: seconds))
        // `plain` ends in "Z" (UTC); the milliseconds go in front of it.
        return String(whole.dropLast()) + "." + String(format: "%03d", fraction) + "Z"
    }
}

/// M29: a wire enum with an `.assistant` case ("who did it": role, by, source, controller). Servers
/// before the rename, cached rows and old samples send "claude"; it reads as `.assistant`. Encoding
/// is the enum's own and writes only "assistant".
protocol AssistantValue: RawRepresentable, Decodable where RawValue == String {
    static var assistant: Self { get }
}

extension AssistantValue {
    /// The value servers before M29 sent for `.assistant`.
    static var legacyAssistantValue: String { "claude" }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        if raw == Self.legacyAssistantValue {
            self = .assistant
        } else if let value = Self(rawValue: raw) {
            self = value
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Cannot initialize \(Self.self) from invalid String value \(raw)")
        }
    }
}

/// Coding key of tagged unions ("kind" for messages and previews, "type" for events and params).
enum Discriminator: String, CodingKey { case kind, type }

/// A coding key built from any string, for payload fields read inside tagged unions.
struct AnyKey: CodingKey, ExpressibleByStringLiteral {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { stringValue = string }
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
    init(stringLiteral value: String) { stringValue = value }
}

extension Decoder {
    /// Decodes one field of this decoder's JSON object (`{"approval": {...}}` -> Approval).
    func field<T: Decodable>(_ type: T.Type, _ key: AnyKey) throws -> T {
        try container(keyedBy: AnyKey.self).decode(type, forKey: key)
    }
}

struct LocalTime: Codable, Hashable, Sendable {
    var hour: Int
    var minute: Int
}

struct Schedule: Codable, Hashable, Sendable {
    enum Cadence: String, Codable, Sendable { case daily, weekdays, weekly, hourly, once }
    var cadence: Cadence
    var hour: Int
    var minute: Int
    var weekday: Int?
    var at: Date?
}

/// A parameter of server-built text; dates and durations stay structured so the app
/// formats them in its language and the iPhone's 12/24-hour setting.
enum PhraseParam: Decodable, Hashable, Sendable {
    case text(String)
    case number(Double)
    case datetime(Date)
    case relativeDatetime(Date)
    case duration(seconds: Double)

    private enum Keys: String, CodingKey { case type, value, seconds }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "text": self = .text(try c.decode(String.self, forKey: .value))
        case "number": self = .number(try c.decode(Double.self, forKey: .value))
        case "datetime": self = .datetime(try c.decode(Date.self, forKey: .value))
        case "relative_datetime": self = .relativeDatetime(try c.decode(Date.self, forKey: .value))
        case "duration": self = .duration(seconds: try c.decode(Double.self, forKey: .seconds))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown param type \(other)")
        }
    }
}

/// Server-built text (`key` + `params`, rendered from the String Catalog) or model text (`text`).
/// Keys and `{name}` placeholders match backend/src/i18n/en.json "phrases" and Localizable.xcstrings.
struct Phrase: Decodable, Hashable, Sendable {
    var key: String?
    var params: [String: PhraseParam]?
    var text: String?
}

/// Body of every non-2xx response.
struct ApiErrorBody: Decodable, Sendable {
    struct Detail: Decodable, Sendable {
        let code: String
        let message: String
        let field: String?
    }
    let error: Detail
}

enum AppLanguage: String, Codable, Sendable {
    case en
    case zhHans = "zh-Hans"
}

/// Status pill keys (they also drive the mascot morph).
enum StatusKey: String, Codable, CaseIterable, Sendable {
    case thinking
    case checkingMemory = "checking_memory"
    case searchingEmail = "searching_email"
    case checkingFiles = "checking_files"
    case checkingCalendar = "checking_calendar"
    case searchingWeb = "searching_web"
    case lookingUp = "looking_up"
    case writingDraft = "writing_draft"
    case startingTask = "starting_task"
    case workingTasks = "working_tasks"
    case working
    case checking
    case readingNow = "reading_now"
    case workingBrowser = "working_browser"
    case wakingWorkspace = "waking_workspace"

    var title: LocalizedStringResource {
        switch self {
        case .thinking: "Thinking it through"
        case .checkingMemory: "Checking memory"
        case .searchingEmail: "Searching your email"
        case .checkingFiles: "Checking recent files"
        case .checkingCalendar: "Checking your calendar"
        case .searchingWeb: "Searching the web"
        case .lookingUp: "Looking something up"
        case .writingDraft: "Writing a draft"
        case .startingTask: "Starting a task"
        case .workingTasks: "Working on your tasks"
        case .working: "Working on it"
        case .checking: "Checking"
        case .readingNow: "Reading now"
        case .workingBrowser: "Working in your browser"
        case .wakingWorkspace: "Waking OpenDuet's workspace"
        }
    }
}
