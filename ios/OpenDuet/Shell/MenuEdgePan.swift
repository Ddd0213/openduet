// M19: the pull from the screen's left edge that opens the side menu on the Chat tab. A UIKit
// screen-edge pan (iOS 18 UIGestureRecognizerRepresentable): it only begins on a sideways drag
// that starts within `edgeWidth` of the edge, so taps near the edge (a bubble, a link, the ≡
// circle) still land, and the thread's scroll view waits for it like a navigation controller's
// back swipe. The bubbles' swipe to quote ignores touches that start in the left 32 pt
// (BubblePanRecognizer.edgeGuard).
import SwiftUI
import UIKit

struct MenuEdgePan: UIGestureRecognizerRepresentable {
    /// The touch has to start this close to the screen's left edge.
    static let edgeWidth: CGFloat = 20

    var isEnabled: Bool
    /// The horizontal pull while the finger moves.
    var onChange: (CGFloat) -> Void
    /// Released: the pull and its projected end (a flick); 0, 0 when cancelled.
    var onEnd: (_ translation: CGFloat, _ projected: CGFloat) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator()
    }

    func makeUIGestureRecognizer(context: Context) -> UIScreenEdgePanGestureRecognizer {
        let recognizer = UIScreenEdgePanGestureRecognizer()
        recognizer.edges = .left
        recognizer.maximumNumberOfTouches = 1
        recognizer.delegate = context.coordinator
        recognizer.isEnabled = isEnabled
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        if recognizer.isEnabled != isEnabled { recognizer.isEnabled = isEnabled }
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        let window = recognizer.view?.window
        let dx = max(recognizer.translation(in: window).x, 0)
        switch recognizer.state {
        case .began, .changed:
            onChange(dx)
        case .ended:
            onEnd(dx, PushStackRules.projected(translation: dx, velocity: recognizer.velocity(in: window).x))
        case .cancelled, .failed:
            onEnd(0, 0)
        default:
            break
        }
    }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        /// Only a drag that started at the very edge (the system's edge zone is a little wider).
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer, let window = pan.view?.window else { return false }
            let start = pan.location(in: window).x - pan.translation(in: window).x
            return start <= MenuEdgePan.edgeWidth
        }

        /// The thread's scroll view waits for the edge pull to fail.
        func gestureRecognizer(
            _ recognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer
        ) -> Bool {
            other is UIPanGestureRecognizer && other.view is UIScrollView
        }
    }
}
