// App-side formatting for M3's cards and task rows (prompt L89, L107, L117): money from minor
// units in the current locale, "Expires in 8 min" minutes, "Updated 1 min. ago", recipients,
// app tiles by display name, and which edited cards should glow. Pure Foundation (host-tested).
import Foundation

enum CardFormat {
    // MARK: Money

    /// Digits after the decimal point for an ISO 4217 code (USD 2, JPY 0, BHD 3).
    static func minorDigits(_ currency: String) -> Int {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currency.uppercased()
        return formatter.maximumFractionDigits
    }

    /// "$640.00" / "US$640.00" from minor units (64000 cents), in `locale`.
    static func money(minor amount: Int, currency: String, locale: Locale) -> String {
        let digits = minorDigits(currency)
        var value = Decimal(amount)
        for _ in 0..<digits { value /= 10 }
        let style = Decimal.FormatStyle.Currency(code: currency.uppercased(), locale: locale)
            .precision(.fractionLength(digits))
        return value.formatted(style)
    }

    // MARK: Time

    /// Whole minutes left before `expiresAt`, rounded up ("8 min" while 7:01 to 8:00 remain);
    /// nil once it has passed.
    static func minutesLeft(until expiresAt: Date, now: Date) -> Int? {
        let seconds = expiresAt.timeIntervalSince(now)
        guard seconds > 0 else { return nil }
        return Int((seconds / 60).rounded(.up))
    }

    /// "8 min" / "1 hr, 5 min" / "8分钟" for the minutes left.
    static func expiryDuration(minutes: Int, locale: Locale) -> String {
        PhraseFormatter.duration(Double(minutes) * 60, locale: locale)
    }

    /// "1 min. ago" / "2 hr. ago" / "1分钟前"; nil within the last minute (the view says
    /// "just now"), also for a clock that runs a little ahead.
    static func ago(_ date: Date, now: Date, locale: Locale) -> String? {
        guard now.timeIntervalSince(date) >= 60 else { return nil }
        // Relative to `now` (the view's TimelineView tick), not the wall clock.
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.dateTimeStyle = .numeric
        // .short: "1 min. ago" (en_US, as the spec writes it), "1分钟前".
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: now)
    }

    // MARK: Text

    /// "sam@example.com" or "sam@example.com +2" for an email card's summary and VoiceOver.
    static func recipients(_ to: [String]) -> String {
        guard let first = to.first else { return "" }
        return to.count > 1 ? "\(first) +\(to.count - 1)" : first
    }

    /// A long body folds behind "Show more": more than `lines` lines or about that many
    /// characters of wrapped text.
    static func isLongBody(_ body: String, lines: Int = 8, charactersPerLine: Int = 42) -> Bool {
        let count = body.split(separator: "\n", omittingEmptySubsequences: false).reduce(0) { total, line in
            total + max(1, Int((Double(line.count) / Double(charactersPerLine)).rounded(.up)))
        }
        return count > lines
    }

    /// The AppLogo toolkit slug for a display name ("Google Calendar" -> "googlecalendar").
    static func toolkitSlug(_ app: String?) -> String? {
        guard let app, !app.isEmpty else { return nil }
        return String(app.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(Character.init))
    }
}

/// Which cards glow after an edit by chat (L163, L182): an entry of ThreadState.edits whose
/// version grew past the one last seen. The first look (thread mounted, page loaded) only
/// records versions, so nothing glows on launch or when a task detail reopens.
struct EditGlowTracker: Hashable, Sendable {
    private(set) var seen: [String: Int] = [:]
    private(set) var seeded = false

    /// Records `edits` and returns the message ids that should glow now, in a stable order.
    mutating func update(_ edits: [String: CardEdit]) -> [String] {
        defer { seeded = true }
        var bumped: [String] = []
        for (id, edit) in edits.sorted(by: { $0.key < $1.key }) {
            let previous = seen[id]
            if previous.map({ edit.version > $0 }) ?? true {
                seen[id] = edit.version
                if seeded && !edit.fields.isEmpty { bumped.append(id) }
            }
        }
        return bumped
    }
}
