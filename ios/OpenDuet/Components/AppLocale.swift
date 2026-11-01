// The locale dates, times, durations and numbers are formatted in: the language the app shows
// (its String Catalog, per-app language included) with the iPhone's region, 12/24-hour setting,
// first weekday and calendar. Locale.current keeps the phone's language when the app runs in
// another one (Settings → OpenDuet → Language), and then English text read "a reminder for
// 10月31日 at 17:00" and "Voice call · 37秒". RootView puts it in the environment; the
// formatters' defaults read it outside SwiftUI. Pure Foundation (host-tested).
import Foundation

enum AppLocale {
    /// The app's language on the iPhone's settings. Read each time (cheap); RootView keeps a copy
    /// and reads it again when the iPhone's region or clock setting changes.
    static var current: Locale {
        resolve(language: Bundle.main.preferredLocalizations.first, system: .autoupdatingCurrent)
    }

    /// `system` as it is when it already speaks `language` (so "zh-Hans" on a zh_CN phone stays
    /// zh_CN, autoupdating); else `language` on the system's region, hour cycle, first weekday,
    /// measurement system and calendar. No usable language ("", "Base", nil): `system`.
    static func resolve(language: String?, system: Locale) -> Locale {
        guard let language, !language.isEmpty, language != "Base" else { return system }
        let wanted = Locale.Language(identifier: language)
        guard let code = wanted.languageCode else { return system }
        let script = wanted.script
        let current = system.language
        if current.languageCode == code, script == nil || current.script == nil || current.script == script {
            return system
        }
        var components = Locale.Components(locale: system)
        components.languageComponents.languageCode = code
        components.languageComponents.script = script
        components.languageComponents.region = current.region ?? system.region
        components.region = system.region
        // Written out: the 12/24-hour switch and the other overrides are user settings, which a
        // locale made from components doesn't carry over by itself.
        components.hourCycle = system.hourCycle
        components.firstDayOfWeek = system.firstDayOfWeek
        components.measurementSystem = system.measurementSystem
        components.calendar = system.calendar.identifier
        return Locale(components: components)
    }
}
