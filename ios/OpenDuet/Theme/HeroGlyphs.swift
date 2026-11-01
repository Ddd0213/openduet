// The hero glyphs (M8, prompt L95, L97, orig-tasks.jpeg): the header's ≡ with three
// left-aligned lines of unequal length, and the tab bar's Chat (a speech bubble with the
// mascot's squiggle through it), Tasks (two ticks and their lines) and Make (a square with a +
// and a pencil coming in at its corner). M9: drawn by the hand-drawn set (DuetArt .menu, .chat,
// .tasks, .make) so the chrome and the content icons are one family; plain ink in the
// environment's foreground style, never the accent (the tab bar tints them by selection).
import SwiftUI

enum HeroGlyph: Sendable {
    case menu, chat, tasks, make

    var art: DuetArt {
        switch self {
        case .menu: .menu
        case .chat: .chat
        case .tasks: .tasks
        case .make: .make
        }
    }
}

struct HeroGlyphView: View {
    var glyph: HeroGlyph
    var size: CGFloat
    /// Stroke width; defaults to the set's weight for the size.
    var lineWidth: CGFloat? = nil

    var body: some View {
        DuetArtView(art: glyph.art, size: size, lineWidth: lineWidth ?? Self.lineWidth(for: size))
    }

    /// The set's stroke at this size (ArtStyle).
    static func lineWidth(for size: CGFloat) -> CGFloat {
        ArtStyle.lineWidth(for: size)
    }
}

/// The glyph's ink strokes as a Shape (stroke it yourself).
struct HeroGlyphShape: Shape {
    var glyph: HeroGlyph

    func path(in rect: CGRect) -> Path {
        DuetArtShape(art: glyph.art).path(in: rect)
    }
}

#Preview {
    HStack(spacing: 18) {
        ForEach([HeroGlyph.menu, .chat, .tasks, .make], id: \.self) { glyph in
            HeroGlyphView(glyph: glyph, size: 24)
        }
    }
    .padding()
}
