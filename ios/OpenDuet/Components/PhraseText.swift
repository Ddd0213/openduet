// Server-built text (Phrase) rendered in the app's language: model text as written, or the
// catalog string for its key with `{name}` params formatted by PhraseFormatter.
import SwiftUI

struct PhraseText: View {
    var phrase: Phrase

    @Environment(\.locale) private var locale
    @Environment(\.calendar) private var calendar
    @Environment(\.timeZone) private var timeZone

    var body: some View {
        // Already localized (or model-written) text: never looked up again.
        Text(verbatim: Self.string(phrase, locale: locale, calendar: calendar, timeZone: timeZone))
    }

    static func string(_ phrase: Phrase, locale: Locale = AppLocale.current, calendar: Calendar = .autoupdatingCurrent, timeZone: TimeZone = .autoupdatingCurrent) -> String {
        let dates = ChatDateFormat(locale: locale, calendar: calendar, timeZone: timeZone)
        return PhraseFormatter(dates: dates).string(phrase)
    }
}
