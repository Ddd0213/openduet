// DESIGN SYSTEM colours (prompt L82-L84), light and dark following the system.
// The six onboarding pages and the check celebration keep PART A's own palette (OnboardingTheme, M1).
import SwiftUI
import UIKit

extension Color {
    /// A colour that follows the system appearance.
    static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }

    init(hex: UInt32) {
        self.init(uiColor: UIColor(hex: hex))
    }
}

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

enum Palette {
    static let background = Color.dynamic(light: 0xF4F4F4, dark: 0x0C0C0C)
    static let assistantBubble = Color.dynamic(light: 0xE7E7E7, dark: 0x1E1E1E)
    static let assistantText = Color.dynamic(light: 0x141413, dark: 0xF2F2F2)
    static let userBubble = Color.dynamic(light: 0xF4D0BE, dark: 0x461A16)
    static let userText = Color.dynamic(light: 0x141413, dark: 0xF3E3DD)
    static let primaryText = Color.dynamic(light: 0x141413, dark: 0xF2F2F2)
    static let secondaryText = Color.dynamic(light: 0x8A8A86, dark: 0x9A9A96)
    static let accent = Color(hex: 0xC7604A)
    static let badge = Color(hex: 0xC34929)
    static let fab = Color(hex: 0xD65A45)
    static let readyForReview = Color.dynamic(light: 0x1C760E, dark: 0x38C845)
    static let needsInput = Color(hex: 0xD79100)
    static let working = Color(hex: 0x5B86D3)
    /// Header circles and floating capsules: white in light, #333333 in dark.
    static let floatingSurface = Color.dynamic(light: 0xFFFFFF, dark: 0x333333)
    static let hairline = Color.dynamic(light: 0xE4E4E4, dark: 0x3A3A3A)
    /// Filled waveform / send circle: black in light, white in dark.
    static let composerAction = Color.dynamic(light: 0x141413, dark: 0xFFFFFF)
}
