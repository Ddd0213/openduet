// A channel's tinted icon (prompt L123-L124): the New channel sheet's 3×8 icons, drawn by the
// hand-drawn set (M9; `systemImage` stays for menus) in one of the 9 swatches. Used by the side
// menu, the Archived list, the New channel preview and grid, and the header pill. M10: the line
// itself carries the colour, with no pale tile behind it (as in OpenDuet).
import SwiftUI

extension ChannelIcon {
    /// The hand-drawn drawing (every channel icon has one).
    var art: DuetArt { DuetArt(symbol: systemImage) ?? .sparkle }

    /// The SF Symbol closest to the spec's icon (menus; the visible icon is `art`).
    var systemImage: String {
        switch self {
        case .checkbox: "checkmark.square"
        case .calendar: "calendar"
        case .mail: "envelope"
        case .dollar: "dollarsign.circle"
        case .chart: "chart.bar"
        case .globe: "globe"
        case .pin: "mappin.and.ellipse"
        case .house: "house"
        case .cube: "cube"
        case .play: "play.rectangle"
        case .folder: "folder"
        case .pencil: "pencil"
        case .magnifier: "magnifyingglass"
        case .heart: "heart"
        case .people: "person.2"
        case .briefcase: "briefcase"
        case .book: "book"
        case .plane: "airplane"
        case .car: "car"
        case .scissors: "scissors"
        case .bag: "bag"
        case .gift: "gift"
        case .sprout: "leaf"
        case .music: "music.note"
        }
    }

    /// VoiceOver name of the icon in the grid.
    var label: LocalizedStringResource {
        switch self {
        case .checkbox: "Checkbox"
        case .calendar: "Calendar"
        case .mail: "Mail"
        case .dollar: "Dollar"
        case .chart: "Bar chart"
        case .globe: "Globe"
        case .pin: "Map pin"
        case .house: "House"
        case .cube: "Cube"
        case .play: "Play screen"
        case .folder: "Folder"
        case .pencil: "Pencil"
        case .magnifier: "Magnifier"
        case .heart: "Heart"
        case .people: "People"
        case .briefcase: "Briefcase"
        case .book: "Book"
        case .plane: "Plane"
        case .car: "Car"
        case .scissors: "Scissors"
        case .bag: "Shopping bag"
        case .gift: "Gift"
        case .sprout: "Sprout"
        case .music: "Music note"
        }
    }
}

extension ChannelColor {
    // `hex`, `luma`, `isPale` and `lightInkDarkening` live in ChannelInk.swift (host-tested).

    var color: Color { Color(hex: hex) }

    /// The line colour on the app's background: in light mode pale swatches deepen a lot and
    /// mid-bright ones a little (ChannelInk); in dark mode every swatch reads as it is.
    func glyph(in scheme: ColorScheme) -> Color {
        let darkening = lightInkDarkening
        guard scheme == .light, darkening > 0 else { return color }
        return color.mix(with: .black, by: darkening)
    }

    /// VoiceOver name of the swatch.
    var label: LocalizedStringResource {
        switch self {
        case .berry: "Berry"
        case .blush: "Blush"
        case .sand: "Sand"
        case .orange: "Orange"
        case .sage: "Sage"
        case .green: "Green"
        case .mist: "Mist"
        case .blue: "Blue"
        case .lavender: "Lavender"
        }
    }
}

/// A channel's icon: the line art in the channel colour itself. M10: no tile behind it any more
/// (as in OpenDuet); the frame stays `size` square so every call site keeps its layout.
struct ChannelGlyph: View {
    var icon: ChannelIcon
    var color: ChannelColor
    var size: CGFloat = Metrics.menuIcon

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        // The swatch is the colour: the line in it, no clay accent.
        let artSize = size * CGFloat(ChannelGlyphLayout.artRatio(for: Double(size)))
        ZStack {
            DuetArtView(art: icon.art, size: artSize, ink: color.glyph(in: colorScheme))
                .id(icon)
                .transition(.opacity)
        }
        .frame(width: size, height: size)
        .animation(.easeInOut(duration: 0.2), value: icon)
        .animation(.easeInOut(duration: 0.2), value: color)
        .accessibilityHidden(true)
    }
}

/// "Everything": the orange stacked-layers tile at the top of the menu tree.
struct EverythingGlyph: View {
    var size: CGFloat = Metrics.menuIcon

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(Palette.everything)
            .frame(width: size, height: size)
            .overlay {
                DuetArtView(art: .layers, size: size * 0.64, ink: .white)
            }
            .accessibilityHidden(true)
    }
}
