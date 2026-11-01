// The Usage screen's numbers (Account/UsageMath.swift, prompt L128, L79): whole percentages
// rounded down and capped, the red bar only at the limit, no limit = no percentage, "Resets in
// 13 hr" in one unit, the full reset's last day and compact token counts.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Usage math")
struct UIUsageMathTests {
    private static let now = Date(timeIntervalSince1970: 1_792_400_000)
    private static let en = Locale(identifier: "en_US")

    @Test func percentRoundsDownAndCaps() {
        #expect(UsageMath.percent(used: 0, limit: 3_000_000) == 0)
        #expect(UsageMath.percent(used: 29_999, limit: 3_000_000) == 0)
        #expect(UsageMath.percent(used: 30_000, limit: 3_000_000) == 1)
        #expect(UsageMath.percent(used: 2_999_999, limit: 3_000_000) == 99)
        #expect(UsageMath.percent(used: 3_000_000, limit: 3_000_000) == 100)
        #expect(UsageMath.percent(used: 5_000_000, limit: 3_000_000) == 100)
        #expect(UsageMath.percent(used: -5, limit: 3_000_000) == 0)
    }

    @Test func noLimitHasNoPercentAndNoFill() {
        #expect(UsageMath.percent(used: 1_234, limit: 0) == nil)
        #expect(UsageMath.fraction(used: 1_234, limit: 0) == 0)
        #expect(UsageMath.level(used: 99_999_999, limit: 0) == .normal)
    }

    @Test func barTurnsRedOnlyAtTheLimit() {
        #expect(UsageMath.level(used: 2_999_999, limit: 3_000_000) == .normal)
        #expect(UsageMath.level(used: 3_000_000, limit: 3_000_000) == .full)
        #expect(UsageMath.level(used: 3_500_000, limit: 3_000_000) == .full)
        #expect(UsageMath.fraction(used: 1_500_000, limit: 3_000_000) == 0.5)
        #expect(UsageMath.fraction(used: 4_000_000, limit: 3_000_000) == 1)
    }

    @Test func resetsInUsesOneUnitAndNeverZero() {
        let now = Self.now
        #expect(UsageMath.resetsIn(now.addingTimeInterval(13 * 3600 + 600), now: now, locale: Self.en) == "13 hr")
        #expect(UsageMath.resetsIn(now.addingTimeInterval(3 * 3600 - 300), now: now, locale: Self.en) == "3 hr")
        #expect(UsageMath.resetsIn(now.addingTimeInterval(45 * 60 - 20), now: now, locale: Self.en) == "45 min")
        #expect(UsageMath.resetsIn(now.addingTimeInterval(20), now: now, locale: Self.en) == "1 min")
        #expect(UsageMath.resetsIn(now.addingTimeInterval(-60), now: now, locale: Self.en) == "1 min")
        #expect(UsageMath.resetsIn(now.addingTimeInterval(59 * 60 + 30), now: now, locale: Self.en) == "1 hr")
        #expect(UsageMath.resetsIn(now.addingTimeInterval(36 * 3600), now: now, locale: Self.en) == "36 hr")
        #expect(UsageMath.resetsIn(now.addingTimeInterval(3 * 86_400 + 3600), now: now, locale: Self.en).hasPrefix("3"))
        #expect(UsageMath.resetsIn(now.addingTimeInterval(3 * 3600), now: now, locale: Locale(identifier: "zh_Hans_CN")).contains("3"))
        #expect(UsageMath.resetsIn(now.addingTimeInterval(3 * 3600), now: now, locale: Locale(identifier: "zh_Hans_CN")).contains("小时"))
    }

    @Test func expiryDayIsTheMonthsLastDay() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let firstOfDecember = calendar.date(from: DateComponents(year: 2026, month: 12, day: 1))!
        let endOfNovember = calendar.date(from: DateComponents(year: 2026, month: 11, day: 30, hour: 23, minute: 59, second: 59))!
        #expect(UsageMath.expiryDay(firstOfDecember, calendar: calendar, locale: Self.en) == "Nov 30")
        #expect(UsageMath.expiryDay(endOfNovember, calendar: calendar, locale: Self.en) == "Nov 30")
        #expect(UsageMath.expiryDay(firstOfDecember, calendar: calendar, locale: Locale(identifier: "zh_Hans_CN")) == "11月30日")
    }

    @Test func tokensAreCompact() {
        #expect(UsageMath.tokens(1_234_567, locale: Self.en) == "1.2M")
        #expect(UsageMath.tokens(950, locale: Self.en) == "950")
        #expect(UsageMath.tokens(1_200_000, locale: Locale(identifier: "zh_Hans_CN")) == "120万")
    }
}
