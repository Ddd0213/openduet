// SwiftUI text for the run records' words (RunCopy): built-in names through the String Catalog,
// Composio names and server text as sent.
import SwiftUI

extension Text {
    /// A tool / app / source name the server sends as a plain string: the catalog's text for the
    /// built-in set (contract §4), else the name as sent.
    init(builtInName name: String) {
        if let resource = RunCopy.builtInName(name) {
            self.init(resource)
        } else {
            self.init(verbatim: name)
        }
    }

    /// A run or step title: a known key's catalog text, or the server's own text.
    init(runTitle phrase: Phrase) {
        switch RunCopy.resolve(phrase) {
        case .localized(let resource): self.init(resource)
        case .text(let text): self.init(verbatim: text)
        }
    }
}

enum RunTexts {
    /// The plain string of a built-in name in the current locale (for interpolating into other
    /// localized strings, e.g. "Approve %@").
    static func builtInName(_ name: String) -> String {
        RunCopy.builtInName(name).map { String(localized: $0) } ?? name
    }

    /// The plain string of a run or step title (VoiceOver, Copy).
    static func title(_ phrase: Phrase) -> String {
        switch RunCopy.resolve(phrase) {
        case .localized(let resource): String(localized: resource)
        case .text(let text): text
        }
    }
}
