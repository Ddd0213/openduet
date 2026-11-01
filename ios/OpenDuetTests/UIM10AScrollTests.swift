// M10a chat scrolling and the composer's circle (plan 2.8): when a bubble's sideways pan may take
// a touch from the thread (distance + angle), the ↓ circle's visibility from the live scroll
// position (hysteresis, following), and waveform / ■ / ↑.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M10a scrolling rules")
struct UIM10AScrollTests {
    private func decide(_ dx: CGFloat, _ dy: CGFloat, right: Bool = true) -> BubbleSwipeDecision {
        BubbleSwipeRules.decide(dx: dx, dy: dy, allowsRight: right)
    }

    @Test("A vertical or steep drag on a bubble gives way to scrolling after a few points")
    func steepYields() {
        #expect(decide(0, 7) == .yield)
        #expect(decide(1, -9) == .yield)
        // The M9 bug: 9 pt sideways with 6 pt down (~34°) used to claim the touch.
        #expect(decide(9, 6) == .yield)
        #expect(decide(-14, 8) == .yield, "about 30°: still a scroll")
        #expect(decide(30, 30) == .yield)
    }

    @Test("Only a clearly sideways drag past the distance threshold takes over")
    func shallowClaims() {
        #expect(decide(12, 0) == .horizontal)
        #expect(decide(-12, 0) == .horizontal)
        #expect(decide(-20, 6) == .horizontal, "about 17°")
        #expect(decide(20, -9) == .horizontal, "about 24°")
        #expect(decide(-20, 10) == .yield, "about 27°: past the 25° limit")
    }

    @Test("Short moves stay undecided: nobody has the touch yet")
    func shortUndecided() {
        #expect(decide(0, 0) == .undecided)
        #expect(decide(4, 3) == .undecided, "5 pt: below both thresholds, even if steep")
        #expect(decide(10, 0) == .undecided, "sideways but still short of 12 pt")
        #expect(decide(-11, 2) == .undecided)
    }

    @Test("A right swipe on a bubble that doesn't quote yields; a left swipe still takes over")
    func disallowedRight() {
        #expect(decide(14, 0, right: false) == .yield)
        #expect(decide(7, 0, right: false) == .yield)
        #expect(decide(-14, 0, right: false) == .horizontal)
        #expect(decide(14, 0, right: true) == .horizontal)
    }

    @Test("↓ hides near the bottom, shows when scrolled up, with hysteresis between")
    func jumpHysteresis() {
        let show = JumpButtonRule.showBeyond, hide = JumpButtonRule.hideWithin
        #expect(hide < show)
        // Scrolled up by hand: shows past the show line only.
        #expect(!JumpButtonRule.visible(fromBottom: show - 1, wasVisible: false, following: false, userScrolling: true))
        #expect(JumpButtonRule.visible(fromBottom: show + 1, wasVisible: false, following: false, userScrolling: true))
        // Between the lines it keeps what it showed.
        #expect(JumpButtonRule.visible(fromBottom: (hide + show) / 2, wasVisible: true, following: false, userScrolling: true))
        #expect(!JumpButtonRule.visible(fromBottom: (hide + show) / 2, wasVisible: false, following: false, userScrolling: true))
        // Back at the bottom by hand: hidden, whatever it showed before.
        #expect(!JumpButtonRule.visible(fromBottom: hide - 1, wasVisible: true, following: false, userScrolling: true))
        #expect(!JumpButtonRule.visible(fromBottom: 0, wasVisible: true, following: true, userScrolling: false))
        #expect(!JumpButtonRule.visible(fromBottom: -40, wasVisible: true, following: false, userScrolling: false), "overscroll")
    }

    @Test("↓ reads the distance from two measured edges: 0 at the bottom, whatever the bars above it")
    func jumpMeasuredDistance() {
        // At the very bottom the content ends where the unobscured area ends (the composer's top),
        // however tall the composer, tab bar and their spacing are: nothing below, so no ↓.
        #expect(JumpButtonRule.fromBottom(contentEnd: 640, visibleBottom: 640) == 0)
        #expect(!JumpButtonRule.visible(fromBottom: JumpButtonRule.fromBottom(contentEnd: 640.4, visibleBottom: 640), wasVisible: true, following: false, userScrolling: false))
        // Scrolled up by 300: 300 below; a short thread (content above the bars) is at the bottom.
        #expect(JumpButtonRule.fromBottom(contentEnd: 940.3, visibleBottom: 640) == 300)
        #expect(JumpButtonRule.fromBottom(contentEnd: 410, visibleBottom: 640) == 0)
        // A shown ↓ goes once the user is back within hideWithin of the bottom.
        let near = JumpButtonRule.fromBottom(contentEnd: 640 + JumpButtonRule.hideWithin - 1, visibleBottom: 640)
        #expect(!JumpButtonRule.visible(fromBottom: near, wasVisible: true, following: false, userScrolling: true))
        #expect(JumpButtonRule.atBottomAtRest(fromBottom: near))
        #expect(JumpButtonRule.fromBottom(contentEnd: .infinity, visibleBottom: 640) == 0)
    }

    @Test("↓ never flashes for text growing under a thread that follows the bottom")
    func jumpFollowing() {
        // A streaming reply grows below while the thread follows: no circle.
        #expect(!JumpButtonRule.visible(fromBottom: 200, wasVisible: false, following: true, userScrolling: false))
        // The user flicks up out of following: it shows.
        #expect(JumpButtonRule.visible(fromBottom: 200, wasVisible: false, following: true, userScrolling: true))
        // Not following (scrolled up earlier): it shows from the geometry alone.
        #expect(JumpButtonRule.visible(fromBottom: 200, wasVisible: false, following: false, userScrolling: false))
        // Following never hides a circle already shown far from the bottom.
        #expect(JumpButtonRule.visible(fromBottom: 200, wasVisible: true, following: true, userScrolling: false))
    }

    @Test("Scrolling stopped close to the bottom counts as at the bottom")
    func atRest() {
        #expect(JumpButtonRule.atBottomAtRest(fromBottom: 0))
        #expect(JumpButtonRule.atBottomAtRest(fromBottom: JumpButtonRule.restTolerance - 1))
        #expect(!JumpButtonRule.atBottomAtRest(fromBottom: JumpButtonRule.restTolerance + 1))
    }

    @Test("The composer's circle: waveform when idle, ■ while OpenDuet replies, ↑ with content")
    func composerAction() {
        #expect(ComposerAction.make(hasContent: false, replying: false) == .voice)
        #expect(ComposerAction.make(hasContent: false, replying: true) == .stop)
        #expect(ComposerAction.make(hasContent: true, replying: false) == .send)
        #expect(ComposerAction.make(hasContent: true, replying: true) == .send, "typed text queues, as today")
    }
}
