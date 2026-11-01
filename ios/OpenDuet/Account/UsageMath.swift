// The Usage screen's numbers (prompt L128, L79, L166): compact token counts ("1.2M"), and for
// the M9 panel each model's share, the model order and the four kind tiles. The limit helpers
// (percentages, "Resets in 3 hr", "Expires Nov 30") are kept for their tests; the M9 panel has
// no limits or resets. Pure Foundation (host-tested), in the app's locale.
import Foundation

enum UsageMath {
    enum Level: Hashable, Sendable { case normal, full }

    /// "0% used" ... "100% used", rounded down so 100% means the limit is really reached; nil
    /// when the limit is 0 (no limit: the row shows the tokens used instead).
    static func percent(used: Int, limit: Int) -> Int? {
        guard limit > 0 else { return nil }
        let value = Double(max(used, 0)) / Double(limit) * 100
        return min(Int(value.rounded(.down)), 100)
    }

    /// The bar's fill, 0...1 (0 without a limit).
    static func fraction(used: Int, limit: Int) -> Double {
        guard limit > 0 else { return 0 }
        return min(max(Double(used) / Double(limit), 0), 1)
    }

    /// The bar turns red once the limit is reached (L128); never without a limit.
    static func level(used: Int, limit: Int) -> Level {
        limit > 0 && used >= limit ? .full : .normal
    }

    /// "45 min", "3 hr", "13 hr", "3 days": one unit, never 0. Minutes round up, hours and days
    /// to the nearest; days only from two days out so the weekly window reads in hours late on.
    static func resetsIn(_ date: Date, now: Date, locale: Locale) -> String {
        let seconds = max(date.timeIntervalSince(now), 0)
        let unit: Duration.UnitsFormatStyle.Unit
        let count: Int
        let unitSeconds: Int
        if seconds >= 2 * 86_400 {
            unit = .days; unitSeconds = 86_400
            count = Int((seconds / 86_400).rounded())
        } else if seconds >= 3_540 {
            unit = .hours; unitSeconds = 3_600
            count = max(Int((seconds / 3_600).rounded()), 1)
        } else {
            unit = .minutes; unitSeconds = 60
            count = max(Int((seconds / 60).rounded(.up)), 1)
        }
        return Duration.seconds(Double(count * unitSeconds))
            .formatted(.units(allowed: [unit], width: .abbreviated).locale(locale))
    }

    /// The last day the free reset can be used: "Nov 30" / "11月30日". The server's expiry may be
    /// the first instant of the next month, so a second is taken off before reading the day.
    static func expiryDay(_ expiresAt: Date, calendar: Calendar = .autoupdatingCurrent, locale: Locale) -> String {
        var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        style = style.month(.abbreviated).day()
        return expiresAt.addingTimeInterval(-1).formatted(style)
    }

    /// "1.2M" / "120万" for the tokens used under no limit.
    static func tokens(_ count: Int, locale: Locale) -> String {
        count.formatted(.number.notation(.compactName).locale(locale))
    }

    // MARK: M9 Usage panel (GET /api/usage/stats)

    /// A part's share of the total, 0...1 (0 when nothing was counted).
    static func share(_ part: Int, of total: Int) -> Double {
        guard total > 0 else { return 0 }
        return min(max(Double(part) / Double(total), 0), 1)
    }

    /// "42%" / "42%" for a share bar's label, whole percents.
    static func percentText(_ share: Double, locale: Locale) -> String {
        share.formatted(.percent.precision(.fractionLength(0)).locale(locale))
    }

    /// "By model": most tokens first; ties by label so the order holds still between loads.
    static func modelsByUse(_ rows: [UsageStats.ModelRow]) -> [UsageStats.ModelRow] {
        rows.sorted { a, b in
            a.total != b.total ? a.total > b.total : a.label.localizedStandardCompare(b.label) == .orderedAscending
        }
    }

    /// "By kind": always the same four tiles (Chat, Tasks, Make, Scheduled & proactive), zero
    /// for a kind the range has no runs of.
    static func kindTiles(_ rows: [UsageStats.KindRow]) -> [UsageStats.KindRow] {
        let order: [UsageStats.KindRow.Kind] = [.chat, .task, .build, .proactive]
        return order.map { kind in
            rows.first { $0.kind == kind } ?? UsageStats.KindRow(kind: kind, inputTokens: 0, outputTokens: 0, runs: 0)
        }
    }

    /// Nothing counted in the range: the panel says "No usage yet" instead of zeros.
    static func isEmpty(_ stats: UsageStats) -> Bool {
        stats.totals.total == 0 && stats.totals.runs == 0
    }
}
