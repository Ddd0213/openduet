// Floating chrome pinned to the top or bottom edge with the content scrolling under it (M8, M9).
// Every screen with a header or a bottom bar (shell, task detail, viewers) uses `duetBar`, so the
// layout and the backdrop under the chrome are decided here once.
//
// M9 (decided by the user, overrides M8's "system scroll-edge effect only" on iOS 26): the top and
// bottom chrome sit on a clear progressive mask on iOS 18 AND iOS 26 — a blur that is strongest at
// the screen edge and softens out with a fade toward the content (`ChromeMask`). The system edge
// effect is far too weak on device and never reaches inside a WKWebView, so it is hidden where our
// mask draws. Glass controls stay glass on iOS 26 and sample the mask. iOS 18 keeps prompt L161's
// opaque band behind the chrome (the mask's solid part is opaque there), iOS 26 a soft frosted one.
// After M13 (decided by the user, "option A"): the shell's header and bottom stack use a long soft
// fade instead (`long: EdgeFade.shellTop / .shellBottom`): solid only behind the status bar or the
// home indicator, easing out over most of the chrome. The Make viewer draws no mask at all (its
// bars take the page's own colour, ArtifactViewer); task detail and file previews keep the above.
//
// Layout: the bar spans the full width (so the mask always covers the edges, whatever the bar's own
// width). The mask is solid behind the bar and ramps out over `fade`: `spacing` of it lies outside
// the bar (kept free between the bar and the content), the rest inside the bar's own padding. So at
// rest the content's first / last line is never under the blur; while scrolling it passes under it.
import SwiftUI

enum ChromeBar {
    /// The mask's ramp from solid to clear (top bars put it inside their own bottom padding).
    static let fadeHeight: CGFloat = 24
    static let topFade: CGFloat = 20

    /// M19: the curve the bottom chrome and a thread pinned to the bottom move on when the
    /// keyboard comes up or goes down: close to the keyboard's own (no bounce, about a third of a
    /// second), so the composer, the tab bar and the messages travel with the keyboard.
    static func keyboardAnimation(reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeInOut(duration: 0.2) : .spring(duration: 0.35, bounce: 0)
    }
}

extension View {
    /// Pins `bar` to `edge` over a progressive blur mask (see the file header).
    /// - `fade`: the mask's ramp (nil = 20 pt on top, 24 pt below);
    /// - `spacing`: the room kept between the bar and the content, where the ramp's outer part
    ///   lies (nil = 0 on top, the whole ramp below);
    /// - `masked`: false when nothing should be drawn there (the 4th tab's viewer, which takes the
    ///   page's colour instead);
    /// - `long`: the shell's long soft fade (EdgeFade) instead of solid-then-`fade`; the layout
    ///   (`spacing`, where the content rests) is the same either way.
    func duetBar<Bar: View>(
        _ edge: VerticalEdge, fade: CGFloat? = nil, spacing: CGFloat? = nil, masked: Bool = true,
        long: EdgeFade? = nil, @ViewBuilder bar: () -> Bar
    ) -> some View {
        let fade = fade ?? (edge == .top ? ChromeBar.topFade : ChromeBar.fadeHeight)
        let spacing = min(spacing ?? (edge == .top ? 0 : fade), fade)
        return modifier(DuetBarModifier(edge: edge, fade: fade, spacing: spacing, masked: masked, long: long, bar: bar()))
    }

    /// The progressive mask behind a piece of edge chrome: solid from the screen edge to this
    /// view's inner edge minus the inside part of the ramp, then softening out `spacing` past it
    /// (with `long`, solid only near the screen edge and easing out over most of it).
    func chromeMask(_ edge: VerticalEdge, fade: CGFloat = ChromeBar.fadeHeight, spacing: CGFloat = ChromeBar.fadeHeight, visible: Bool = true, long: EdgeFade? = nil) -> some View {
        background(alignment: edge == .top ? .top : .bottom) {
            ChromeMask(edge: edge, ramp: fade, long: long)
                .opacity(visible ? 1 : 0)
                // Reach `spacing` past the chrome toward the content, and the screen edge behind it.
                .padding(edge == .top ? .bottom : .top, -spacing)
                .ignoresSafeArea(.container, edges: edge == .top ? .top : .bottom)
        }
    }
}

private struct DuetBarModifier<Bar: View>: ViewModifier {
    var edge: VerticalEdge
    var fade: CGFloat
    var spacing: CGFloat
    var masked: Bool
    var long: EdgeFade?
    var bar: Bar

