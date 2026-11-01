// The Make tab's formatted copy (prompt L147-L153, L89): relative times ("this minute",
// "2 hr ago"), "Updated now", the Build view's elapsed timer (0:01, 0:02...), "Refreshes daily
// at 5:30 AM" in the app's language and the iPhone's 12/24-hour setting, and metric values.
// The words are catalog keys; the numbers are formatted here. Pure Foundation (host-tested).
import Foundation

struct MakeCopy: Sendable {
    var format: ChatDateFormat

    init(format: ChatDateFormat = ChatDateFormat()) {
        self.format = format
    }

    private var locale: Locale { format.locale }

    /// "this minute", "12 min ago", "2 hr ago", "Yesterday", "Monday", "Oct 20" ("Oct 20, 2025").
    func ago(_ date: Date, now: Date) -> String {
        let seconds = max(now.timeIntervalSince(date), 0)
        if seconds < 60 { return String(localized: "this minute", locale: locale) }
        if seconds < 3600 {
            let minutes = Int(seconds / 60)
            return String(localized: "\(minutes) min ago", locale: locale)
        }
        var calendar = format.calendar
        calendar.timeZone = format.timeZone
        if seconds < 24 * 3600 && calendar.isDate(date, inSameDayAs: now) {
            let hours = Int(seconds / 3600)
            return String(localized: "\(hours) hr ago", locale: locale)
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return String(localized: "Yesterday", locale: locale)
        }
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: format.timeZone)
        if seconds < 6 * 24 * 3600 { return date.formatted(style.weekday(.wide)) }
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        return sameYear ? date.formatted(style.month(.abbreviated).day()) : date.formatted(style.month(.abbreviated).day().year())
    }

    /// The footer / toolbar line: "Updated now" within the minute, then "Updated 2 hr ago".
    func updated(_ date: Date, now: Date) -> String {
        if now.timeIntervalSince(date) < 60 { return String(localized: "Updated now", locale: locale) }
        let when = ago(date, now: now)
        return String(localized: "Updated \(when)", locale: locale)
    }

    /// The Build view's timer: "0:01", "1:05", "1:02:03".
    static func elapsed(_ seconds: TimeInterval) -> String {
        let total = max(Int(seconds), 0)
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        func two(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
        return h > 0 ? "\(h):\(two(m)):\(two(s))" : "\(m):\(two(s))"
    }

    /// "Refreshes daily at 5:30 AM" / "Refreshes weekdays at 5:30 AM" / "Refreshes every hour" /
    /// "Refreshes every Monday at 5:30 AM"; nil for a one-off.
    func refreshes(_ schedule: Schedule) -> String? {
        let time = ScheduleCopy(format: format).time(LocalTime(hour: schedule.hour, minute: schedule.minute))
        switch schedule.cadence {
        case .daily: return String(localized: "Refreshes daily at \(time)", locale: locale)
        case .weekdays: return String(localized: "Refreshes weekdays at \(time)", locale: locale)
        case .hourly: return String(localized: "Refreshes every hour", locale: locale)
        case .weekly:
            guard let weekday = schedule.weekday, (1...7).contains(weekday) else {
                return String(localized: "Refreshes weekly at \(time)", locale: locale)
            }
            var calendar = format.calendar
            calendar.locale = locale
            let day = calendar.standaloneWeekdaySymbols[weekday - 1]
            return String(localized: "Refreshes every \(day) at \(time)", locale: locale)
        case .once:
            return nil
        }
    }

    /// A metric tile's value: "$12,480", "38%", "1,204", "4.2 h" (the unit as the server names it).
    func metric(_ value: Double, unit: String?) -> String {
        let fractional = value.rounded() != value
        let number = value.formatted(.number.locale(locale).precision(.fractionLength(fractional ? 1 : 0)))
        guard let unit = unit?.trimmingCharacters(in: .whitespaces), !unit.isEmpty else { return number }
        if Self.prefixUnits.contains(unit) { return unit + number }
        if unit == "%" || unit.count == 1 && !unit.first!.isLetter { return number + unit }
        return number + " " + unit
    }

    static let prefixUnits: Set<String> = ["$", "€", "£", "¥", "₹", "₩", "US$", "HK$", "A$", "C$"]
}

