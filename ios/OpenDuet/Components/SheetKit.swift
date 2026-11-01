// Shared pieces of the M4 sheets and pushed pages (prompt L123-L129, L181): the top row with a
// back / close circle, a centred title and trailing circles; white rounded cards with hairline
// dividers between rows; settings-style rows; small grey section titles; and the sheet chrome
// (grabber, app background, rounded corners). Built once so every sheet looks the same.
import SwiftUI

/// A 44 pt floating circle with one symbol (back, close, refresh, ⓘ). M9: content symbols
/// (contents, refresh, info, share...) draw as the hand-drawn set; the chrome primitives (‹, ✕,
/// ⋯, +) stay SF Symbols, like every other header circle and menu.
struct CircleIconButton: View {
    var systemImage: String
    var label: Text
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            glyph
                .foregroundStyle(Palette.primaryText)
                .floatingCircle(Metrics.headerCircle)
        }
        .buttonStyle(PressableButtonStyle(scale: 0.92))
        .accessibilityLabel(label)
    }

    @ViewBuilder private var glyph: some View {
        if !DuetArt.chromeSymbols.contains(systemImage), let art = DuetArt(symbol: systemImage) {
            DuetArtView(art: art, size: 21)
        } else {
            Image(systemName: systemImage).glyphFont(17)
        }
    }
}

/// The top row of a sheet or pushed page: back (‹) or close (✕) on the left, the title centred,
/// up to two trailing circles on the right. The title shrinks a little before it wraps.
/// The left circle of a SheetHeader: ‹ on a pushed page, ✕ on a sheet's root.
enum SheetHeaderLeading: Hashable, Sendable { case back, close, none }

struct SheetHeader<Trailing: View>: View {
    typealias Leading = SheetHeaderLeading

    var title: Text?
    var leading: Leading = .back
    var onLeading: () -> Void = {}
    @ViewBuilder var trailing: () -> Trailing

    @ScaledMetric(relativeTo: .headline) private var titleSize: CGFloat = 17

    var body: some View {
        ZStack {
            if let title {
                title
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 2 * Metrics.headerCircle + 24)
                    .accessibilityAddTraits(.isHeader)
            }
            HStack(spacing: 8) {
                switch leading {
                case .back: CircleIconButton(systemImage: "chevron.left", label: Text("Back"), action: onLeading)
                case .close: CircleIconButton(systemImage: "xmark", label: Text("Close"), action: onLeading)
                case .none: EmptyView()
                }
                Spacer(minLength: 0)
                trailing()
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 8)
    }
}

extension SheetHeader where Trailing == EmptyView {
    init(title: Text?, leading: Leading = .back, onLeading: @escaping () -> Void = {}) {
        self.init(title: title, leading: leading, onLeading: onLeading) { EmptyView() }
    }
}

/// A small grey title above a card ("What OpenDuet has access to", "Weekly limits").
struct SheetSectionTitle: View {
    var text: Text
    @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 14

    var body: some View {
        text
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(Palette.secondaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 6)
            .padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A white rounded card with a hairline border whose children are separated by hairline
/// dividers (inset past a leading icon when `dividerInset` is set).
struct CardSection<Content: View>: View {
    var dividerInset: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            Group(subviews: content) { subviews in
                ForEach(Array(subviews.enumerated()), id: \.element.id) { index, subview in
                    if index > 0 {
                        Divider().overlay(Palette.cardBorder).padding(.leading, dividerInset)
                    }
                    subview
                }
            }
        }
        .frame(maxWidth: .infinity)
        .cardSurface()
    }
}

/// A settings-style row: optional leading tile, title and grey subtitle, then a trailing view.
/// With an action the whole row is the button and highlights while pressed.
struct SheetRow<Leading: View, Trailing: View>: View {
    var title: Text
    var subtitle: Text?
    var action: (() -> Void)?
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var trailing: () -> Trailing

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var subtitleSize: CGFloat = 13.5

    var body: some View {
        if let action {
            Button(action: action) { row }
                .buttonStyle(RowPressStyle())
        } else {
            row
        }
    }

    private var row: some View {
        HStack(spacing: 12) {
            leading()
            VStack(alignment: .leading, spacing: 2) {
                title
                    .font(.system(size: titleSize, weight: .medium))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                if let subtitle {
                    subtitle
                        .font(.system(size: subtitleSize))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minHeight: Metrics.sheetRowMinHeight)
        .contentShape(Rectangle())
    }
}

extension SheetRow where Leading == EmptyView {
    init(title: Text, subtitle: Text? = nil, action: (() -> Void)? = nil, @ViewBuilder trailing: @escaping () -> Trailing) {
        self.init(title: title, subtitle: subtitle, action: action, leading: { EmptyView() }, trailing: trailing)
    }
}

/// The grey › at the end of a row that pushes a page.
struct RowChevron: View {
    var body: some View {
        Image(glyph: .chevron)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Palette.secondaryText)
            .accessibilityHidden(true)
    }
}

/// A symbol in a square tile at the start of a row (drawn by the hand-drawn set via IconTile).
struct RowSymbol: View {
    var systemImage: String
    var tint: Color = Palette.tileGlyph

    var body: some View {
        IconTile(app: nil, systemImage: systemImage, size: 32, tint: tint)
    }
}

/// Rows highlight softly while pressed instead of the system grey flash.
struct RowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(Palette.menuSelection.opacity(configuration.isPressed ? 1 : 0))
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

extension View {
    /// The chrome every M4 sheet shares: grabber, app background, rounded corners.
    func duetSheetChrome() -> some View {
        presentationDragIndicator(.visible)
            .presentationBackground(Palette.sheetBackground)
            .presentationCornerRadius(Metrics.sheetCorner)
    }
}