    func body(content: Content) -> some View {
        let chrome = bar
            .frame(maxWidth: .infinity)
            .chromeMask(edge, fade: fade, spacing: spacing, visible: masked, long: long)
        if #available(iOS 26, *) {
            content
                // Our mask replaces the system's soft edge (one effect, not two).
                .scrollEdgeEffectHidden(true, for: edge == .top ? .top : .bottom)
                .safeAreaBar(edge: edge, spacing: spacing) { chrome }
        } else {
            content.safeAreaInset(edge: edge, spacing: spacing) { chrome }
        }
    }
}

/// The progressive mask: two blur layers (the stronger one only near the edge) and the app
/// background's tint, each fading out over the last `ramp` points toward the content. On iOS 18 the
/// tint is opaque under the chrome (L161's opaque band, the blur shows in the ramp); on iOS 26 it is
/// a soft frosted band that firms up at the screen edge so the status bar stays readable.
struct ChromeMask: View {
    var edge: VerticalEdge
    var ramp: CGFloat = ChromeBar.fadeHeight
    /// The shell's long soft fade (nil: solid, then `ramp`).
    var long: EdgeFade? = nil

    var body: some View {
        let glass = LiquidGlass.isAvailable
        ZStack {
            Rectangle().fill(.ultraThinMaterial)
                .mask { MaskRamp(edge: edge, ramp: ramp, long: long) }
            Rectangle().fill(.thinMaterial)
                .mask { MaskRamp(edge: edge, ramp: ramp, inset: ramp * 0.45, long: long, layer: 0.45) }
            Rectangle().fill(Palette.background)
                .mask { MaskRamp(edge: edge, ramp: ramp, peak: glass ? 0.62 : 1, long: long) }
            if glass && edge == .top {
                // The status bar band: a little firmer right at the screen edge.
                Rectangle().fill(Palette.background)
                    .mask { MaskRamp(edge: edge, ramp: 0, peak: 0.3, edgeBand: 64) }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// One layer's alpha: `peak` from the edge, easing to 0 over the last `ramp` points (or, with
/// `edgeBand`, over the first `edgeBand` points from the edge). `inset`: the ramp ends this much
/// before the far side, so a stronger layer fades out earlier than a softer one.
private struct MaskRamp: View {
    var edge: VerticalEdge
    var ramp: CGFloat
    var inset: CGFloat = 0
    var peak: Double = 1
    var edgeBand: CGFloat = 0
    /// The long soft fade (EdgeFade); `layer` ends a stronger layer's ramp earlier.
    var long: EdgeFade? = nil
    var layer: Double = 0

    var body: some View {
        Canvas { context, size in
            let height = size.height
            guard height > 0, size.width > 0 else { return }
            // Distances measured from the screen edge toward the content.
            let far: CGFloat
            let near: CGFloat
            if edgeBand > 0 {
                near = 0
                far = min(edgeBand, height)
            } else if let long {
                let span = long.span(height: Double(height), layer: layer)
                near = CGFloat(span.near)
                far = CGFloat(span.far)
            } else {
                far = max(height - inset, 0)
                near = max(far - ramp, 0)
            }
            func y(_ distance: CGFloat) -> CGFloat { edge == .top ? distance : height - distance }
            let solid = CGRect(x: 0, y: min(y(0), y(near)), width: size.width, height: abs(y(near) - y(0)))
            if solid.height > 0 && edgeBand == 0 {
                context.fill(Path(solid), with: .color(.black.opacity(peak)))
            }
            guard far > near else { return }
            // An eased ramp (no visible band where it starts or ends).
            let stops: [Gradient.Stop] = [0, 0.25, 0.5, 0.75, 1].map { t in
                let eased = 1 - (t * t * (3 - 2 * t))
                return .init(color: .black.opacity(peak * eased), location: t)
            }
            let rampRect = CGRect(x: 0, y: min(y(near), y(far)), width: size.width, height: abs(y(far) - y(near)))
            context.fill(
                Path(rampRect),
                with: .linearGradient(
                    Gradient(stops: stops),
                    startPoint: CGPoint(x: 0, y: y(near)), endPoint: CGPoint(x: 0, y: y(far))
                )
            )
        }
    }
}

/// Content that reaches under the chrome (a web page or a file) and sets its own insets: how far
/// the chrome covers it at the top and bottom, from its frame inside the chrome (`page`) and the
/// frame it really has (`full`, it ignores the container safe area), plus a little air.
enum ChromeInsets {
    static func between(page: CGRect, full: CGRect, air: CGFloat = 8) -> EdgeInsets {
        guard page != .zero, full != .zero else { return EdgeInsets() }
        let top = max(page.minY - full.minY, 0)
        let bottom = max(full.maxY - page.maxY, 0)
        return EdgeInsets(top: top + air, leading: 0, bottom: bottom + air, trailing: 0)
    }
}
