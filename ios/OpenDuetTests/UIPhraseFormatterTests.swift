// PhraseFormatter and ChatDateFormat: server phrases filled with app-formatted params, and the
// chat's date separators, in English and Simplified Chinese.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Phrase formatter")
struct UIPhraseFormatterTests {
    /// Midnight UTC starting Monday 2026-10-19.
    private static let midnight: Double = 1_792_368_000
    /// That Monday, 09:00 UTC.
    private static let now = Date(timeIntervalSince1970: midnight + 9 * 3600)

    private func dates(_ identifier: String = "en_US") -> ChatDateFormat {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return ChatDateFormat(
            locale: Locale(identifier: identifier), calendar: calendar, timeZone: .gmt, now: Self.now,
            joinDayAndTime: { day, time in identifier.hasPrefix("zh") ? "\(day)\(time)" : "\(day) at \(time)" }
        )
    }

    private func formatter(_ identifier: String = "en_US", catalog: [String: String] = [:]) -> PhraseFormatter {
        PhraseFormatter(dates: dates(identifier), lookup: { key in catalog[key] ?? key })
    }

    /// ICU puts a narrow no-break space before AM / PM.
    private func plain(_ s: String) -> String {
        s.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    private func at(day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        Date(timeIntervalSince1970: Self.midnight + Double(day) * 86_400 + Double(hour) * 3600 + Double(minute) * 60)
    }

    @Test("model text shows as written; keys come from the catalog")
    func textAndKeys() {
        let f = formatter(catalog: ["system.feedback_thanks": "Thanks for the feedback"])
        #expect(f.string(Phrase(key: "system.feedback_thanks", text: "Model wrote this")) == "Model wrote this")
        #expect(f.string(Phrase(key: "system.feedback_thanks")) == "Thanks for the feedback")
    }

    @Test("params fill {name}; unknown placeholders stay")
    func fill() {
        let f = formatter(catalog: ["system.reminder_set": "Claude set a reminder for {at}."])
        let phrase = Phrase(key: "system.reminder_set", params: ["at": .datetime(at(day: 7, 10))])
        #expect(plain(f.string(phrase)) == "Claude set a reminder for Oct 26 at 10:00 AM.")
        #expect(f.fill("{a} and {b}", params: ["a": .text("x")]) == "x and {b}")
        #expect(f.fill("{n} files", params: ["n": .number(1234.5)]) == "1,234.5 files")
    }

    @Test("relative datetimes: today, a weekday within the week, else the date")
    func relative() {
        let d = dates()
        #expect(plain(d.relativeDayAndTime(at(day: 0, 11))) == "today at 11:00 AM")
        #expect(plain(d.relativeDayAndTime(at(day: 3, 11))) == "Thursday at 11:00 AM")
        #expect(plain(d.relativeDayAndTime(at(day: 10, 11))) == "Oct 29 at 11:00 AM")
    }

    @Test("durations")
    func durations() {
        #expect(PhraseFormatter.duration(480, locale: Locale(identifier: "en_US")) == "8 min")
        #expect(PhraseFormatter.duration(480, locale: Locale(identifier: "zh_Hans")).contains("8"))
    }

    @Test("date separators: Today / Yesterday / weekday / date")
    func separators() {
        let d = dates()
        #expect(plain(d.separator(at(day: 0, 8, 47))) == "Today 8:47 AM")
        #expect(plain(d.separator(at(day: -1, 18, 2))) == "Yesterday 6:02 PM")
        #expect(plain(d.separator(at(day: -3, 9, 15))).hasPrefix("Friday"))
        #expect(plain(d.separator(at(day: -20, 9, 15))).hasPrefix("Sep 29"))
    }

    @Test("Simplified Chinese")
    func chinese() {
        let d = dates("zh_Hans")
        #expect(d.separator(at(day: 0, 8, 47)).hasPrefix("今天"))
        let thursday = d.relativeDayAndTime(at(day: 3, 11))
        #expect(thursday.contains("星期四") && thursday.contains("11:00"))
    }
}
