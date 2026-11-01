// M10 (prompt L96, L114; plan 2.8 "聊天滑动卡住" / "回到底部按钮"): the two decisions behind the
// chat's scrolling, as pure rules (host-tested).
// - BubbleSwipeRules: when a bubble's horizontal pan (BubblePanRecognizer) may take a touch from
//   the thread's scroll view. The scroll view's pan waits for the bubble's to fail, so the bubble
//   has to give way early on anything steep and only take over after a clearly sideways move
//   (distance + angle), never on the first few jittery points of a vertical flick.
// - JumpButtonRule: the ↓ circle comes from the live scroll position only (never from a tap),
//   with a little hysteresis so it doesn't flicker at the edge, and without flashing while a
//   streaming reply grows under a thread that follows the bottom.
// - OverscrollRule (M19): the thread came to rest past its own end (blank), so it jumps back.
// - FocusScrollRule (M29): when a deep link's message may be scrolled to, and whether the scroll
//   really brought it into view (only then is the link's focus done).
// - ContentFollowRule (M29): how a thread pinned to the bottom follows its own content growing
//   or shrinking (a new row, a streaming reply): animated, coalesced, never an instant jump.
import Foundation

/// A drag on a bubble, decided from its travel since touch-down.
enum BubbleSwipeDecision: Equatable, Sendable {
    /// Too short to tell yet: nobody has the touch (the scroll view waits a moment).
    case undecided
    /// Clearly sideways: the bubble's swipe takes the touch.
    case horizontal
    /// Steep, vertical, or a direction this bubble doesn't swipe: the scroll view gets it.
    case yield
}

enum BubbleSwipeRules {
    /// Travel before a sideways drag may take over (points).
    static let claimDistance: CGFloat = 12
    /// Travel after which a steep (or disallowed) drag gives way to scrolling at once.
    static let yieldDistance: CGFloat = 6
    /// The widest angle from the horizontal that still counts as sideways (degrees).
    static let maxAngle: Double = 25

    /// `dx`, `dy`: the finger's travel since touch-down; `allowsRight`: the bubble quotes on a
    /// right swipe (the assistant's text bubbles), else only a left swipe (its time) is a swipe.
    static func decide(dx: CGFloat, dy: CGFloat, allowsRight: Bool) -> BubbleSwipeDecision {
        let ax = abs(dx), ay = abs(dy)
        let distance = (ax * ax + ay * ay).squareRoot()
        if distance >= yieldDistance {
            if ay > ax * slope { return .yield }
            if dx > 0 && !allowsRight { return .yield }
        }
        return distance >= claimDistance ? .horizontal : .undecided
    }

    private static var slope: CGFloat { CGFloat(tan(maxAngle * .pi / 180)) }
}

/// The ↓ scroll-to-bottom circle (prompt L96: "appears when scrolled up").
enum JumpButtonRule {
    /// Hidden once the newest content is this close to the visible bottom (points)...
    static let hideWithin: CGFloat = 24
    /// ...and shown again only once it is this far below.
    static let showBeyond: CGFloat = 60
    /// Scrolling stopped this close to the bottom counts as being there (the thread closes the
    /// last points itself and follows again).
    static let restTolerance: CGFloat = 60

    /// Whether ↓ shows, from the live scroll geometry.
    /// - `fromBottom`: how much content lies below the visible bottom;
    /// - `wasVisible`: what the circle showed a moment ago (hysteresis);
    /// - `following`: the thread keeps itself at the bottom, so new text growing under it (and
    ///   followed at once) never shows the circle on its own;
    /// - `userScrolling`: the finger or its fling is moving the thread.
    static func visible(fromBottom: CGFloat, wasVisible: Bool, following: Bool, userScrolling: Bool) -> Bool {
        if fromBottom < hideWithin { return false }
        if wasVisible { return true }
        guard fromBottom > showBeyond else { return false }
        return userScrolling || !following
    }

    /// Scrolling has stopped: within `restTolerance` the thread is at the bottom (no ↓).
    static func atBottomAtRest(fromBottom: CGFloat) -> Bool {
        fromBottom < restTolerance
    }

