// The live screen's gestures as browser input (RemoteScreenView): points are measured on the
// image at zoom 1 and sent as 0...1 fractions of the frame; scrolls are page pixels.
import UIKit

extension RemoteScreenScrollView {
    /// A point of the recognizer on the frame, nil when it fell outside the image.
    private func fraction(_ recognizer: UIGestureRecognizer, clamped: Bool) -> ComputerClientMessage.Point? {
        let point = recognizer.location(in: imageView)
        let size = baseSize
        if !clamped, !CGRect(origin: .zero, size: size).contains(point) { return nil }
        return ComputerGeometry.fraction(of: point, in: size)
    }

    @objc func handleTap(_ recognizer: UITapGestureRecognizer) {
        guard interactive, recognizer.state == .ended, let point = fraction(recognizer, clamped: false) else { return }
        onInput(.tap(point))
    }

    /// One finger scrolls the page, sent in steps of a few pixels while the finger moves.
    @objc func handleScroll(_ recognizer: UIPanGestureRecognizer) {
        guard interactive else { return }
        switch recognizer.state {
        case .began:
            sentScroll = .zero
        case .changed, .ended:
            let translation = recognizer.translation(in: imageView)
            let delta = CGSize(width: translation.x - sentScroll.x, height: translation.y - sentScroll.y)
            let step = ComputerGeometry.scroll(translation: delta, shown: baseSize, page: pageSize)
            guard abs(step.dx) >= 4 || abs(step.dy) >= 4 || recognizer.state == .ended else { return }
            if step.dx != 0 || step.dy != 0 { onInput(.scroll(dx: step.dx.rounded(), dy: step.dy.rounded())) }
            sentScroll = translation
        default:
            sentScroll = .zero
        }
    }

    /// Touch and hold, then move: a drag from where the finger landed to where it lifted.
    @objc func handleHold(_ recognizer: UILongPressGestureRecognizer) {
        guard interactive else { return }
        switch recognizer.state {
        case .began:
            holdStart = fraction(recognizer, clamped: false)
            if holdStart != nil { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
        case .ended:
            if let start = holdStart, let end = fraction(recognizer, clamped: true) {
                onInput(.drag(from: start, to: end))
            }
            holdStart = nil
        default:
            holdStart = nil
        }
    }

    /// While the assistant drives: double-tap zooms in on the point, or back out.
    @objc func handleDoubleTap(_ recognizer: UITapGestureRecognizer) {
        guard !interactive else { return }
        if zoomScale > 1.01 {
            setZoomScale(1, animated: !reduceMotion)
        } else {
            let point = recognizer.location(in: imageView)
            // 2.5x, or (M20b) back to the full width of a portrait window that starts zoomed in
            let scale = doubleTapScale
            let size = CGSize(width: bounds.width / scale, height: bounds.height / scale)
            zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: !reduceMotion)
        }
    }

    /// A one-finger swipe down at zoom 1 moves the whole view and closes it past a threshold.
    @objc func handleDismiss(_ recognizer: UIPanGestureRecognizer) {
        let translation = max(recognizer.translation(in: nil).y, 0)
        switch recognizer.state {
        case .changed:
            onDismissDrag(translation, false, 0)
        case .ended:
            let predicted = translation + max(recognizer.velocity(in: nil).y, 0) * 0.25
            onDismissDrag(translation, true, predicted)
        case .cancelled, .failed:
            onDismissDrag(0, true, 0)
        default:
            break
        }
    }
}

/// Lets the close swipe start only when it makes sense: the assistant drives, the screen isn't zoomed
/// and the finger moves mostly down.
@MainActor
final class RemoteScreenGestureCoordinator: NSObject, UIGestureRecognizerDelegate {
    weak var screen: RemoteScreenScrollView?

    init(screen: RemoteScreenScrollView) {
        self.screen = screen
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let screen, let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        guard !screen.interactive, screen.zoomScale <= 1.01 else { return false }
        let velocity = pan.velocity(in: screen)
        return velocity.y > 0 && abs(velocity.y) > abs(velocity.x)
    }
}
