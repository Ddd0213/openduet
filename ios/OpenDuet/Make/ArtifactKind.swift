// How each Make type looks (prompt L147-L149): its name, SF Symbol, tint, the hero card's wash
// and auto-typed example, the Describe sheet's caption, and the FAB list's order (Design System,
// Design, Dashboard, Slides, Docs, Web page).
import SwiftUI

extension ArtifactType {
    /// The FAB's capsules, top to bottom.
    static let fanOrder: [ArtifactType] = [.designSystem, .design, .dashboard, .slides, .docs, .webPage]
    /// The hero card cycles through these.
    static let heroOrder: [ArtifactType] = [.webPage, .docs, .slides]

    var title: LocalizedStringResource {
        switch self {
        case .webPage: "Web page"
        case .docs: "Docs"
        case .slides: "Slides"
        case .dashboard: "Dashboard"
        case .design: "Design"
        case .designSystem: "Design System"
        }
    }

    var systemImage: String {
        switch self {
        case .webPage: "globe"
        case .docs: "doc.text"
        case .slides: "rectangle.on.rectangle"
        case .dashboard: "chart.bar.xaxis"
        case .design: "paintbrush.pointed"
        case .designSystem: "square.grid.2x2"
        }
    }

    /// M9: the type as a key of the hand-drawn set (type icons and chips). `systemImage` stays
    /// for the tab bar item and menus, which need an SF Symbol.
    var cardIcon: CardIcon {
        switch self {
        case .webPage: .webpage
        case .docs: .doc
        case .slides: .slides
        case .dashboard: .dashboard
        case .design: .design
        // No design-system key: the nearest is design.
        case .designSystem: .design
        }
    }

    /// The hero chip's glyph ("⊕ Web page", "▢ Docs", "▭ Slides").
    var chipImage: String {
        switch self {
        case .webPage: "plus.circle"
        case .docs: "square"
        case .slides: "rectangle"
        default: systemImage
        }
    }

    var tint: Color {
        switch self {
        case .designSystem, .design, .dashboard: Palette.makePurple
        case .slides, .webPage: Palette.makeOrange
        case .docs: Palette.makeBlue
        }
    }

    /// The FAB list tints the web page's globe red (L148).
    var fanTint: Color { self == .webPage ? Palette.makeRed : tint }

    var heroWash: Color {
        switch self {
        case .docs: Palette.heroCool
        case .dashboard, .design, .designSystem: Palette.heroViolet
        case .webPage, .slides: Palette.heroWarm
        }
    }

    /// The hero composer's auto-typed idea.
    var example: LocalizedStringResource {
        switch self {
        case .webPage: "A booking page for my bike shop"
        case .docs: "A one-page brief"
        case .slides: "A pitch deck for the bakery"
        case .dashboard: "A dashboard of this week's meetings and inbox"
        case .design: "A poster for the spring market"
        case .designSystem: "A design system for my studio"
        }
    }

    /// The Describe sheet's caption under the illustration.
    var caption: LocalizedStringResource {
        switch self {
        case .webPage: "A web page"
        case .docs: "A doc"
        case .slides: "A slide deck"
        case .dashboard: "A dashboard"
        case .design: "A design"
        case .designSystem: "A design system"
        }
    }
}

/// A type's symbol in its tint, in a soft rounded square (gallery footers, chat cards, pills).
struct ArtifactTypeIcon: View {
    var type: ArtifactType
    var size: CGFloat = 22

    var body: some View {
        DuetIcon(type.cardIcon, size: size * 0.7, tint: type.tint)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).fill(type.tint.opacity(0.12)))
            .accessibilityHidden(true)
    }
}

/// "⊕ Web page" / "▢ Docs" / "▭ Slides": the type chip of the hero and Describe composers.
struct ArtifactTypeChip: View {
    var type: ArtifactType

    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 14

    var body: some View {
        HStack(spacing: 5) {
            DuetIcon(type.cardIcon, size: fontSize + 3, tint: type.tint)
            Text(type.title)
                .font(.system(size: fontSize, weight: .semibold))
                .lineLimit(1)
                .fixedSize()
        }
        .foregroundStyle(type.tint)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Capsule().fill(type.tint.opacity(0.12)))
    }
}
