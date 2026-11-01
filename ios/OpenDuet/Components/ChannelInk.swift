// M10: how a channel colour inks its line art (pure Foundation, host-tested). Channel icons no
// longer sit on a pale tile of their colour (as in OpenDuet): the colour goes straight onto
// the line, on the app's own background. In light mode the pale swatches (blush, sand, sage,
// mist, lavender) deepen a lot and the mid-bright ones (orange) a little so the line still reads
// on white; in dark mode every swatch reads as it is.
import Foundation

extension ChannelColor {
    /// The swatch as 0xRRGGBB.
    var hex: UInt32 { UInt32(rawValue.dropFirst(), radix: 16) ?? 0x8A8A86 }

    /// Perceived brightness, 0 (black) ... 1 (white).
    var luma: Double {
        let r = Double((hex >> 16) & 0xFF), g = Double((hex >> 8) & 0xFF), b = Double(hex & 0xFF)
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255
    }

    /// Pale swatches need a much deeper line to read on a light background.
    var isPale: Bool { luma > 0.7 }

    /// How much black the line mixes in on a light background (0 = the swatch as it is).
    var lightInkDarkening: Double {
        if isPale { return 0.42 }
        if luma > 0.6 { return 0.22 }
        return 0
    }
}

/// How much of a ChannelGlyph's frame the line art fills now that there is no tile: nearly all
/// of it inline (the status pill's 16 pt, the menu's 26 pt), a little less for the big
/// standalone previews (56 pt ChannelSheet, 84 pt New channel) so they don't read as heavy.
enum ChannelGlyphLayout {
    static func artRatio(for size: Double) -> Double {
        size <= 30 ? 0.94 : 0.8
    }
}
