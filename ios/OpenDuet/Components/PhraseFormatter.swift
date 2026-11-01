// Server-built text (Phrase, docs/API.md Conventions): model text shows as written; a key is
// looked up in the String Catalog and its `{name}` placeholders are replaced by the params,
// formatted by the app (numbers in the locale, dates with the 12/24-hour setting, durations).
// Pure Foundation; PhraseText renders it.
import Foundation

struct PhraseFormatter: Sendable {
    var dates = ChatDateFormat()
    /// Catalog lookup of a phrase key; injectable for tests.
    var lookup: @Sendable (_ key: String) -> String = { key in String(localized: String.LocalizationValue(key)) }

    var locale: Locale { dates.locale }

    func string(_ phrase: Phrase) -> String {
        if let text = phrase.text { return text }
        guard let key = phrase.key else { return "" }
        return fill(lookup(key), params: phrase.params ?? [:])
    }

    /// Replaces every `{name}` that has a param; unknown placeholders stay visible as written.
    func fill(_ template: String, params: [String: PhraseParam]) -> String {
        guard !params.isEmpty, template.contains("{") else { return template }
        var result = ""
        var rest = Substring(template)
        while let open = rest.firstIndex(of: "{") {
            result += rest[..<open]
            let afterOpen = rest.index(after: open)
            guard let close = rest[afterOpen...].firstIndex(of: "}") else {
                rest = rest[open...]
                break
            }
            let name = String(rest[afterOpen..<close])
            if let param = params[name] {
                result += format(param)
            } else {
                result += rest[open...close]
            }
            rest = rest[rest.index(after: close)...]
        }
        return result + rest
    }

    func format(_ param: PhraseParam) -> String {
        switch param {
        case .text(let text):
            text
        case .number(let value):
            value.formatted(.number.locale(locale))
        case .datetime(let date):
            dates.dayAndTime(date)
        case .relativeDatetime(let date):
            dates.relativeDayAndTime(date)
        case .duration(let seconds):
            Self.duration(seconds, locale: locale)
        }
    }

    /// "8 min", "2 hr, 5 min", "45 sec" / "8分钟".
    static func duration(_ seconds: Double, locale: Locale) -> String {
        let units: Set<Duration.UnitsFormatStyle.Unit> = seconds < 60 ? [.seconds] : [.days, .hours, .minutes]
        return Duration.seconds(max(seconds, 0).rounded())
            .formatted(.units(allowed: units, width: .abbreviated, maximumUnitCount: 2).locale(locale))
    }
}