    /// How much content lies below the visible bottom, from two measured edges in one coordinate
    /// space (global): the bottom of the thread's content (`contentEnd`) and the bottom of the
    /// scroll view's unobscured area, i.e. the top of the composer and tab bar (`visibleBottom`).
    /// Measured, not derived from ScrollGeometry's offset, size and insets: on iOS 26 under the
    /// shell's safe-area bars that arithmetic stayed above `hideWithin` at the very bottom, so ↓
    /// never went. Rounded to whole points; never negative (a short thread is at the bottom).
    static func fromBottom(contentEnd: CGFloat, visibleBottom: CGFloat) -> CGFloat {
        guard contentEnd.isFinite, visibleBottom.isFinite else { return 0 }
        return max(contentEnd - visibleBottom, 0).rounded()
    }
}

/// M19: the thread scrolled past its own end (the content's bottom edge well above the visible
/// bottom), which `fromBottom` reads as "at the bottom" (it never goes below 0). Seen on a device
/// after a send: the animated jump raced the keyboard going down, the tab bar springing back and
/// the new row animating in, the offset stayed past the end and the whole thread was blank until
/// the user switched away. A short thread whose content fits isn't past its end: it rests at the
/// top with empty room below it.
enum OverscrollRule {
    /// More empty room than this between the content's end and the visible bottom (points).
    static let tolerance: CGFloat = 40

    /// The empty room below the content's end (negative: content still lies below the bottom).
    static func gap(contentEnd: CGFloat, visibleBottom: CGFloat) -> CGFloat {
        guard contentEnd.isFinite, visibleBottom.isFinite else { return 0 }
        return (visibleBottom - contentEnd).rounded()
    }

    /// Past the end: more than `tolerance` of empty room below the content although the content
    /// (`contentTop`...`contentEnd`) is scrolled up past the visible top (`visibleTop`...
    /// `visibleBottom`), all in one coordinate space (global). A thread resting at its top with
    /// room below (short) isn't; one shorter than the visible area but scrolled up is (the keyboard
    /// went down and left the offset where it was).
    static func isPastEnd(contentTop: CGFloat, contentEnd: CGFloat, visibleTop: CGFloat, visibleBottom: CGFloat) -> Bool {
        guard contentTop.isFinite, contentEnd.isFinite, visibleTop.isFinite, visibleBottom.isFinite else { return false }
        let scrolledUp = contentTop < visibleTop - 1
        return scrolledUp && gap(contentEnd: contentEnd, visibleBottom: visibleBottom) > tolerance
    }
}

/// M29: a deep link's message (ThreadState.focus). The Chat tab's thread stays alive under the
/// other tabs, so a link tapped on Tasks set the focus while the thread was off screen: its
/// scroll then didn't stick and the focus was dropped anyway, leaving the thread at the bottom.
/// Now the scroll waits for the thread to be on screen and laid out, and the focus is done only
/// once the row is measured inside the visible area.
enum FocusScrollRule {
    /// What the thread does next for the focus.
    enum Step: Equatable, Sendable {
        /// not ready yet (layout, an older page going in): check again shortly
        case wait
        /// scroll the row to the centre (again)
        case scroll
        /// the row is in view: the focus is done
        case done
        /// the user took over, or the scrolls never brought it into view: the focus is dropped
        case letGo
    }

    /// Scroll attempts while the thread is on screen before the focus is let go.
    static let maxAttempts = 3
    /// Rounds of `wait` after which the scroll goes ahead anyway.
    static let maxWaits = 25
    /// How much of the row (or of the visible area, for a row taller than it) must be in view.
    static let shownFraction: CGFloat = 0.5

    /// The scroll may run: the thread is on screen (`active`), both of its edges have been
    /// measured (`laidOut`), no older page is being prepended under a held bottom anchor
    /// (`holdingBottom`), and the user isn't scrolling it themselves.
    static func mayScroll(active: Bool, laidOut: Bool, holdingBottom: Bool, userScrolling: Bool) -> Bool {
        active && laidOut && !holdingBottom && !userScrolling
    }

