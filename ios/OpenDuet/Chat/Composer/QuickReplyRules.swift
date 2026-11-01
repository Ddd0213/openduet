// M23 W5 (#31, prompt L105 as changed in the M23 contract): how each row of the quick-reply card
// looks. Before a choice every row is live (primary text, trailing ↗); once one is chosen (here or
// on the server) it turns bold with a ✓ and the others fade and stop responding; options of an
// earlier turn fade the same way (M21). The card itself stays. Pure Foundation (host-tested).
import Foundation

enum QuickReplyRules {
    enum Row: Hashable, Sendable {
        /// tappable: sends the option
        case live
        /// the one chosen: bold, ✓, takes no tap
        case chosen
        /// another one was chosen, or the turn moved on: faded, takes no tap
        case faded
    }

    /// Faded rows' opacity (the text, the ↗ and the hairline under them).
    static let fadedOpacity: Double = 0.35

    /// `chosen`: the server's answer, else the option tapped here before the echo.
    static func row(_ option: String, chosen: String?, stale: Bool) -> Row {
        if let chosen { return option == chosen ? .chosen : .faded }
        return stale ? .faded : .live
    }

    /// No row takes a tap: one was chosen, or an earlier turn's options.
    static func isLocked(chosen: String?, stale: Bool) -> Bool {
        chosen != nil || stale
    }
}
