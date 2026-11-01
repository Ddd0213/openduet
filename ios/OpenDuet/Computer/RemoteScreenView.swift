// The live screen of "OpenDuet's computer" in UIKit: a zoomable scroll view (pinch to zoom up to
// 4x, double-tap to zoom while the assistant drives) holding the newest frame fitted to the width. Once
// the user has taken over, a tap clicks, a one-finger drag scrolls the page, touch-and-hold then
// move drags, and two fingers pan the zoomed screen; every point goes out as 0...1 fractions of
// the frame. While the assistant drives, a one-finger swipe down (zoomed out) closes the view (not in
// M27's landscape full screen: `dismissible` false).
// M27 W6 (ComputerGeometry.screenFit): every frame sits at the top. Upright, the 1280 × 800 page
// fills the width right under the app's tab strip and address bar (`joinedTop`: square top
// corners, so the two read as one window); a portrait or headed window shrinks to show all of it;
// when shrinking would make it unreadable (the keyboard is up) it starts zoomed in to the full
// width at its top and pans like a zoomed screen. In the landscape full screen the view is the
// frame's own scaled rect. Points are measured on the image at zoom 1, so zoom, panning and the
// scale never change which fraction of the whole frame a tap sends.
import SwiftUI
import UIKit

struct RemoteScreenView: UIViewRepresentable {
    var image: UIImage?
    var pixelSize: CGSize
    var interactive: Bool
    var label: String
    var value: String
    var hint: String
    var onInput: (ComputerClientMessage) -> Void
    var onDismissDrag: (_ translation: CGFloat, _ ended: Bool, _ predicted: CGFloat) -> Void
    /// M27 W6: the bar is right above (only the bottom corners are rounded)
    var joinedTop = false
    /// M27 W6: the swipe down closes the view (off in the landscape full screen)
    var dismissible = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeUIView(context: Context) -> RemoteScreenScrollView {
        RemoteScreenScrollView()
    }

    func updateUIView(_ view: RemoteScreenScrollView, context: Context) {
        view.onInput = onInput
        view.onDismissDrag = onDismissDrag
        view.reduceMotion = reduceMotion
        view.setChrome(joinedTop: joinedTop, dismissible: dismissible)
        view.update(image: image, pixelSize: pixelSize, interactive: interactive)
        view.accessibilityLabel = label
        view.accessibilityValue = value
        view.accessibilityHint = hint
        view.accessibilityTraits = interactive ? [.image, .allowsDirectInteraction] : [.image]
    }
}

final class RemoteScreenScrollView: UIScrollView, UIScrollViewDelegate {
    var onInput: (ComputerClientMessage) -> Void = { _ in }
    var onDismissDrag: (_ translation: CGFloat, _ ended: Bool, _ predicted: CGFloat) -> Void = { _, _, _ in }
    var reduceMotion = false

    let imageView = UIImageView()
    private(set) var pageSize = CGSize(width: 1600, height: 1000)
    private(set) var interactive = false
    private var fittedForBounds: CGSize = .zero
    private var fittedLandscape = false
    /// from ComputerGeometry.screenFit (M27 W6: every frame top-aligned; the double-tap zoom)
    private var topAligned = true
    private(set) var doubleTapScale = ComputerGeometry.doubleTapZoom