    /// The next step. `attempts`: scrolls made so far; `waits`: rounds spent waiting; `shown`:
    /// the row is measured in view (isShown). Off screen it only waits (the thread checks again
    /// once it is on screen); the user's own scroll lets it go; it is done only after a scroll.
    static func next(active: Bool, laidOut: Bool, holdingBottom: Bool, userScrolling: Bool,
                     attempts: Int, waits: Int, shown: Bool) -> Step {
        guard active else { return .wait }
        if userScrolling { return .letGo }
        if attempts > 0 && shown { return .done }
        if attempts >= maxAttempts { return .letGo }
        if mayScroll(active: active, laidOut: laidOut, holdingBottom: holdingBottom, userScrolling: userScrolling) || waits >= maxWaits {
            return .scroll
        }
        return .wait
    }

    /// The row (`rowTop`...`rowBottom`) lies in the visible area (`visibleTop`...`visibleBottom`),
    /// all in one coordinate space: at least `shownFraction` of the row, or of the visible area
    /// when the row is taller than it. Nothing measured (not finite, empty) isn't shown.
    static func isShown(rowTop: CGFloat, rowBottom: CGFloat, visibleTop: CGFloat, visibleBottom: CGFloat) -> Bool {
        guard rowTop.isFinite, rowBottom.isFinite, visibleTop.isFinite, visibleBottom.isFinite,
              rowBottom > rowTop, visibleBottom > visibleTop else { return false }
        let overlap = min(rowBottom, visibleBottom) - max(rowTop, visibleTop)
        let needed = min(rowBottom - rowTop, visibleBottom - visibleTop) * shownFraction
        return overlap >= needed
    }
}

/// M29: a thread pinned to the bottom following its own content (a new row, a streaming reply,
/// the typing row going). Before, the bottom anchor for size changes moved the offset in the same
/// layout pass, outside the rows' animation: the rows above jumped up in one frame while the new
/// row faded in below them, and a streaming reply jumped a line at a time. Now, pinned and with
/// nothing else moving, the anchor is the top (the new content grows in below the visible bottom)
/// and the thread follows it animated, one follow at a time: what grows meanwhile is merged and
/// followed once that one is over.
enum ContentFollowRule {
    enum Anchor: String, Equatable, Sendable { case top, bottom }

    enum Step: Equatable, Sendable {
        /// nothing to follow
        case none
        /// start an animated follow to the bottom
        case follow
        /// a follow is under way: note it, follow again once it is over
        case merge
    }

    enum Curve: String, Equatable, Sendable {
        /// the rows' own spring (ThreadView.rowAnimation)
        case spring
        /// Reduce Motion
        case ease
        /// nobody sees it (off screen), or more than a screen to cover: at once
        case instant
    }

    /// Why a follow ran (the log).
    enum Reason: String, Equatable, Sendable {
        case insert, stream, shrink, catchUp
    }

    /// The content's end may lie this far from the visible bottom before the thread follows
    /// (points; layout rounding and the last row's padding stay under it, a new line doesn't).
    static let slack: CGFloat = 10
    /// How long a follow's curve takes before the thread looks again (seconds; the spring's
    /// response 0.42, Reduce Motion's ease 0.2).
    static let springSeconds: Double = 0.45
    static let easeSeconds: Double = 0.2
    /// The bottom anchor is kept this long after the list appears or the visible bottom last moved
    /// (keyboard, composer, tab bar), as before M29: those are followed by the anchor and
    /// followVisibleBottom, not by this rule.
    static let settleSeconds: Double = 0.5
    /// A streaming follow is logged at most this often (seconds); an insert or a shrink always.
    static let logInterval: Double = 0.5
    /// A row was added this recently (seconds): the follow is for it, not the stream.
    static let insertWindow: Double = 0.6

