// M29 AppLocale: dates and durations in the app's language on the iPhone's region and clock,
// so an English app on a Chinese phone reads "a reminder for Oct 31 at 17:00" and "37 sec",
// never "10月31日" or "37秒" inside English text.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("App locale")
struct UIAppLocaleTests {
    /// Monday 2026-10-19, 09:00 UTC.
    private static let now = Date(timeIntervalSince1970: 1_792_368_000 + 9 * 3600)
    /// Saturday 2026-10-31, 17:00 UTC.
    private static let reminder = Date(timeIntervalSince1970: 1_792_368_000 + 12 * 86_400 + 17 * 3600)

    private func resolve(_ language: String?, on system: String) -> Locale {
        AppLocale.resolve(language: language, system: Locale(identifier: system))
    }

    private func dates(_ locale: Locale) -> ChatDateFormat {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return ChatDateFormat(
            locale: locale, calendar: calendar, timeZone: .gmt, now: Self.now,
            joinDayAndTime: { day, time in "\(day) at \(time)" }
        )
    }

    /// ICU puts a narrow no-break space before AM / PM.
    private func plain(_ s: String) -> String {
        s.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    @Test("an English app on a Chinese phone: English dates on the phone's region and 24-hour clock")
    func englishOnChinesePhone() {
        let locale = resolve("en", on: "zh_CN")
        #expect(locale.language.languageCode == .english)
        #expect(locale.region?.identifier == "CN")
        #expect(locale.hourCycle == Locale(identifier: "zh_CN").hourCycle)
        let formatter = PhraseFormatter(dates: dates(locale), lookup: { _ in "OpenDuet set a reminder for {at}." })
        let phrase = Phrase(key: "system.reminder_set", params: ["at": .datetime(Self.reminder)])
        #expect(plain(formatter.string(phrase)) == "OpenDuet set a reminder for Oct 31 at 17:00.")
        #expect(PhraseFormatter.duration(37, locale: locale) == "37 sec")
        #expect(PhraseFormatter.duration(37, locale: locale) != PhraseFormatter.duration(37, locale: Locale(identifier: "zh_CN")))
    }

    @Test("the phone's 12-hour setting carries over")
    func hourCycle() {
        let locale = resolve("en", on: "zh_CN@hours=h12")
        #expect(locale.hourCycle == .oneToTwelve)
        #expect(plain(dates(locale).time(Self.reminder)) == "5:00 PM")
        let english24 = resolve("zh-Hans", on: "en_US@hours=h23")
        #expect(english24.hourCycle == .zeroToTwentyThree)
        #expect(dates(english24).time(Self.reminder) == "17:00")
    }

    @Test("a Chinese app on an American phone: Chinese dates on the US region")
    func chineseOnAmericanPhone() {
        let locale = resolve("zh-Hans", on: "en_US")
        #expect(locale.language.languageCode == .chinese)
        #expect(locale.language.script == .hanSimplified)
        #expect(locale.region?.identifier == "US")
        let d = dates(locale)
        #expect(d.dayAndTime(Self.reminder).hasPrefix("10月31日"))
        #expect(d.time(Self.reminder).contains("下午"))
        #expect(PhraseFormatter.duration(37, locale: locale).contains("秒"))
    }

    @Test("a phone already in the app's language is used as it is")
    func sameLanguage() {
        for (language, system) in [("zh-Hans", "zh_CN"), ("zh-Hans", "zh-Hans_CN"), ("en", "en_GB"), ("en", "en_US@hours=h23")] {
            let phone = Locale(identifier: system)
            #expect(AppLocale.resolve(language: language, system: phone) == phone, "\(language) on \(system)")
        }
        #expect(dates(resolve("en", on: "en_GB")).dayAndTime(Self.reminder) == "31 Oct at 17:00")
    }

    @Test("Simplified Chinese on a Traditional Chinese phone switches the script, keeps the region")
    func script() {
        let locale = resolve("zh-Hans", on: "zh-Hant_TW")
        #expect(locale.language.script == .hanSimplified)
        #expect(locale.region?.identifier == "TW")
    }

    @Test("no usable language: the phone's locale")
    func fallback() {
        let phone = Locale(identifier: "zh_CN")
        for language in [nil, "", "Base"] as [String?] {
            #expect(AppLocale.resolve(language: language, system: phone) == phone, "\(language ?? "nil")")
        }
    }

    @Test("first weekday and calendar come from the phone")
    func weekAndCalendar() {
        #expect(resolve("en", on: "de_DE").firstDayOfWeek == .monday)
        #expect(resolve("zh-Hans", on: "en_US@fw=mon").firstDayOfWeek == .monday)
        #expect(resolve("en", on: "ja_JP@calendar=japanese").calendar.identifier == .japanese)
    }
}
