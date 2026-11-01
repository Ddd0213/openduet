// Liquid Glass on iOS 26, today's opaque floating chrome on iOS 18 (M8). Every piece of floating
// chrome (header circles, status pill, composer, tab bar, ↓, FABs, viewer pills, back / close /
// ⋯ circles) asks for its surface here, so the two looks are decided in one place:
// - iOS 26: real glass (`glassEffect`), interactive on controls, a faint neutral tint so our
//   fixed palette text stays readable over any content (light and dark), no extra shadow or
//   hairline (glass draws its own rim and depth);
// - iOS 18: exactly the M2-M7 look, a #FFFFFF / #333333 fill, optional hairline, soft shadow.
import SwiftUI
import UIKit

enum LiquidGlass {
    /// True on iOS 26 and later, where the chrome is real Liquid Glass.
    static var isAvailable: Bool {
        if #available(iOS 26, *) { return true }
        return false
    }
}

extension Palette {
    /// The faint tint over neutral glass: keeps the chrome close to the white / #333333 surface it
    /// replaces, so Palette.primaryText reads on it whatever scrolls behind. M21: a little lighter
    /// (light 0.38 -> 0.30, dark 0.42 -> 0.34), so what scrolls under it shows through more.
    static let glassTint = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(hex: 0x2A2A2A, alpha: 0.34)
            : UIColor(hex: 0xFFFFFF, alpha: 0.30)
    })
    /// M21 (OpenDuet's `--duet-glass-edge`): the 0.5 pt light along a surface's top edge,
    /// white at 80 % in light, 8 % in dark. White only, no new colour.
    static let glassEdge = Color(UIColor { traits in
        UIColor(white: 1, alpha: traits.userInterfaceStyle == .dark ? 0.08 : 0.80)
    })
    /// The selected tab's pill on the glass tab bar (a touch stronger than on the opaque bar).
    static let glassSelection = Color.dynamic(light: 0x141413, dark: 0xF2F2F2).opacity(0.08)
}

extension View {
    /// A floating chrome surface in `shape`: glass on iOS 26, the opaque floating fill (with an
    /// optional hairline and the soft shadow) on iOS 18. M21 `edge`: the 0.5 pt top-edge light on
    /// both, and on iOS 18 the reference's float shadow (fainter in dark) instead of the old one.
    func chromeSurface<S: InsettableShape>(_ shape: S, interactive: Bool = false, hairline: Bool = true, shadow: Bool = true, edge: Bool = false) -> some View {
        modifier(ChromeSurface(shape: shape, interactive: interactive, hairline: hairline, shadow: shadow, edge: edge))
    }

    /// M21: the 0.5 pt light along the top edge of `shape` (`--duet-glass-edge`), drawn over the
    /// view it's applied to (a surface's fill). Doesn't take touches or VoiceOver focus.
    func glassEdge<S: Shape>(_ shape: S) -> some View {
        overlay {
            TopEdgeHighlight(base: shape)
                .fill(Palette.glassEdge)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    /// M21: the soft shadow under a surface's shape (`--duet-shadow-card` / `--duet-shadow-float`),
    /// much fainter in dark mode. Put it on the shape (a background), not on content with text,
    /// so a scrolling thread doesn't redraw glyph shadows.
    func surfaceShadow(_ style: SurfaceShadow.Style) -> some View {
        modifier(SurfaceShadow(style: style))
    }

    /// The orange + FAB's surface: orange-tinted interactive glass on iOS 26, the #D65A45 circle
    /// with its warm shadow on iOS 18.
    func fabSurface() -> some View {
        modifier(FabSurface())
    }

    /// Text and glyphs that sit straight on the page under the chrome (a viewer title, a toolbar
    /// status) get a glass backing on iOS 26 only; iOS 18 keeps them on the opaque fade.
    func glassBacking<S: Shape>(_ shape: S, interactive: Bool = false) -> some View {
        modifier(GlassBacking(shape: shape, interactive: interactive))
    }
}

private struct ChromeSurface<S: InsettableShape>: ViewModifier {
    var shape: S
    var interactive: Bool
    var hairline: Bool
    var shadow: Bool
    var edge: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            // Glass draws its own depth; no SwiftUI shadow over it (it would shade the glyph).
            content
                .glassEffect(.regular.tint(Palette.glassTint).interactive(interactive), in: shape)
                .modifier(EdgeIf(on: edge, shape: shape))
        } else {
            content.background {
                Group {
                    if hairline {
                        shape.fill(Palette.floatingSurface)
                            .strokeBorder(Palette.hairline, lineWidth: Metrics.hairline)
                    } else {
                        shape.fill(Palette.floatingSurface)
                    }
                }
                .modifier(EdgeIf(on: edge, shape: shape))
                .modifier(ChromeShadow(on: shadow, float: edge))
            }
        }
    }
}