    /// The anchor for size changes. With a header (task detail), while an older page is held under
    /// the bottom, or when not pinned: as before (bottom when holding or pinned, else top). Pinned
    /// and with nothing else moving (`settling` false: the list has appeared, the visible bottom
    /// is still): top, and the thread follows the growth itself (step).
    static func sizeChangeAnchor(hasHeader: Bool, holdingBottom: Bool, atBottom: Bool, settling: Bool) -> Anchor {
        if hasHeader || holdingBottom || settling { return holdingBottom || atBottom ? .bottom : .top }
        // Not pinned: the top as before; pinned: the top too, and step follows the growth.
        return .top
    }

    /// After a layout pass: whether the thread follows its content.
    /// - `contentTop`, `contentEnd`, `visibleTop`, `visibleBottom`: the measured edges (global);
    /// - `pinned`, `armed`: atBottom and followArmed; `userScrolling`; `jumping`: an animated jump
    ///   (programmatic) is on its way; `insetMoving`: the visible bottom moved in this pass (that is
    ///   followVisibleBottom's); `holdingBottom`: an older page goes in under the held anchor;
    /// - `followHeight`: the content's height when the follow under way started, nil when none is.
    /// Content more than `slack` below the visible bottom, or (scrolled up) its end more than
    /// `slack` above it (the typing row went: never past the end), is followed; while a follow is
    /// under way, only a change of the content's height (not that follow's own frames) is merged.
    static func step(contentTop: CGFloat, contentEnd: CGFloat, visibleTop: CGFloat, visibleBottom: CGFloat,
                     pinned: Bool, armed: Bool, userScrolling: Bool, jumping: Bool, insetMoving: Bool,
                     holdingBottom: Bool, followHeight: CGFloat?) -> Step {
        guard contentTop.isFinite, contentEnd.isFinite, visibleTop.isFinite, visibleBottom.isFinite else { return .none }
        guard pinned, armed, !userScrolling, !jumping, !insetMoving, !holdingBottom else { return .none }
        let below = contentEnd - visibleBottom
        let scrolledUp = contentTop < visibleTop - 1
        let off = below > slack || (scrolledUp && below < -slack)
        guard off else { return .none }
        guard let followHeight else { return .follow }
        return abs((contentEnd - contentTop) - followHeight) > 1 ? .merge : .none
    }

    /// The curve of a follow covering `distance` points of a `visibleHeight` area. At once off
    /// screen, while the list has just appeared (`justAppeared`: rows still being measured, as
    /// before M29 it opens at the bottom without a slide), or for more than a screen.
    static func curve(reduceMotion: Bool, onScreen: Bool, justAppeared: Bool, distance: CGFloat, visibleHeight: CGFloat) -> Curve {
        guard onScreen, !justAppeared, distance.isFinite, visibleHeight > 0, abs(distance) <= visibleHeight else { return .instant }
        return reduceMotion ? .ease : .spring
    }

    /// How long the thread waits after starting a follow before it looks again (seconds; at least
    /// a frame for an instant one, so a burst of updates is still one follow).
    static func seconds(_ curve: Curve) -> Double {
        switch curve {
        case .spring: springSeconds
        case .ease: easeSeconds
        case .instant: 0.05
        }
    }

    /// Why this follow: a row was added within `insertWindow` (`sinceInsert`, seconds; nil = none
    /// yet), else the content's end above the visible bottom (`below` < 0) is a shrink, else the
    /// stream. A follow once a previous one ended is a catch-up (the caller says so).
    static func reason(sinceInsert: Double?, below: CGFloat) -> Reason {
        if let sinceInsert, sinceInsert >= 0, sinceInsert < insertWindow { return .insert }
        return below < 0 ? .shrink : .stream
    }

    /// Whether a follow is logged: an insert or a shrink always; the stream and catch-ups at most
    /// every `logInterval` (`sinceLog`, seconds since the last line; nil = none yet).
    static func logs(_ reason: Reason, sinceLog: Double?) -> Bool {
        switch reason {
        case .insert, .shrink: true
        case .stream, .catchUp: sinceLog.map { $0 >= logInterval } ?? true
        }
    }
}
