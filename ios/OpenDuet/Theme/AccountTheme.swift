// M4 additions to the design system: the side menu, sheets (the assistant, connector detail, profile,
// Usage, New channel) and the Scheduled rows. Add-only; existing tokens stay where they are.
import SwiftUI

extension Palette {
    /// The side menu panel and the sheets' background (the app background, so cards stand off it).
    static let sheetBackground = Color.dynamic(light: 0xF4F4F4, dark: 0x0C0C0C)
    /// The grey pill behind the selected menu row.
    static let menuSelection = Color.dynamic(light: 0x141413, dark: 0xF2F2F2).opacity(0.07)
    /// The menu's tree connector lines.
    static let treeLine = Color.dynamic(light: 0xD3D3D0, dark: 0x3C3C3A)
    /// The dim over the chat's visible edge while the menu is open.
    static let menuDim = Color.black.opacity(0.22)
    /// The Usage bars: thin blue fill, red once a limit is reached (L128).
    static let usageBar = Color.dynamic(light: 0x3B7DDD, dark: 0x5E9BF0)
    static let usageFull = Color.dynamic(light: 0xD23F31, dark: 0xF0614F)
    static let usageTrack = Color.dynamic(light: 0x141413, dark: 0xF2F2F2).opacity(0.08)
    /// "Everything" in the menu: the orange stacked-layers tile.
    static let everything = Color(hex: 0xD65A45)
    /// Destructive capsule (Sign out, Disconnect) in the in-app confirmation.
    static let destructive = Color.dynamic(light: 0xC8402F, dark: 0xE5604E)
    /// The dashed "+" ring on rows that aren't connected yet.
    static let dashedRing = Color.dynamic(light: 0x141413, dark: 0xF2F2F2).opacity(0.35)
}

extension Metrics {
    /// The side menu's share of the screen width (L123).
    static let menuWidthFraction: CGFloat = 0.8
    /// The chat's corner radius while it sits shifted right.
    static let menuContentCorner: CGFloat = 32
    /// Icon tiles in the menu rows.
    static let menuIcon: CGFloat = 30
    /// Settings-style rows inside sheet cards.
    static let sheetRowMinHeight: CGFloat = 52
    /// Corner radius of the sheets.
    static let sheetCorner: CGFloat = 28
}
