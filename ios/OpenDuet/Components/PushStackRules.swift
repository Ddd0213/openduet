// M19: the page hierarchy inside a sheet or the side menu (PushContainer). Each page names its
// parent (nil = the container's root). Changing the page from A to B is a pop when B is one of
// A's ancestors (A slides out to the trailing edge, revealing B), a push when B's parent is A (B
// slides in over A), and a replace otherwise (B slides in over A like a push; A stays drawn under
// it until it is covered). Plus the release rule the edge swipes share (back swipe, side menu
// pull). Foundation only, so the Mac host tests drive it.
import Foundation

enum PushStackMove: Hashable, Sendable {
    /// the same page: nothing moves
    case none
    /// the new page is a child of the old one (or of the root, from the root)
    case push
    /// the new page is an ancestor of the old one (or the root)
    case pop
    /// neither: a sibling, a cousin, or a page deeper than one level from the old one
    case replace
}

enum PushStackRules {
    /// The pages above `page`, nearest first, without the root (which is every page's last
    /// ancestor). `limit` stops a parent function that loops.
    static func ancestors<Page: Hashable>(of page: Page, parent: (Page) -> Page?, limit: Int = 32) -> [Page] {
        var chain: [Page] = []
        var next = parent(page)
        while let current = next, chain.count < limit, current != page, !chain.contains(current) {
            chain.append(current)
            next = parent(current)
        }
        return chain
    }

    /// How the container moves from `old` to `new` (nil = the root). `oldAncestors` is the chain
    /// of `old` as it was shown (ancestors(of: old)); `newParent` is the parent of `new`.
    static func move<Page: Hashable>(from old: Page?, to new: Page?, oldAncestors: [Page], newParent: Page?) -> PushStackMove {
        guard old != new else { return .none }
        guard let new else { return .pop }
        if oldAncestors.contains(new) { return .pop }
        return newParent == old ? .push : .replace
    }

    /// Convenience over `move(from:to:oldAncestors:newParent:)` with one parent function.
    static func move<Page: Hashable>(from old: Page?, to new: Page?, parent: (Page) -> Page?) -> PushStackMove {
        move(
            from: old, to: new,
            oldAncestors: old.map { ancestors(of: $0, parent: parent) } ?? [],
            newParent: new.flatMap(parent)
        )
    }

    // MARK: - Edge swipes

    /// A swipe that follows the finger commits when released past a third of `length` or when
    /// its projected end (a flick) reaches half of it.
    static func swipeCommits(translation: CGFloat, projected: CGFloat, length: CGFloat) -> Bool {
        guard length > 0 else { return false }
        return translation > length / 3 || projected > length / 2
    }

    /// Where a UIKit pan would come to rest: the translation plus the distance its release velocity
    /// (points per second) carries it, like SwiftUI's predictedEndTranslation.
    static func projected(translation: CGFloat, velocity: CGFloat) -> CGFloat {
        translation + velocity * 0.15
    }
}
