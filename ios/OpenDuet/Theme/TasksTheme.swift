// M3 additions to the DESIGN SYSTEM (prompt L83-L84, L102-L121, L161): cards, task status
// colours, the edit glow and the Tasks tab's sizes. Additive only; base values live in
// Colors / Metrics / ChatTheme.
import SwiftUI

extension Palette {
    /// White rounded cards with hairline borders (L186): white in light, #1E1E1E-ish in dark.
    static let cardSurface = Color.dynamic(light: 0xFFFFFF, dark: 0x1C1C1C)
    static let cardBorder = Color.dynamic(light: 0xE4E4E4, dark: 0x343434)
    /// The green of done steps, the ✓ on started suggestions and "Sent" / "Paid".
    static let success = Color.dynamic(light: 0x1C760E, dark: 0x38C845)
    /// Swipe-to-start's panel behind a proactive suggestion.
    static let startPanel = Color.dynamic(light: 0x2E9B3E, dark: 0x2F9E43)
    /// Filled card buttons (Send, Approve, the alert's full-width button): black in light, white in dark.
    static let filledButton = Color.dynamic(light: 0x141413, dark: 0xFFFFFF)
    static let filledButtonText = Color.dynamic(light: 0xFFFFFF, dark: 0x141413)
    /// Outline buttons and pills.
    static let outline = Color.dynamic(light: 0x141413, dark: 0xF2F2F2).opacity(0.22)
    /// Tiles behind app icons and resource glyphs.
    static let tile = Color.dynamic(light: 0xF1F1F0, dark: 0x2A2A2A)
    /// The highlight behind a search match in a task title.
    static let searchMatch = Color(hex: 0xC7604A).opacity(0.18)
}

extension Metrics {
    /// Square icon tiles on cards and rows.
    static let iconTile: CGFloat = 36
    /// The Tasks tab's segmented title "Active" | "Up next" (~28 pt).
    static let tasksTitle: CGFloat = 28
    /// Task row titles (M22: 17 pt medium, up to 2 lines; was 20) and the task detail title (22 pt
    /// semibold, unchanged).
    static let taskRowTitle: CGFloat = 17
    static let taskDetailTitle: CGFloat = 22
    /// The rounded-square checkbox on task rows (M22: 22 pt; was 24).
    static let taskCheckbox: CGFloat = 22
    /// M22: a row's status line (was 14) and the group titles (17 regular grey; was 15 medium).
    static let taskStatusLine: CGFloat = 15
    static let taskGroupTitle: CGFloat = 17
    /// M22: the channel colour dot before a row's channel label in Everything.
    static let taskChannelDot: CGFloat = 6
    /// The orange + FAB.
    static let fab: CGFloat = 56
    /// How long changed text glows after an edit by chat (L163).
    static let editGlowSeconds: Double = 3
    /// Swipe-to-start: distance past which a release starts the suggestion.
    static let swipeStartThreshold: CGFloat = 110
}
