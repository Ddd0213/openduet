// M9: the app's hand-drawn line icon set. One view draws every content icon of the app: the
// CardIcon keys the assistant picks for the cards it writes, and the app's own concepts (DuetGlyph).
// Monoline ink (round caps and joins, one weight per size) with one soft clay accent printed a
// little off-register behind it at tile sizes, like the mascot's squiggle over its disc. The
// drawings live in Components/Icons (DuetArt); the maps in Theme/DuetGlyph.swift.
//
// API (stable; callers only use this):
//   DuetIcon(.doc, size: 22)                 a CardIcon key
//   DuetIcon(glyph: .memory, size: 22)       an app concept
//   DuetIconTile(icon: .lightbulb)           / DuetIconTile(glyph: .computer, accent: ...)
// Tints: the default (Palette.tileGlyph) or Palette.primaryText draws the set's ink and, at
// 24 pt and up, its accent; any other tint (errors, disabled, selected, status colours) draws
// the line in that colour with no accent.
import SwiftUI

/// What a DuetIcon draws: a card key or an app concept.
enum DuetIconSource: Hashable, Sendable {
    case card(CardIcon)
    case glyph(DuetGlyph)
}

struct DuetIcon: View {
    var source: DuetIconSource
    var size: CGFloat = 22
    var tint: Color = Palette.tileGlyph

    init(_ icon: CardIcon, size: CGFloat = 22, tint: Color = Palette.tileGlyph) {
        self.source = .card(icon)
        self.size = size
        self.tint = tint
    }

    init(glyph: DuetGlyph, size: CGFloat = 22, tint: Color = Palette.tileGlyph) {
        self.source = .glyph(glyph)
        self.size = size
        self.tint = tint
    }

    var body: some View {
        // Inline marks (< 24 pt) are ink only; bigger standalone icons get the accent too.
        DuetArtGlyph(art: source.art, symbol: source.placeholderSymbol, size: size, tint: tint, accented: size >= 24)
    }
}

/// A rounded tile holding a DuetIcon (suggestion cards, resources, form and info cards, rows).
/// `accent`: the card's tint colour for the icon's accent (nil = the set's clay).
struct DuetIconTile: View {
    var source: DuetIconSource
    var size: CGFloat = Metrics.iconTile
    var tint: Color = Palette.tileGlyph
    var accent: Color? = nil

    init(icon: CardIcon, size: CGFloat = Metrics.iconTile, tint: Color = Palette.tileGlyph, accent: Color? = nil) {
        self.source = .card(icon)
        self.size = size
        self.tint = tint
        self.accent = accent
    }

    init(glyph: DuetGlyph, size: CGFloat = Metrics.iconTile, tint: Color = Palette.tileGlyph, accent: Color? = nil) {
        self.source = .glyph(glyph)
        self.size = size
        self.tint = tint
        self.accent = accent
    }

    var body: some View {
        Color.clear
            .frame(width: size, height: size)
            .tileBackground(corner: size * ArtStyle.tileCornerRatio)
            .overlay {
                DuetArtGlyph(art: source.art, symbol: source.placeholderSymbol, size: size * ArtStyle.tileArtRatio, tint: tint, accentColor: accent, accented: size >= 24)
            }
            .accessibilityHidden(true)
    }
}

/// The one place a drawing meets the app's colours (DuetIcon, the tiles, rows, empty states):
/// the default tint draws the set's ink plus its accent; any other tint draws plain line art.
/// No drawing (`art` nil) falls back to the SF Symbol at the set's weight.
struct DuetArtGlyph: View {
    var art: DuetArt?
    var symbol: String
    var size: CGFloat
    var tint: Color = Palette.tileGlyph
    /// A card's tint for the accent (nil = clay).
    var accentColor: Color? = nil
    var accented = true
    var lineWidth: CGFloat? = nil

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if let art {
            let isDefault = tint == Palette.tileGlyph || tint == Palette.primaryText
            DuetArtView(
                art: art,
                size: size,
                ink: isDefault ? Palette.tileGlyph : tint,
                accent: isDefault && accented && size >= ArtStyle.accentMinSize ? accent : nil,
                lineWidth: lineWidth
            )
        } else {
            Image(systemName: symbol)
                .font(.system(size: size * 0.82, weight: DuetGlyph.weight(for: size * 0.82)))
                .foregroundStyle(tint)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }

    private var accent: Color {
        guard let accentColor else { return Palette.artAccent }
        return accentColor.opacity(colorScheme == .dark ? ArtStyle.accentOpacityDark : ArtStyle.accentOpacityLight)
    }
}

extension DuetIconSource {
    /// The drawing (nil = none; the SF Symbol draws it).
    var art: DuetArt? {
        switch self {
        case .card(let icon): icon.art
        case .glyph(let glyph): glyph.art
        }
    }

    /// The closest SF Symbol (fallback, menus).
    var placeholderSymbol: String {
        switch self {
        case .card(let icon): icon.placeholderSymbol
        case .glyph(let glyph): glyph.symbol
        }
    }
}

extension CardIcon {
    /// The closest SF Symbol, for menus and Labels (the visible icon is `art`).
    var placeholderSymbol: String {
        switch self {
        case .lightbulb: "lightbulb"
        case .doc: "doc.text"
        case .dashboard: "chart.bar.xaxis"
        case .slides: "rectangle.on.rectangle"
        case .webpage: "safari"
        case .design: "paintbrush"
        case .checklist: "checklist"
        case .task: "checkmark.circle"
        case .calendar: "calendar"
        case .clock: "clock"
        case .mail: "envelope"
        case .chat: "bubble.left"
        case .person: "person"
        case .people: "person.2"
        case .folder: "folder"
        case .file: "doc"
        case .link: "link"
        case .search: "magnifyingglass"
        case .globe: "globe"
        case .chart: "chart.line.uptrend.xyaxis"
        case .money: "dollarsign.circle"
        case .cart: "cart"
        case .gift: "gift"
        case .pin: "mappin"
        case .house: "house"
        case .plane: "airplane"
        case .book: "book"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .sparkle: "sparkle"
        case .heart: "heart"
        case .star: "star"
        case .bell: "bell"
        case .warning: "exclamationmark.triangle"
        case .check: "checkmark"
        case .question: "questionmark.circle"
        case .pencil: "pencil"
        case .music: "music.note"
        case .camera: "camera"
        }
    }
}