/// The docs reader's contents (L181): h1-h3 of the artifact's HTML in document order (the same
/// order as querySelectorAll("h1,h2,h3"), so index i scrolls to the i-th heading), and whether the
/// doc is long enough to show the list. Pure Foundation (host-tested).
enum DocOutline {
    struct Heading: Hashable, Sendable, Identifiable {
        var index: Int
        var level: Int
        var text: String
        var id: Int { index }
    }

    static func headings(in html: String) -> [Heading] {
        let body = stripping(["script", "style", "template", "noscript"], from: html)
        guard let regex = try? NSRegularExpression(pattern: "<h([1-3])\\b[^>]*>(.*?)</h\\1\\s*>", options: [.caseInsensitive, .dotMatchesLineSeparators]) else { return [] }
        let ns = body as NSString
        var result: [Heading] = []
        for (domIndex, match) in regex.matches(in: body, range: NSRange(location: 0, length: ns.length)).enumerated() {
            let level = Int(ns.substring(with: match.range(at: 1))) ?? 1
            let text = plainText(ns.substring(with: match.range(at: 2)))
            // Empty headings still count (the index must match the DOM's), but aren't listed.
            if !text.isEmpty { result.append(Heading(index: domIndex, level: level, text: text)) }
        }
        return result
    }

    /// The list shows for long docs: at least 3 headings and about two screens of text.
    static func isLong(html: String, headings: [Heading]) -> Bool {
        headings.count >= 3 && plainText(stripping(["script", "style", "template", "noscript"], from: html)).count >= 1800
    }

    // MARK: - Helpers

    private static func stripping(_ tags: [String], from html: String) -> String {
        var text = html
        for tag in tags {
            text = text.replacingOccurrences(of: "(?s)<\(tag)\\b[^>]*>.*?</\(tag)\\s*>", with: " ", options: [.regularExpression, .caseInsensitive])
        }
        return text.replacingOccurrences(of: "(?s)<!--.*?-->", with: " ", options: .regularExpression)
    }

    /// Tags dropped, the common entities decoded, whitespace collapsed.
    static func plainText(_ html: String) -> String {
        var text = html.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
        let entities = ["&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…"]
        for (entity, value) in entities { text = text.replacingOccurrences(of: entity, with: value) }
        text = text.replacingOccurrences(of: "&#(\\d+);", with: " ", options: .regularExpression)
        return text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}

/// The Link-style spend request's state (L158), M3 approval-card style: the server's status, the
/// clock (a pending one past expiresAt is expired) and the tap in flight or failed.
enum SpendPhase: Hashable, Sendable {
    case pending, busy, failed(String), approved, declined, expired

    init(_ spend: SpendRequest, request: CardRequest?, now: Date) {
        switch spend.status {
        case .approved: self = .approved
        case .declined: self = .declined
        case .expired: self = .expired
        case .pending:
            if spend.expiresAt <= now { self = .expired; return }
            switch request {
            case .inFlight: self = .busy
            case .failed(let reason): self = .failed(reason)
            case nil: self = .pending
            }
        }
    }

    /// Approve / Decline can be tapped (again, after a failure).
    var isOpen: Bool {
        switch self {
        case .pending, .failed: true
        default: false
        }
    }
}

/// "Save this as a skill?" (L156): open, saving, failed, saved or dismissed.
enum SkillProposalPhase: Hashable, Sendable {
    case open, busy, failed(String), saved, dismissed

    init(_ state: SkillProposalPayload.State, request: CardRequest?) {
        switch state {
        case .saved: self = .saved
        case .dismissed: self = .dismissed
        case .open:
            switch request {
            case .inFlight: self = .busy
            case .failed(let reason): self = .failed(reason)
            case nil: self = .open
            }
        }
    }
}
