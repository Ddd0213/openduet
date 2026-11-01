// PART A's own palette and type (prompt L19). The six onboarding pages and the check
// celebration keep these exact values in light and dark (L3), so the flow forces light mode.
import SwiftUI

enum OnboardingTheme {
    static let ink = Color(hex: 0x141413)
    static let body = Color(hex: 0x3D3D3A)
    /// M29: the mascot's orange (MascotFace.bodyRGB), the same in the app.
    static let accent = Color(hex: 0xC7604A)
    static let peach = Color(hex: 0xE9B5A6)
    static let grey = Color(hex: 0x8A8A86)
    static let hairline = Color(hex: 0xE3E3E3)
    static let pillFill = Color(hex: 0xECECEC)
    static let dashInactive = Color(hex: 0xD6D6D6)
    static let clockFill = Color(hex: 0xFAFAFA)
    static let silhouette = Color(hex: 0xE6E6E6)
    static let fieldFill = Color(hex: 0xF2F2F2)
    static let successFill = Color(hex: 0xDFF3DA)
    static let successText = Color(hex: 0x2E7D32)
    static let checkGreen = Color(hex: 0x34A853)

    /// #F9F9F9 at the top fading to #F3F3F3 at the bottom.
    static let background = LinearGradient(
        colors: [Color(hex: 0xF9F9F9), Color(hex: 0xF3F3F3)],
        startPoint: .top,
        endPoint: .bottom
    )

    /// .system(size: 26, weight: .semibold, design: .serif); Chinese falls back per L88.
    static let title = Typography.serifTitle(26)
    static let titleTracking: CGFloat = -0.2
    static let bodyFont = Font.system(size: 14.5)
    static let bodyLineSpacing: CGFloat = 2
    static let sideMargin: CGFloat = 18

    /// White capsule with a hairline border and a soft shadow (chips, cards).
    static let softShadow = Color.black.opacity(0.06)
}

extension View {
    /// White surface with PART A's hairline border and soft shadow.
    func onboardingCard(cornerRadius: CGFloat) -> some View {
        background(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(.white)
                .shadow(color: OnboardingTheme.softShadow, radius: 6, y: 2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(OnboardingTheme.hairline, lineWidth: 0.5)
        )
    }

    func onboardingCapsule() -> some View {
        background(Capsule().fill(.white).shadow(color: OnboardingTheme.softShadow, radius: 5, y: 2))
            .overlay(Capsule().strokeBorder(OnboardingTheme.hairline, lineWidth: 0.5))
    }
}