/// The top-edge light, only when asked for.
private struct EdgeIf<S: Shape>: ViewModifier {
    var on: Bool
    var shape: S

    func body(content: Content) -> some View {
        if on { content.glassEdge(shape) } else { content }
    }
}

/// iOS 18 chrome's shadow: none, the M21 float shadow (with the edge), or the earlier soft one.
private struct ChromeShadow: ViewModifier {
    var on: Bool
    var float: Bool

    func body(content: Content) -> some View {
        if !on {
            content
        } else if float {
            content.surfaceShadow(.float)
        } else {
            content.floatingShadow()
        }
    }
}

/// M21: the part of `base` that a copy moved 0.5 pt down doesn't cover: a hairline along the top
/// edge that follows the corners and thins out down the sides, like CSS `inset 0 0.5px 0`.
struct TopEdgeHighlight<Base: Shape>: Shape {
    var base: Base
    var width: CGFloat = Metrics.hairline

    func path(in rect: CGRect) -> Path {
        let outline = base.path(in: rect)
        return outline.subtracting(outline.applying(CGAffineTransform(translationX: 0, y: width)))
    }
}

/// M21: OpenDuet's card and float shadows (styles.css `--duet-shadow-card`,
/// `--duet-shadow-float`) in SwiftUI terms. Dark mode: no card shadow (the reference has only its
/// ring there) and a faint float shadow.
struct SurfaceShadow: ViewModifier {
    enum Style: Sendable { case card, float }

    var style: Style
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        let dark = colorScheme == .dark
        switch style {
        case .card:
            // 0 6px 18px -12px rgb(1 5 7 / 18%): mostly tucked under the card, a soft lip below.
            content.shadow(color: Self.ink.opacity(dark ? 0 : 0.07), radius: 9, y: 6)
        case .float:
            // 0 1px 1.5px / 6% and 0 4px 12px -4px / 12% (dark: 0 4px 12px -4px black 50%).
            content
                .shadow(color: Self.ink.opacity(dark ? 0 : 0.06), radius: 0.75, y: 1)
                .shadow(color: (dark ? Color.black : Self.ink).opacity(dark ? 0.35 : 0.10), radius: 6, y: 4)
        }
    }

    /// rgb(1 5 7), the reference's shadow ink.
    private static let ink = Color(red: 1 / 255, green: 5 / 255, blue: 7 / 255)
}

private struct FabSurface: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.glassEffect(.regular.tint(Palette.fab.opacity(0.92)).interactive(), in: Circle())
        } else {
            content
                .background(Circle().fill(Palette.fab))
                .shadow(color: Palette.fab.opacity(0.35), radius: 10, y: 4)
        }
    }
}

private struct GlassBacking<S: Shape>: ViewModifier {
    var shape: S
    var interactive: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.glassEffect(.regular.tint(Palette.glassTint).interactive(interactive), in: shape)
        } else {
            content
        }
    }
}

/// Glass shapes that sit together (the header row, the ✎ | ⋯ pill, a toolbar) share one
/// container on iOS 26 so they sample and blend as one layer; on iOS 18 it is a plain group.
struct ChromeGlassGroup<Content: View>: View {
    var spacing: CGFloat? = nil
    @ViewBuilder var content: Content

    var body: some View {
        if #available(iOS 26, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}
