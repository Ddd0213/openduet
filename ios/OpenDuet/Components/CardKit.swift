// Shared pieces of M3's cards and task screens (prompt L186: one visual language, shared
// components): the white hairline card, capsule buttons with an inner spinner, the spinning
// arc, the Working shimmer, the edit glow, icon tiles and highlighted search matches.
import SwiftUI

// MARK: - Card surface

extension View {
    /// A white rounded card with a hairline border (#1C1C1C in dark). M21 (OpenDuet's slight
    /// sheen): the 0.5 pt light along its top edge and a soft card shadow (none in dark), both on
    /// the card's shape behind the content, so the text itself casts nothing.
    func cardSurface(corner: CGFloat = Metrics.cardCorner) -> some View {
        let shape = RoundedRectangle(cornerRadius: corner, style: .continuous)
        return background(
            shape
                .fill(Palette.cardSurface)
                .strokeBorder(Palette.cardBorder, lineWidth: Metrics.hairline)
                .glassEdge(shape)
                .surfaceShadow(.card)
        )
    }
}

// MARK: - Buttons

/// A card's capsule button: filled (black in light, white in dark) or outline. While `busy`
/// the title keeps its width and a spinner shows inside (L182).
struct CapsuleButton: View {
    enum Style { case filled, outline }

    var title: Text
    var style: Style = .filled
    var busy = false
    var fullWidth = true
    var action: () -> Void

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 16
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            title
                .font(.system(size: fontSize, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .opacity(busy ? 0 : 1)
                .overlay { if busy { ProgressView().tint(foreground).controlSize(.small) } }
                .foregroundStyle(foreground)
                .padding(.horizontal, 18)
                .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: 44)
                .background { shape }
                .contentShape(Capsule())
                .opacity(isEnabled || busy ? 1 : 0.45)
        }
        .buttonStyle(PressableButtonStyle(scale: 0.96))
        .accessibilityValue(busy ? Text("In progress") : Text(verbatim: ""))
    }

    private var foreground: Color {
        style == .filled ? Palette.filledButtonText : Palette.primaryText
    }

    @ViewBuilder private var shape: some View {
        switch style {
        case .filled: Capsule().fill(Palette.filledButton)
        case .outline: Capsule().strokeBorder(Palette.outline, lineWidth: 1)
        }
    }
}

/// A small outlined chip with a ↪ glyph that sends text ("↪ Shorten", "Ask again", plate pills).
struct SendChip: View {
    var title: Text
    var showsArrow = true
    var action: () -> Void

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 15
    @State private var sends = 0

    var body: some View {
        Button {
            sends += 1
            action()
        } label: {
            HStack(spacing: 6) {
                if showsArrow {
                    Text(verbatim: "↪").font(.system(size: fontSize, weight: .semibold)).accessibilityHidden(true)
                }
                title.font(.system(size: fontSize, weight: .medium)).lineLimit(1)
            }
            .foregroundStyle(Palette.primaryText)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Capsule().strokeBorder(Palette.primaryText.opacity(0.28), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.95))
        // It sends its text: light, like the composer's send (L186).
        .sensoryFeedback(.impact(weight: .light), trigger: sends)
    }
}

// MARK: - Spinners and status

/// A blue spinning arc: the current step, a working task's chip and row glyph. It keeps
/// turning under Reduce Motion (a spinner that stops reads as stuck), only slower. M10: drawn by
/// hand (HandSpinner), same sizes.
struct SpinnerArc: View {
    var size: CGFloat = 16
    var color: Color = Palette.working
    var lineWidth: CGFloat = 2

    var body: some View {
        HandSpinner(size: size, color: color, lineWidth: lineWidth)
    }
}

/// A task status as a glyph: the spinning arc while working, otherwise one outline family in
/// the status colour (M8: no more filled and outline circles side by side).
struct TaskStatusGlyph: View {
    var status: TaskStatus
    var size: CGFloat = 16

    var body: some View {
        if status == .working {
            SpinnerArc(size: size - 2, lineWidth: max(1.6, size / 9))
        } else {
            // M9: the hand-drawn status marks, in the status colour.
            DuetArtGlyph(art: DuetArt(symbol: status.glyph), symbol: status.glyph, size: size + 2, tint: status.color)
                .accessibilityHidden(true)
        }
    }
}

extension TaskStatus {
    /// The coloured status word on rows and the detail capsule (L117).
    var word: LocalizedStringResource {
        switch self {
        case .readyForReview: "Ready for review"
        case .needsInput: "Needs input"
        case .working: "Working"
        case .scheduled: "Scheduled"
        case .resolved: "Resolved"
        }
    }

    var color: Color {
        switch self {
        case .readyForReview: Palette.readyForReview
        case .needsInput: Palette.needsInput
        case .working: Palette.working
        case .scheduled, .resolved: Palette.secondaryText
        }
    }

