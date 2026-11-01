// UIKit recognizers for the chat bubbles (M9), attached with UIGestureRecognizerRepresentable
// (iOS 18+), so they take part in UIKit's own arbitration with the thread's scroll view:
// - BubblePanRecognizer: a horizontal pan the scroll view's pan waits for. M10: it decides with
//   BubbleSwipeRules (Chat/ThreadScrollRules.swift): anything steeper than 25° gives way after
//   6 pt, so the scroll view scrolls; only a drag at least 12 pt long and within 25° of the
//   horizontal takes over. M9 took the touch after 8 pt at up to ~40°, so the first points of a
//   slightly diagonal flick on a bubble claimed it and the thread didn't scroll. It never starts
//   in the left 32 pt (side menu / task back swipe) nor inside a horizontally scrollable box (a
//   code block or a table in the assistant's markdown), and only starts rightward where that is allowed.
// - BubbleLongPressGesture: a 0.35 s press (it wins over the text selection's own, slower press);
//   a scroll or a swipe that starts first cancels it.
import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

final class BubblePanRecognizer: UIPanGestureRecognizer {
    /// A drag starting this close to the screen's leading edge belongs to the menu / back swipe.
    /// M19: the shell's screen-edge pan that opens the side menu needs at least the first 24 pt;
    /// this fails in touchesBegan, before any movement, so that pan wins there.
    static let edgeGuard: CGFloat = 32

    var allowsRight = false
    private var start: CGPoint?
    /// M10: the drag was judged sideways (BubbleSwipeRules); from here UIKit's pan runs it.
    private var claimed = false

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        guard let touch = touches.first, let window = touch.window else {
            state = .failed
            return
        }
        let point = touch.location(in: window)
        if Self.nearLeadingEdge(point, in: window) || Self.insideHorizontalScroller(touch.view) {
            state = .failed
            return
        }
        start = point
    }

    /// Within `edgeGuard` of the screen's leading edge (window coordinates; the right edge in a
    /// right-to-left layout).
    private static func nearLeadingEdge(_ point: CGPoint, in window: UIWindow) -> Bool {
        let rightToLeft = window.effectiveUserInterfaceLayoutDirection == .rightToLeft
        let fromLeading = rightToLeft ? window.bounds.width - point.x : point.x
        return fromLeading < edgeGuard
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        if state == .possible, !claimed {
            guard let start, let touch = touches.first, let window = touch.window else {
                state = .failed
                return
            }
            let point = touch.location(in: window)
            // M10: steep or disallowed drags give way after a few points (the scroll view, which
            // waits for this pan to fail, then scrolls); only a clearly sideways one takes over.
            switch BubbleSwipeRules.decide(dx: point.x - start.x, dy: point.y - start.y, allowsRight: allowsRight) {
            case .yield:
                state = .failed
                return
            case .undecided:
                // Not decided yet: keep the pan from beginning on its own first points.
                return
            case .horizontal:
                claimed = true
            }
        }
        super.touchesMoved(touches, with: event)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        // A tap or a press that never moved far enough: fail now, never linger in .possible.
        if state == .possible { state = .failed }
        super.touchesEnded(touches, with: event)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        if state == .possible { state = .failed }
        super.touchesCancelled(touches, with: event)
    }

    override func reset() {
        super.reset()
        start = nil
        claimed = false
    }

    /// The scroll view's pan waits for this one to decide.
    override func shouldBeRequiredToFail(by other: UIGestureRecognizer) -> Bool {
        other is UIPanGestureRecognizer && other.view is UIScrollView
    }

    private static func insideHorizontalScroller(_ view: UIView?) -> Bool {
        var view = view
        while let current = view {
            if let scroll = current as? UIScrollView,
               scroll.contentSize.width > scroll.bounds.width + 1 {
                return true
            }
            view = current.superview
        }
        return false
    }
}

/// The pan, as SwiftUI sees it: the horizontal offset while it moves, and its end.
struct BubblePanGesture: UIGestureRecognizerRepresentable {
    var allowsRight: Bool
    var onChange: (CGFloat) -> Void
    var onEnd: (CGFloat) -> Void

    func makeUIGestureRecognizer(context: Context) -> BubblePanRecognizer {
        let recognizer = BubblePanRecognizer()
        recognizer.maximumNumberOfTouches = 1
        recognizer.allowsRight = allowsRight
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: BubblePanRecognizer, context: Context) {
        recognizer.allowsRight = allowsRight
    }

    func handleUIGestureRecognizerAction(_ recognizer: BubblePanRecognizer, context: Context) {
        let dx = recognizer.translation(in: recognizer.view?.window).x
        switch recognizer.state {
        case .began, .changed: onChange(dx)
        case .ended: onEnd(dx)
        case .cancelled, .failed: onEnd(0)
        default: break
        }
    }
}

/// The 0.35 s press on a bubble, reporting where its window's safe area is.
struct BubbleLongPressGesture: UIGestureRecognizerRepresentable {
    var onPress: (_ safeArea: UIEdgeInsets) -> Void

    func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
        let recognizer = UILongPressGestureRecognizer()
        recognizer.minimumPressDuration = 0.35
        recognizer.allowableMovement = 10
        return recognizer
    }

    func handleUIGestureRecognizerAction(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        guard recognizer.state == .began else { return }
        onPress(recognizer.view?.window?.safeAreaInsets ?? .zero)
    }
}
