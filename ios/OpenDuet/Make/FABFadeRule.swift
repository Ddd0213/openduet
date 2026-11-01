// M10: the Make FAB fades out while the gallery scrolls and fades back ~0.4 s after scrolling
// stops. The rule only: which scroll phase hides it, which one brings it back after the pause.
// SwiftUI's ScrollPhase is mapped onto `Phase` by the view (MakeTabView), so this stays pure
// Foundation (host-tested). A finger that rests on the gallery without moving (`tracking`)
// changes nothing, so a tap on a tile never blinks the FAB.
import Foundation

enum FABFadeRule {
    /// SwiftUI's ScrollPhase, one to one.
    enum Phase: Hashable, Sendable { case idle, tracking, interacting, decelerating, animating }

    enum Step: Hashable, Sendable {
        /// fade out now (and drop a pending fade-in)
        case hide
        /// fade back in after `delay`
        case showAfterDelay
        /// leave it as it is
        case keep
    }

    /// The pause after scrolling stops before the FAB comes back.
    static let delay: Duration = .milliseconds(400)

    static func step(for phase: Phase, hidden: Bool) -> Step {
        switch phase {
        case .interacting, .decelerating, .animating: .hide
        case .idle: hidden ? .showAfterDelay : .keep
        case .tracking: .keep
        }
    }

    /// The gallery's bottom padding, so the last tiles always scroll clear of the FAB and the tab
    /// bar. `inset` is the scroll view's measured bottom inset (the bottom chrome's safe area,
    /// which normally already holds the bar and the FAB's slot); `chrome` is how far the FAB's
    /// top sits above the screen bottom. At least `base`; more when the inset turns out smaller
    /// than the chrome (so the last tile still ends `gap` above the FAB).
    static func bottomPadding(inset: Double, chrome: Double, base: Double = 120, gap: Double = 24) -> Double {
        max(base, chrome + gap - max(inset, 0))
    }
}
