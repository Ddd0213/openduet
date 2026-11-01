// The Scheduled group's pieces of copy (prompt L118, L89): the Morning brief and Check-in times in
// the app's locale and the iPhone's 12/24-hour setting, the Check-in times as a natural list, the
// next run ("tomorrow at 8:19 AM") and each past run's day ("Today at 1:49 PM"). The sentences
// around them are catalog keys in the views. Pure Foundation (host-tested).
import Foundation

struct ScheduleCopy: Sendable {
    var format: ChatDateFormat

    init(format: ChatDateFormat = ChatDateFormat()) {
        self.format = format
    }

    /// "8:19 AM" / "上午8:19" / "08:19" for a server LocalTime (hour and minute in the user's zone).
    func time(_ time: LocalTime) -> String {
        var calendar = format.calendar
        calendar.timeZone = format.timeZone
        let date = calendar.date(bySettingHour: time.hour, minute: time.minute, second: 0, of: format.now) ?? format.now
        return format.time(date)
    }

    /// "10:49 AM, 1:49 PM, 4:49 PM, 7:49 PM and 10:49 PM", earliest first. English joins without
    /// the serial comma, as the spec writes it; other languages use their own list style
    /// ("上午10:49、下午1:49和晚上10:49").
    func timeList(_ times: [LocalTime]) -> String {
        let items = Self.sorted(times).map(time)
        let listLocale = format.locale.language.languageCode == .english ? Locale(identifier: "en_GB") : format.locale
        return items.formatted(.list(type: .and).locale(listLocale))
    }

    /// The next run, mid-sentence: "tomorrow at 8:19 AM", "today at 4:49 PM", "Monday at 8:19 AM".
    func nextRun(_ date: Date) -> String {
        format.relativeDayAndTime(date)
    }

    /// A past run at the start of its line: "Today at 1:49 PM", "Yesterday at 10:49 PM".
    func runDay(_ date: Date) -> String {
        let text = format.relativeDayAndTime(date)
        guard let first = text.first else { return text }
        return String(first).uppercased(with: format.locale) + text.dropFirst()
    }

    static func sorted(_ times: [LocalTime]) -> [LocalTime] {
        times.sorted { ($0.hour, $0.minute) < ($1.hour, $1.minute) }
    }

    /// The slot a run belongs to: its scheduled time, or when it started (Run now has no slot).
    static func runDate(_ run: RunRecord) -> Date? {
        run.scheduledFor ?? run.startedAt
    }

    /// The run history, newest first, at most `limit` rows.
    static func history(_ runs: [RunRecord], limit: Int = 10) -> [RunRecord] {
        let ordered = runs.sorted { a, b in
            let da = runDate(a) ?? .distantPast, db = runDate(b) ?? .distantPast
            return da != db ? da > db : a.id > b.id
        }
        return Array(ordered.prefix(limit))
    }

    // MARK: - Routines (M9, contract §3)

    /// A routine's times: "Daily at 9:00 AM", "Weekdays at 8:30 AM", "Every Monday at 9:00 AM",
    /// "Every hour at :15", "Once, Nov 5 at 9:00 AM".
    func schedule(_ schedule: Schedule) -> String {
        let time = time(LocalTime(hour: schedule.hour, minute: schedule.minute))
        switch schedule.cadence {
        case .daily:
            return String(localized: "Daily at \(time)", comment: "A scheduled task's times")
        case .weekdays:
            return String(localized: "Weekdays at \(time)", comment: "A scheduled task's times")
        case .weekly:
            let day = weekdayName(schedule.weekday ?? 1)
            return String(localized: "Every \(day) at \(time)", comment: "A scheduled task's times; day = Monday")
        case .hourly:
            let minute = String(format: "%02d", schedule.minute)
            return String(localized: "Every hour at :\(minute)", comment: "A scheduled task's times; minute past the hour, 05")
        case .once:
            guard let at = schedule.at else { return String(localized: "Once at \(time)", comment: "A scheduled task's times") }
            return String(localized: "Once, \(format.dayAndTime(at))", comment: "A scheduled task's single run, e.g. Once, Nov 5 at 9:00 AM")
        }
    }

    /// The routine row's second line: its times, then "next run tomorrow at 9:00 AM", "Paused", or
    /// (a "once" routine that ran) "Finished".
    func routineLine(_ schedule: Schedule?, _ routine: Routine) -> String {
        let state: String
        if routine.paused {
            state = String(localized: "Paused")
        } else if let next = routine.nextRunAt {
            state = String(localized: "next run \(nextRun(next))", comment: "After a scheduled task's times: next run tomorrow at 9:00 AM")
        } else if schedule?.cadence == .once, routine.lastRunAt != nil {
            state = String(localized: "Finished", comment: "A one-time scheduled task that already ran")
        } else {
            state = String(localized: "Waiting for its next time", comment: "A scheduled task whose next run the server hasn't set yet")
        }
        guard let schedule else { return state }
        return "\(self.schedule(schedule)) · \(state)"
    }

    /// The routine's last run, for the row's third line and the sheet: "Last run today at 9:00 AM
    /// · Posted"; nil before the first run.
    func lastRun(_ routine: Routine) -> String? {
        guard let status = routine.lastRunStatus else { return nil }
        let word = String(localized: Self.lastStatusWord(status))
        guard let at = routine.lastRunAt else { return word }
        return String(localized: "Last run \(nextRun(at)) · \(word)", comment: "A scheduled task's last run: when, then Posted / Skipped / Failed")
    }

    static func lastStatusWord(_ status: Routine.LastStatus) -> LocalizedStringResource {
        switch status {
        case .completed: "Posted"
        case .resolved: "Resolved"
        case .skipped: "Skipped"
        case .failed: "Failed"
        }
    }

    /// "Monday" for the contract's weekday (0 = Sunday ... 6 = Saturday), in the locale.
    func weekdayName(_ weekday: Int) -> String {
        var calendar = format.calendar
        calendar.locale = format.locale
        let names = calendar.standaloneWeekdaySymbols
        return names[((weekday % 7) + 7) % 7]
    }
}
