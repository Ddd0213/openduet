// M2 additions to the DESIGN SYSTEM (prompt L82-L84) for the main thread: links, code, cards,
// skeletons and the chat's spacing. Additive only; the base values live in Colors / Metrics.
import SwiftUI

extension Palette {
    /// Links in the assistant's bubbles ("blue links", L100).
    static let link = Color.dynamic(light: 0x2F6FD6, dark: 0x6EA4FF)
    /// The subtle pill behind inline task links.
    static let linkPill = Color.dynamic(light: 0x2F6FD6, dark: 0x6EA4FF).opacity(0.12)
    /// Code blocks, inline code and table headers inside an assistant bubble.
    static let codeSurface = Color.dynamic(light: 0xF6F6F5, dark: 0x2A2A2A)
    static let inlineCode = Color.dynamic(light: 0x141413, dark: 0xF2F2F2).opacity(0.08)
    /// Skeleton bubbles and image placeholders.
    static let skeleton = Color.dynamic(light: 0xE2E2E2, dark: 0x1E1E1E)
    /// The failed-send mark and its line.
    static let failure = Color(hex: 0xC34929)
}

extension Metrics {
    /// Horizontal inset of the thread and the composer.
    static let threadInset: CGFloat = 16
    /// Space above a bubble from another sender, and around separators and system lines.
    static let groupSpacing: CGFloat = 14
    static let sectionSpacing: CGFloat = 20
    /// Image bubbles: at most this wide and tall.
    static let imageBubbleMax: CGFloat = 240
    /// Composer attachment thumbnails.
    static let thumbnail: CGFloat = 56
    /// How far a left swipe moves the thread to show message times (L114).
    static let timeReveal: CGFloat = 64
}
