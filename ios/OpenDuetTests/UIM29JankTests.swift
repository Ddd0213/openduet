// M29 jank: a thread pinned to the bottom follows its own content (a new row, a streaming reply,
// the typing row going) animated and one follow at a time, with the top as the size-change anchor
// while nothing else moves (ContentFollowRule).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M29 a pinned thread follows its content")
struct UIM29JankTests {
    /// Visible area 100...700; the content's top is scrolled above it unless said otherwise.
    private func step(end: CGFloat, top: CGFloat = -2000, pinned: Bool = true, armed: Bool = true,
                      scrolling: Bool = false, jumping: Bool = false, insetMoving: Bool = false,
                      holding: Bool = false, followHeight: CGFloat? = nil) -> ContentFollowRule.Step {
        ContentFollowRule.step(contentTop: top, contentEnd: end, visibleTop: 100, visibleBottom: 700,
                               pinned: pinned, armed: armed, userScrolling: scrolling, jumping: jumping,
                               insetMoving: insetMoving, holdingBottom: holding, followHeight: followHeight)
    }

    @Test("The size-change anchor: the top when pinned and still; as before otherwise")
    func anchor() {
        typealias Rule = ContentFollowRule
        #expect(Rule.sizeChangeAnchor(hasHeader: false, holdingBottom: false, atBottom: true, settling: false) == .top,
                "pinned: new content grows in below the visible bottom, then is followed")
        #expect(Rule.sizeChangeAnchor(hasHeader: false, holdingBottom: false, atBottom: false, settling: false) == .top)
        #expect(Rule.sizeChangeAnchor(hasHeader: false, holdingBottom: false, atBottom: true, settling: true) == .bottom,
                "the list just appeared, or the keyboard / composer / tab bar moves")
        #expect(Rule.sizeChangeAnchor(hasHeader: false, holdingBottom: false, atBottom: false, settling: true) == .top)
        #expect(Rule.sizeChangeAnchor(hasHeader: false, holdingBottom: true, atBottom: false, settling: false) == .bottom,
                "an older page keeps the reading position")
        #expect(Rule.sizeChangeAnchor(hasHeader: false, holdingBottom: true, atBottom: true, settling: false) == .bottom)
        #expect(Rule.sizeChangeAnchor(hasHeader: true, holdingBottom: false, atBottom: true, settling: false) == .bottom,
                "task detail: unchanged")
        #expect(Rule.sizeChangeAnchor(hasHeader: true, holdingBottom: false, atBottom: false, settling: false) == .top)
    }

    @Test("Growth past the slack below the visible bottom is followed; within it, not")
    func followsGrowth() {
        #expect(step(end: 700) == .none)
        #expect(step(end: 700 + ContentFollowRule.slack) == .none)
        #expect(step(end: 722) == .follow, "a new line of a streaming reply")
        #expect(step(end: 730) == .follow, "the typing row or the user's message")
        #expect(step(end: 2700) == .follow)
    }

    @Test("Shrinking under a pinned thread is followed back to the end, never left past it")
    func followsShrink() {
        #expect(step(end: 670) == .follow, "the typing row went: 30 pt of blank otherwise")
        #expect(step(end: 695) == .none, "within the slack")
        #expect(step(end: 670, top: 100) == .none, "a short thread resting at its top isn't past its end")
    }

    @Test("Nothing follows when not pinned, a drag, a jump, the visible bottom moving or an older page")
    func blocked() {
        #expect(step(end: 900, pinned: false) == .none, "the user scrolled up")
        #expect(step(end: 900, armed: false) == .none, "task detail before the user went to the bottom")
        #expect(step(end: 900, scrolling: true) == .none)
        #expect(step(end: 900, jumping: true) == .none, "a send's / ↓ jump is under way")
        #expect(step(end: 900, insetMoving: true) == .none, "followVisibleBottom's, on the keyboard's curve")
        #expect(step(end: 900, holding: true) == .none)
        #expect(step(end: .nan) == .none)
    }

    @Test("While a follow is under way, growth is merged and the follow's own frames aren't")
    func merges() {
        // A follow started for content 2700 tall (top -2000, end 700).
        #expect(step(end: 722, top: -1978, followHeight: 2700) == .none, "the follow's frames: the same height, scrolled")
        #expect(step(end: 744, top: -1978, followHeight: 2700) == .merge, "22 pt more content meanwhile")
        #expect(step(end: 744, followHeight: 2700) == .merge)
        #expect(step(end: 705, followHeight: 2600) == .none, "at the end: nothing to merge")
    }

    @Test("Curves: the rows' spring, Reduce Motion's ease, at once off screen, on opening or past a screen")
    func curves() {
        typealias Rule = ContentFollowRule
        #expect(Rule.curve(reduceMotion: false, onScreen: true, justAppeared: false, distance: 30, visibleHeight: 600) == .spring)
        #expect(Rule.curve(reduceMotion: true, onScreen: true, justAppeared: false, distance: 30, visibleHeight: 600) == .ease)
        #expect(Rule.curve(reduceMotion: false, onScreen: true, justAppeared: false, distance: -30, visibleHeight: 600) == .spring)
        #expect(Rule.curve(reduceMotion: false, onScreen: false, justAppeared: false, distance: 30, visibleHeight: 600) == .instant)
        #expect(Rule.curve(reduceMotion: false, onScreen: true, justAppeared: true, distance: 30, visibleHeight: 600) == .instant)
        #expect(Rule.curve(reduceMotion: false, onScreen: true, justAppeared: false, distance: 900, visibleHeight: 600) == .instant)
        #expect(Rule.curve(reduceMotion: false, onScreen: true, justAppeared: false, distance: .infinity, visibleHeight: 600) == .instant)
        #expect(Rule.seconds(.spring) == 0.45)
        #expect(Rule.seconds(.ease) == 0.2)
        #expect(Rule.seconds(.instant) > 0, "a burst of updates is still one follow")
    }

    @Test("Reason: a row just added is an insert; else a shrink or the stream")
    func reasons() {
        typealias Rule = ContentFollowRule
        #expect(Rule.reason(sinceInsert: 0.1, below: 30) == .insert)
        #expect(Rule.reason(sinceInsert: 0.1, below: -30) == .insert)
        #expect(Rule.reason(sinceInsert: 2, below: 22) == .stream)
        #expect(Rule.reason(sinceInsert: nil, below: 22) == .stream)
        #expect(Rule.reason(sinceInsert: 2, below: -30) == .shrink)
    }

    @Test("The log: inserts and shrinks always; the stream and catch-ups at most every half second")
    func logThrottle() {
        typealias Rule = ContentFollowRule
        #expect(Rule.logs(.insert, sinceLog: 0.01))
        #expect(Rule.logs(.shrink, sinceLog: 0.01))
        #expect(!Rule.logs(.stream, sinceLog: 0.2))
        #expect(!Rule.logs(.catchUp, sinceLog: 0.2))
        #expect(Rule.logs(.stream, sinceLog: Rule.logInterval))
        #expect(Rule.logs(.catchUp, sinceLog: nil))
    }
}
