// The one icon tile of the app (M9): app marks, resource and file glyphs, rows, cards. A flat
// warm paper surface (light) / soft graphite (dark) with a hairline rim and continuous corners,
// no glossy gradient, so the hand-drawn line art (Components/Icons) sits on it like ink on
// paper. The values live in ArtStyle (shared with the macOS contact sheet).
import SwiftUI
import UIKit

extension Palette {
    /// The tile's paper.
    static let tileFill = Color.dynamic(light: ArtStyle.tileLight, dark: ArtStyle.tileDark)
    /// Kept for callers of the M8 gradient: both ends are the flat paper now.
    static let tileTop = tileFill
    static let tileBottom = tileFill
    /// The tile's hairline rim.
    static let tileRim = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(hex: ArtStyle.rimDark, alpha: ArtStyle.rimOpacityDark)
            : UIColor(hex: ArtStyle.rimLight, alpha: ArtStyle.rimOpacityLight)
    })
    /// The set's ink: warm near-black / warm off-white. The default tint of every icon.
    static let tileGlyph = Color.dynamic(light: ArtStyle.inkLight, dark: ArtStyle.inkDark)
    /// The accent print behind the ink (already at its opacity): clay, lighter on graphite.
    static let artAccent = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(hex: ArtStyle.clayDark, alpha: ArtStyle.accentOpacityDark)
            : UIColor(hex: ArtStyle.clay, alpha: ArtStyle.accentOpacityLight)
    })
}

/// The tile surface in any shape (a rounded square for icons, a capsule or circle elsewhere).
struct TileSurface<S: InsettableShape>: View {
    var shape: S

    var body: some View {
        shape
            .fill(Palette.tileFill)
            .strokeBorder(Palette.tileRim, lineWidth: Metrics.hairline)
    }
}

extension View {
    /// A tile background with `corner` continuous corners (icon tiles pass `size * 0.26`).
    func tileBackground(corner: CGFloat) -> some View {
        background(TileSurface(shape: RoundedRectangle(cornerRadius: corner, style: .continuous)))
    }
}
