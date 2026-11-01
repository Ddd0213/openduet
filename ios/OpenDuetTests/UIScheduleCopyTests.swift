// Tasks > Scheduled copy (Tasks/ScheduleCopy.swift, prompt L118, L89): the brief and check-in
// times in the locale's 12/24-hour style, the check-in list without the serial comma in English
// and in Chinese list style, the next run and each past run's day, and the history order.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Schedule copy")
struct UIScheduleCopyTests {
    private static let zone = TimeZone(identifier: "America/Los_Angeles")!
    /// Tuesday 2026-11-03 09:00 in Los Angeles.
    private static let now: Date = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.date(from: DateComponents(year: 2026, month: 11, day: 3, hour: 9, minute: 0))!
    }()

    private func copy(_ identifier: String = "en_US") -> ScheduleCopy {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = Self.zone
        return ScheduleCopy(format: ChatDateFormat(
            locale: Locale(identifier: identifier), calendar: calendar, timeZone: Self.zone, now: Self.now,
            joinDayAndTime: { day, time in identifier.hasPrefix("zh") ? "\(day) \(time)" : "\(day) at \(time)" }
        ))
    }

    /// ICU puts a narrow no-break space before AM/PM; compare with plain spaces.
    private func plain(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    private func at(day: Int, _ hour: Int, _ minute: Int) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = Self.zone
        return calendar.date(from: DateComponents(year: 2026, month: 11, day: day, hour: hour, minute: minute))!
    }

    private static let checkins = [22, 10, 16, 13, 19].map { LocalTime(hour: $0, minute: 49) }

    @Test func briefTimeFollowsTheLocaleClock() {
        #expect(plain(copy().time(LocalTime(hour: 8, minute: 19))) == "8:19 AM")
        #expect(copy("en_GB").time(LocalTime(hour: 8, minute: 19)) == "08:19")
        #expect(copy("en_GB").time(LocalTime(hour: 22, minute: 49)) == "22:49")
        #expect(copy("zh_Hans_CN").time(LocalTime(hour: 8, minute: 19)).contains("8:19"))
    }

    @Test func checkinListIsSortedWithoutTheSerialComma() {
        #expect(plain(copy().timeList(Self.checkins)) == "10:49 AM, 1:49 PM, 4:49 PM, 7:49 PM and 10:49 PM")
        #expect(plain(copy().timeList([LocalTime(hour: 8, minute: 19)])) == "8:19 AM")
        #expect(plain(copy().timeList([LocalTime(hour: 13, minute: 49), LocalTime(hour: 10, minute: 49)])) == "10:49 AM and 1:49 PM")
    }

    @Test func checkinListReadsNaturallyInChinese() {
        let list = copy("zh_Hans_CN").timeList(Self.checkins)
        #expect(list.contains("、"))
        #expect(list.contains("和"))
        #expect(!list.contains(","))
        // zh_Hans_CN uses a 24-hour clock: the time follows the locale's hour cycle.
        #expect(list.hasPrefix("10:49"))
        #expect(list.hasSuffix("22:49"))
    }

    @Test func nextRunIsRelativeMidSentence() {
        #expect(plain(copy().nextRun(at(day: 4, 8, 19))) == "tomorrow at 8:19 AM")
        #expect(plain(copy().nextRun(at(day: 3, 16, 49))) == "today at 4:49 PM")
        // Friday evening's next weekday brief is Monday.
        #expect(plain(copy().nextRun(at(day: 9, 8, 19))) == "Monday at 8:19 AM")
    }

    @Test func pastRunsStartTheirLineCapitalised() {
        #expect(plain(copy().runDay(at(day: 3, 13, 49))) == "Today at 1:49 PM")
        #expect(plain(copy().runDay(at(day: 2, 22, 49))) == "Yesterday at 10:49 PM")
        #expect(copy("zh_Hans_CN").runDay(at(day: 3, 13, 49)).hasPrefix("今天"))
    }

    @Test func historyIsNewestFirstBySlotThenStart() {
        let runs = [
            RunRecord(id: "a", kind: .checkin, scheduledFor: at(day: 3, 10, 49), startedAt: nil, status: .skipped),
            RunRecord(id: "b", kind: .checkin, scheduledFor: nil, startedAt: at(day: 3, 11, 5), status: .completed),
            RunRecord(id: "c", kind: .checkin, scheduledFor: at(day: 2, 22, 49), startedAt: at(day: 2, 22, 49), status: .resolved),
            RunRecord(id: "d", kind: .checkin, scheduledFor: at(day: 3, 13, 49), startedAt: at(day: 3, 13, 49), status: .resolved),
        ]
        #expect(ScheduleCopy.history(runs).map(\.id) == ["d", "b", "a", "c"])
        #expect(ScheduleCopy.history(runs, limit: 2).map(\.id) == ["d", "b"])
        #expect(ScheduleCopy.runDate(runs[1]) == at(day: 3, 11, 5))
    }
}
