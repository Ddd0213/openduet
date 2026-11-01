// The shell's tabs (prompt L96, L161). M19 (decided by the user): they live in the system tab bar
// (TabView + Tab: iOS 26 Liquid Glass with press-and-slide between tabs; iOS 18 the standard bar),
// replacing M2-M10's hand-drawn floating capsule. The bar never minimizes while scrolling. M6
// (L152): an artifact added to the tab bar is a 4th tab named after it; "Remove from tab bar" is in
// that page's ⋯ menu and the Make gallery's long-press menu. M21: with the 4th tab all four tabs
// are icons only (TabBarRule, names kept for VoiceOver) and a long-press on the 4th offers
// "Remove from tab bar" too (TabContent.contextMenu, iOS 18; the other two entries stay).
import SwiftUI

enum AppTab: Hashable, Sendable {
    case chat, tasks, make
    /// M6: the artifact added to the tab bar (L152).
    case pinned

    var title: LocalizedStringResource {
        switch self {
        case .chat: "Chat"
        case .tasks: "Tasks"
        case .make: "Make"
        case .pinned: "Pinned"
        }
    }

    /// The tab bar item's SF Symbol (the 4th tab uses its artifact type's own).
    var systemImage: String {
        switch self {
        case .chat: DuetGlyph.chat.symbol
        case .tasks: DuetGlyph.tasks.symbol
        case .make: DuetGlyph.make.symbol
        case .pinned: DuetGlyph.pin.symbol
        }
    }
}

/// iOS 26: the tab bar always shows in full, never shrinking while a page scrolls (the user's
/// call). Earlier systems have no minimizing.
struct NeverMinimizeTabBar: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.tabBarMinimizeBehavior(.never)
        } else {
            content
        }
    }
}
