// The Make tab's palette and sizes (prompt L147-L153, L158): the type tints (purple for design,
// design system and dashboard; orange for slides and the web page chip; blue for docs; a red
// globe in the FAB list), the hero card's soft washes, "Just made" orange, the Build view's
// progress line and the Link-style spend card's green.
import SwiftUI

extension Palette {
    static let makePurple = Color.dynamic(light: 0x7B5BD6, dark: 0xA48BF0)
    static let makeOrange = Color.dynamic(light: 0xD9730D, dark: 0xF0954A)
    static let makeBlue = Color.dynamic(light: 0x2F6FD6, dark: 0x6EA4FF)
    static let makeRed = Color.dynamic(light: 0xD14343, dark: 0xF06A6A)
    /// The hero card's tinted washes, by type family.
    static let heroWarm = Color.dynamic(light: 0xF6E9E6, dark: 0x2A1E1B)
    static let heroCool = Color.dynamic(light: 0xE6EEF9, dark: 0x18202C)
    static let heroViolet = Color.dynamic(light: 0xEEE9F8, dark: 0x221D2E)
    /// "Just made" border and badge, the Build view's progress line.
    static let justMade = Color(hex: 0xD65A45)
    /// The FAB's dimmed background.
    static let fanDim = Color.black.opacity(0.18)
    /// Link's green (the spend request's mark and the Approve in Link button).
    static let linkGreen = Color.dynamic(light: 0x00A35C, dark: 0x1FC27A)
    static let linkGreenText = Color.white
    /// Reaction badges: white circles with a hairline (#2A2A2A in dark).
    static let reactionBadge = Color.dynamic(light: 0xFFFFFF, dark: 0x2A2A2A)
}

extension Metrics {
    static let heroCorner: CGFloat = 26
    static let galleryCorner: CGFloat = 18
    static let thumbnailAspect: CGFloat = 0.75
    static let designTileWidth: CGFloat = 150
    static let templateWidth: CGFloat = 168
    static let fanCapsuleSpacing: CGFloat = 8
    static let buildCorner: CGFloat = 28
    static let reactionBadge: CGFloat = 26
}