    let tapRecognizer = UITapGestureRecognizer()
    let doubleTapRecognizer = UITapGestureRecognizer()
    let scrollRecognizer = UIPanGestureRecognizer()
    let holdRecognizer = UILongPressGestureRecognizer()
    let dismissRecognizer = UIPanGestureRecognizer()
    private lazy var coordinator = RemoteScreenGestureCoordinator(screen: self)
    var sentScroll: CGPoint = .zero
    var holdStart: ComputerClientMessage.Point?

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = 4
        bouncesZoom = true
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        backgroundColor = .clear
        isAccessibilityElement = true
        imageView.contentMode = .scaleToFill
        imageView.layer.cornerRadius = 12
        imageView.layer.cornerCurve = .continuous
        imageView.clipsToBounds = true
        addSubview(imageView)
        installGestures()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private func installGestures() {
        tapRecognizer.addTarget(self, action: #selector(handleTap(_:)))
        doubleTapRecognizer.numberOfTapsRequired = 2
        doubleTapRecognizer.addTarget(self, action: #selector(handleDoubleTap(_:)))
        scrollRecognizer.maximumNumberOfTouches = 1
        scrollRecognizer.addTarget(self, action: #selector(handleScroll(_:)))
        holdRecognizer.minimumPressDuration = 0.35
        holdRecognizer.allowableMovement = .greatestFiniteMagnitude
        holdRecognizer.addTarget(self, action: #selector(handleHold(_:)))
        dismissRecognizer.maximumNumberOfTouches = 1
        dismissRecognizer.delegate = coordinator
        dismissRecognizer.addTarget(self, action: #selector(handleDismiss(_:)))
        for recognizer in [tapRecognizer, doubleTapRecognizer, scrollRecognizer, holdRecognizer, dismissRecognizer] {
            addGestureRecognizer(recognizer)
        }
        setInteractive(false)
    }

    // MARK: - Content

    func update(image: UIImage?, pixelSize: CGSize, interactive: Bool) {
        if imageView.image !== image { imageView.image = image }
        let size: CGSize
        if pixelSize.width > 0, pixelSize.height > 0 {
            size = pixelSize
        } else if let image, image.size.width > 0, image.size.height > 0 {
            size = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        } else {
            size = pageSize
        }
        if size != pageSize {
            pageSize = size
            refit()
        }
        if interactive != self.interactive { setInteractive(interactive) }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != fittedForBounds || isLandscapePhone != fittedLandscape { refit() }
    }

    /// iPhone only (TARGETED_DEVICE_FAMILY 1): a compact height means the phone is sideways. Read
    /// in layoutSubviews, so iOS 18's automatic trait tracking lays out again when it changes.
    private var isLandscapePhone: Bool { traitCollection.verticalSizeClass == .compact }

    /// ComputerGeometry.screenFit: the frame fitted to the width, or shrunk to the height when that
    /// limits it, at the top (M27 W6: the page too, under the bar); when shrinking would make it
    /// unreadable it starts zoomed in to the full width at its top. Zoom reset.
    private func refit() {
        guard bounds.width > 0, bounds.height > 0 else { return }
        fittedForBounds = bounds.size
        fittedLandscape = isLandscapePhone
        let fit = ComputerGeometry.screenFit(frame: pageSize, in: bounds.size, landscape: fittedLandscape)
        topAligned = fit.topAligned
        doubleTapScale = fit.doubleTapZoom
        zoomScale = 1
        maximumZoomScale = fit.maxZoom
        imageView.frame = CGRect(origin: .zero, size: fit.size)
        contentSize = fit.size
        centerImage()
        if fit.startZoom > 1.01 {
            zoomScale = fit.startZoom
            centerImage()
            contentOffset = .zero
        }
        isScrollEnabled = zoomScale > 1.01
    }

    /// Keeps the image centred across while it is narrower than the view; down, it stays at the
    /// top (M27 W6: the page right under the app's bar; a portrait window's own bar under the top
    /// bar).
    func centerImage() {
        let x = max((bounds.width - contentSize.width) / 2, 0)
        let y = topAligned ? 0 : max((bounds.height - contentSize.height) / 2, 0)
        imageView.center = CGPoint(x: contentSize.width / 2 + x, y: contentSize.height / 2 + y)
    }

    /// The image's size at zoom 1, the space every input point is measured in.
    var baseSize: CGSize { imageView.bounds.size }

    /// M27 W6: square top corners under the bar; the swipe down only where it closes the view.
    func setChrome(joinedTop: Bool, dismissible: Bool) {
        let corners: CACornerMask = joinedTop
            ? [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
            : [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner]
        if imageView.layer.maskedCorners != corners { imageView.layer.maskedCorners = corners }
        if dismissRecognizer.isEnabled != dismissible { dismissRecognizer.isEnabled = dismissible }
    }

    func setInteractive(_ on: Bool) {
        interactive = on
        tapRecognizer.isEnabled = on
        scrollRecognizer.isEnabled = on
        holdRecognizer.isEnabled = on
        doubleTapRecognizer.isEnabled = !on
        // While the user drives, one finger belongs to the page; two pan the zoomed screen.
        panGestureRecognizer.minimumNumberOfTouches = on ? 2 : 1
        isScrollEnabled = zoomScale > 1.01
    }

    // MARK: - UIScrollViewDelegate

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        centerImage()
        isScrollEnabled = zoomScale > 1.01
    }
}
