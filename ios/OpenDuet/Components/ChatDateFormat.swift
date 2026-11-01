// App-side date formatting for chat (prompt L91): the app's locale and the iPhone's 12/24-hour
// setting, never strings from the server. Date separators read "Today 8:47 AM" / "今天 上午8:47";
// phrase dates read "Thursday at 11:00 AM" / "Oct 26 at 10:00 AM". Pure Foundation.
import Foundation

struct ChatDateFormat: Sendable {
    var locale: Locale = AppLocale.current
    var calendar: Calendar = .autoupdatingCurrent
    var timeZone: TimeZone = .autoupdatingCurrent
    var now = Date()
    /// Joins a day and a time: "Thursday at 11:00 AM". Injectable so tests needn't load the catalog.
    var joinDayAndTime: @Sendable (_ day: String, _ time: String) -> String = { day, time in
        String(localized: "\(day) at \(time)", comment: "A day and a clock time, e.g. Thursday at 11:00 AM")
    }

    private var style: Date.FormatStyle {
        var cal = calendar
        cal.timeZone = timeZone
        return Date.FormatStyle(locale: locale, calendar: cal, timeZone: timeZone)
    }

    /// "8:47 AM" / "上午8:47" / "08:47".
    func time(_ date: Date) -> String {
        date.formatted(style.hour().minute())
    }

    /// The centred separator above a group of messages: "Today 8:47 AM", "Yesterday 6:02 PM",
    /// "Monday 9:15 AM" within the week, "Oct 20, 8:47 AM" before, with the year when it differs.
    func separator(_ date: Date) -> String {
        switch dayOffset(date) {
        case -1...0:
            return relativeDay(offset: dayOffset(date), context: .beginningOfSentence) + " " + time(date)
        case -6 ... -2:
            return date.formatted(style.weekday(.wide).hour().minute())
        default:
            return date.formatted(sameYear(date) ? style.month(.abbreviated).day().hour().minute()
                                                 : style.year().month(.abbreviated).day().hour().minute())
        }
    }

    /// A phrase's `relative_datetime`: "today at 11:00 AM", "Thursday at 11:00 AM" (within a
    /// week ahead or behind), else "Oct 29 at 11:00 AM".
    func relativeDayAndTime(_ date: Date) -> String {
        let offset = dayOffset(date)
        let day: String
        if (-1...1).contains(offset) {
            day = relativeDay(offset: offset, context: .middleOfSentence)
        } else if (-6...6).contains(offset) {
            day = date.formatted(style.weekday(.wide))
        } else {
            day = monthDay(date)
        }
        return joinDayAndTime(day, time(date))
    }

    /// A phrase's `datetime`: "Oct 26 at 10:00 AM" (with the year when it isn't this year).
    func dayAndTime(_ date: Date) -> String {
        joinDayAndTime(monthDay(date), time(date))
    }

    // MARK: - Helpers

    private func monthDay(_ date: Date) -> String {
        date.formatted(sameYear(date) ? style.month(.abbreviated).day() : style.year().month(.abbreviated).day())
    }

    /// "Today" / "today" / "今天", "Yesterday", "Tomorrow" in the locale, for a day offset from `now`.
    /// DateFormatter's relative words compare against the real clock, so the offset is applied to it.
    private func relativeDay(offset: Int, context: Formatter.Context) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = calendar
        formatter.timeZone = timeZone
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        formatter.doesRelativeDateFormatting = true
        formatter.formattingContext = context
        var cal = calendar
        cal.timeZone = timeZone
        let day = cal.date(byAdding: .day, value: offset, to: Date()) ?? Date()
        return formatter.string(from: day)
    }

    /// Calendar days from today to `date` (negative = in the past).
    func dayOffset(_ date: Date) -> Int {
        var cal = calendar
        cal.timeZone = timeZone
        return cal.dateComponents([.day], from: cal.startOfDay(for: now), to: cal.startOfDay(for: date)).day ?? 0
    }

    private func sameYear(_ date: Date) -> Bool {
        var cal = calendar
        cal.timeZone = timeZone
        return cal.component(.year, from: date) == cal.component(.year, from: now)
    }
}

/// M19: a bubble's clock time ("8:47 AM" / "上午8:47" / "08:47", as `ChatDateFormat.time`) for
/// the views that draw it on every pass (each row's VoiceOver label, the swipe's time). One
/// format style per locale and time zone instead of a new one per row per render.
@MainActor
enum ChatTimeFormat {
    private struct Key: Hashable {
        var locale: Locale
        var timeZone: TimeZone
    }

    private static var styles: [Key: Date.FormatStyle] = [:]

    static func time(_ date: Date, locale: Locale = AppLocale.current) -> String {
        let key = Key(locale: locale, timeZone: .current)
        if let style = styles[key] { return style.format(date) }
        var calendar = Calendar.autoupdatingCurrent
        calendar.timeZone = key.timeZone
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: key.timeZone).hour().minute()
        // Only ever a locale or two; a time zone change adds one more.
        if styles.count >= 8 { styles.removeAll() }
        styles[key] = style
        return style.format(date)
    }
}
