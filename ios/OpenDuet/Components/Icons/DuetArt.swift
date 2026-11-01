// The app's hand-drawn line icon set (M9), keyed by one enum. Each drawing is a few monoline
// ink strokes on a 24-unit grid (ArtPen) plus at most one soft accent shape printed a little
// off-register behind them, like the mascot's orange disc under its black squiggle. Pure
// SwiftUI: no UIKit, no Palette, no app types (the macOS contact sheet compiles these files).
// The app maps its concepts onto it in Theme/DuetGlyph.swift (DuetGlyph, CardIcon) and
// ArtSymbols.swift (SF Symbol names passed to the shared tiles).
import SwiftUI

/// Every drawing in the set.
enum DuetArt: String, CaseIterable, Sendable {
    // Work and documents
    case bulb, doc, file, pages, zipDoc, sheetGrid, slides, gauge, window, brush
    case checklist, clipboard, calendar, clock, timer, sunrise
    // Talk and people
    case envelope, bubble, bubbles, replyBubble, thinkBubble, question
    case person, personCircle, people, folder, link, magnifier, globe
    // Things
    case chartLine, bars, banknote, coin, cart, gift, mapPin, house, plane, book, notebook
    case tray, archive, stack, cube, car, camera, photo, music, mic, waveform, keyboard
    case flask, scissors, bag, sprout, briefcase, playScreen, layers
    // Apps and tools
    case card, computer, grid, wrench, terminal, code, database, paperclip
    case seal, shield, stamp, signature, trash, paperPlane, pin, eye
    case pencil, compose, make, share, refresh, pointer, quote, sort
    // Marks
    case sparkle, heart, star, bell, bellOff, warning, check, checkbox
    case done, failed, pending, info, action, arrowOut, play, wifiOff, slashCircle
    // Hero and chrome
    case chat, tasks, menu, contents, plus, close, chevronRight, chevronLeft, arrowDown, ellipsis
}

/// The set's fixed parameters (also used by the tile and the contact sheet).
enum ArtStyle {
    /// Drawings live on a 24 × 24 grid.
    static let grid: CGFloat = 24

    /// The one stroke weight of the set: 7% of the icon up to 24 pt (1.5 pt at 22, the 36-pt
    /// tile's art 1.5 pt), never under 1.15 pt so 16 pt holds, then easing off so big
    /// empty-state art stays a line, not a marker.
    static func lineWidth(for size: CGFloat) -> CGFloat {
        let eased = size <= 24 ? size * 0.07 : 24 * 0.07 + (size - 24) * 0.04
        return max(1.15, eased)
    }

    /// How far long lines bow (scales every drawing's `bow`): enough to read as drawn by hand
    /// at 36 pt, never enough to look wobbly at 16.
    static let bowGain: CGFloat = 2.0

    /// The accent's misregistration: printed down and to the right of the ink, in grid units.
    static let accentShift = CGVector(dx: 0.9, dy: 0.75)
    /// Only icons at least this big get the accent (tile glyphs, empty states).
    static let accentMinSize: CGFloat = 13

    /// The accent clay (the mascot's #C7604A, a touch warmer; lighter on graphite so it reads as
    /// clay, not brown) and how strongly it prints.
    static let clay: UInt32 = 0xD97757
    static let clayDark: UInt32 = 0xE8906F
    static let accentOpacityLight: Double = 0.6
    static let accentOpacityDark: Double = 0.62

    /// Ink: warm near-black / warm off-white (the mascot's line colours, softened a hair).
    static let inkLight: UInt32 = 0x1F1E1B
    static let inkDark: UInt32 = 0xEDEAE4

    /// The tile: warm paper (light) / soft graphite (dark), a hairline rim, continuous corners.
    static let tileLight: UInt32 = 0xF3F0EA
    static let tileDark: UInt32 = 0x2A2927
    static let rimLight: UInt32 = 0x1F1E1B
    static let rimDark: UInt32 = 0xFFFFFF
    static let rimOpacityLight: Double = 0.075
    static let rimOpacityDark: Double = 0.09
    static let tileCornerRatio: CGFloat = 0.26
    /// The drawing's size inside a tile.
    static let tileArtRatio: CGFloat = 0.6
}

extension Color {
    /// 0xRRGGBB, pure SwiftUI (the engine can't use the app's UIKit-backed `Color(hex:)`).
    init(artHex hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

/// One layer of a drawing: the ink strokes or the accent fill.
struct DuetArtShape: Shape {
    enum Layer: Sendable { case ink, accent }
    var art: DuetArt
    var layer: Layer = .ink

    func path(in rect: CGRect) -> Path {
        var ink = ArtPen(rect: rect)
        var tone = ArtPen(rect: rect, shift: ArtStyle.accentShift)
        ArtDraw.draw(art, &ink, &tone)
        return layer == .ink ? ink.path : tone.path
    }
}