    /// The status as an outline symbol (the spinner draws `working` where it can move; inline
    /// pills, which can't, show the dashed circle).
    var glyph: String {
        switch self {
        case .readyForReview: "checkmark.circle"
        case .needsInput: "exclamationmark.circle"
        case .working: "circle.dashed"
        case .scheduled: DuetGlyph.clock.symbol
        case .resolved: "checkmark.circle"
        }
    }
}

// MARK: - Shimmer

extension View {
    /// The moving shimmer on "Working" (L84, L117); static under Reduce Motion.
    func shimmer(_ active: Bool = true) -> some View {
        modifier(Shimmer(active: active))
    }
}

private struct Shimmer: ViewModifier {
    var active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        if active && !reduceMotion {
            content.overlay {
                TimelineView(.animation) { context in
                    // M10: a slow, eased sweep (~1.9 s across) and a short rest before the next.
                    let period = 2.6
                    let sweep = 0.72
                    let t = min(context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period / sweep, 1)
                    let phase = t * t * (3 - 2 * t)
                    GeometryReader { geo in
                        let band = max(geo.size.width * 0.6, 24)
                        LinearGradient(
                            colors: [.clear, highlight, .clear],
                            startPoint: .leading, endPoint: .trailing
                        )
                        .frame(width: band)
                        .offset(x: -band + (geo.size.width + band * 2) * phase)
                    }
                }
                .mask(content)
                .allowsHitTesting(false)
            }
        } else {
            content
        }
    }

    private var highlight: Color {
        colorScheme == .dark ? .white.opacity(0.55) : .white.opacity(0.75)
    }
}

// MARK: - Edit glow (L163)

extension View {
    /// Text changed by an edit by chat glows accent orange for ~3 s, then fades back to
    /// `color` (set the text's colour here, not on the text itself, so the glow can win).
    func editGlow(_ active: Bool, color: Color = Palette.primaryText) -> some View {
        modifier(EditGlow(active: active, color: color))
    }
}

private struct EditGlow: ViewModifier {
    var active: Bool
    var color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .foregroundStyle(active ? Palette.accent : color)
            .shadow(color: Palette.accent.opacity(active ? 0.55 : 0), radius: active ? 6 : 0)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Palette.accent.opacity(active ? 0.10 : 0))
                    .padding(-3)
            )
            .animation(reduceMotion ? .easeInOut(duration: 0.3) : .easeInOut(duration: 0.6), value: active)
    }
}

// MARK: - Tiles

/// A square rounded tile with an app's mark (by display name) or a symbol: the one tile of the
/// app (Theme/Tiles.swift). M9: the symbol draws as the hand-drawn set (DuetArt(symbol:)); an
/// app without a drawn mark gets the letter monogram only when its name starts with a letter
/// (a "[CL]" resource shows its type's drawing, never "["); the assistant's computer the computer.
struct IconTile: View {
    var app: String?
    var systemImage: String = DuetGlyph.suggestion.symbol
    var size: CGFloat = Metrics.iconTile
    var tint: Color = Palette.tileGlyph

    var body: some View {
        Color.clear
            .frame(width: size, height: size)
            .tileBackground(corner: size * ArtStyle.tileCornerRatio)
            .overlay { mark }
            .accessibilityHidden(true)
    }

    @ViewBuilder private var mark: some View {
        let slug = CardFormat.toolkitSlug(app)
        if let slug, AppLogo.computerSlugs.contains(slug) {
            DuetArtGlyph(art: .computer, symbol: DuetGlyph.computer.symbol, size: size * ArtStyle.tileArtRatio, tint: tint, accented: size >= 24)
        } else if let slug, AppLogo.drawnSlugs.contains(slug) || AppLogo.monogramLetter(app ?? "") != nil {
            AppLogo(toolkit: slug, name: app ?? "", size: size * ArtStyle.tileArtRatio, framed: false)
        } else {
            let symbol = Self.refined(systemImage)
            DuetArtGlyph(art: DuetArt(symbol: symbol), symbol: symbol, size: size * ArtStyle.tileArtRatio, tint: tint, accented: size >= 24)
        }
    }

    /// Symbols that read cheap on a tile, swapped wherever a caller still passes them.
    static func refined(_ name: String) -> String {
        switch name {
        case "sparkles": DuetGlyph.suggestion.symbol
        case "bolt", "bolt.fill": DuetGlyph.action.symbol
        case "desktopcomputer": DuetGlyph.computer.symbol
        case "doc.fill": DuetGlyph.doc.symbol
        default: name
        }
    }
}

// MARK: - Search highlight

enum HighlightedText {
    /// A title with each search match on a soft accent background (L185).
    static func make(_ title: String, ranges: [Range<String.Index>]) -> AttributedString {
        var result = AttributedString()
        var cursor = title.startIndex
        for range in ranges where range.lowerBound >= cursor {
            result += AttributedString(String(title[cursor..<range.lowerBound]))
            var match = AttributedString(String(title[range]))
            match.backgroundColor = Palette.searchMatch
            match.foregroundColor = Palette.accent
            result += match
            cursor = range.upperBound
        }
        result += AttributedString(String(title[cursor...]))
        return result
    }
}
