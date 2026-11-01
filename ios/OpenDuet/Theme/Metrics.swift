// Sizes, radii and spacing (prompt L82, L95-L97, DETAILS THAT MATTER L161).
import CoreGraphics

enum Metrics {
    // Bubbles
    static let bubbleCorner: CGFloat = 20
    static let bubbleMaxWidthFraction: CGFloat = 0.80
    static let bubbleSpacing: CGFloat = 6

    // Header
    static let headerCircle: CGFloat = 44
    static let headerMascot: CGFloat = 64

    // Composer and Make FAB above the system tab bar (L161; M19: the system bar replaced the
    // floating capsule)
    static let composerAboveTabBar: CGFloat = 8
    static let fabAboveTabBar: CGFloat = 16
    /// The FAB's trailing inset, about where the system tab bar ends.
    static let fabTrailing: CGFloat = 20

    // Cards
    static let cardCorner: CGFloat = 18
    static let hairline: CGFloat = 0.5
}
