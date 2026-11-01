// The views the app (and the contact sheet) draw the set with: one drawing with its ink and
// optional accent, and the letter monogram of an app without a mark. Pure SwiftUI; colours
// come in from the caller (DuetIcon maps the app's tints).
import SwiftUI

/// One drawing of the set at `size` points.
struct DuetArtView: View {
    var art: DuetArt
    var size: CGFloat
    /// The ink; nil draws in the environment's foreground style (tab bar, header circle).
    var ink: Color? = nil
    /// The accent print behind the ink (already at its opacity); nil = none.
    var accent: Color? = nil
    var lineWidth: CGFloat? = nil

    var body: some View {
        let style = StrokeStyle(lineWidth: lineWidth ?? ArtStyle.lineWidth(for: size), lineCap: .round, lineJoin: .round)
        ZStack {
            if let accent {
                DuetArtShape(art: art, layer: .accent).fill(accent)
            }
            if let ink {
                DuetArtShape(art: art).stroke(ink, style: style)
            } else {
                DuetArtShape(art: art).stroke(style: style)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// An app without a drawn mark: its initial set in the serif, a soft accent print offset
/// behind it and a small hand-drawn stroke under it, like a letterpress monogram.
struct DuetMonogram: View {
    var letter: String
    var size: CGFloat
    var ink: Color
    var accent: Color?

    var body: some View {
        ZStack {
            if let accent {
                MonogramPrint(part: .disc).fill(accent)
            }
            // A display name's letter, not UI copy.
            Text(verbatim: letter)
                .font(.system(size: size * 0.66, weight: .medium, design: .serif))
                .foregroundStyle(ink)
                .minimumScaleFactor(0.5)
                .offset(y: -size * 0.04)
            MonogramPrint(part: .underline)
                .stroke(ink.opacity(0.9), style: StrokeStyle(lineWidth: ArtStyle.lineWidth(for: size) * 0.85, lineCap: .round))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct MonogramPrint: Shape {
    enum Part { case disc, underline }
    var part: Part

    func path(in rect: CGRect) -> Path {
        var pen = ArtPen(rect: rect, shift: part == .disc ? ArtStyle.accentShift : .zero)
        switch part {
        case .disc: pen.blob((13.4, 11.4), 6.6, 6.8, seed: 1)
        case .underline: pen.wave((7.6, 21.2), (16.4, 20.8), amp: 0.45, periods: 1)
        }
        return pen.path
    }
}
