// The sign-in screen's capsules: a white full-width field (#333333 in dark, like the header
// circles) and the black primary button (white in dark) with a spinner while signing in.
import SwiftUI

struct CapsuleFieldStyle: ViewModifier {
    @ScaledMetric(relativeTo: .body) private var height: CGFloat = 52
    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 17

    func body(content: Content) -> some View {
        content
            .font(.system(size: fontSize))
            .foregroundStyle(Palette.primaryText)
            .tint(Palette.accent)
            .padding(.horizontal, 20)
            .frame(minHeight: height)
            .background(Capsule().fill(Palette.floatingSurface))
            .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: Metrics.hairline))
            .shadow(color: .black.opacity(0.05), radius: 5, y: 2)
            .contentShape(Capsule())
    }
}

extension View {
    func capsuleField() -> some View { modifier(CapsuleFieldStyle()) }
}

struct SignInButton: View {
    let working: Bool
    let enabled: Bool
    let action: () -> Void

    @ScaledMetric(relativeTo: .body) private var height: CGFloat = 54
    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 17

    var body: some View {
        Button(action: action) {
            ZStack {
                Text("Sign in").opacity(working ? 0 : 1)
                if working {
                    ProgressView().tint(Palette.background)
                }
            }
            .font(.system(size: fontSize, weight: .medium))
            .foregroundStyle(Palette.background)
            .frame(maxWidth: .infinity, minHeight: height)
            .background(Capsule().fill(Palette.composerAction))
            .contentShape(Capsule())
            .animation(.easeInOut(duration: 0.2), value: working)
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(!enabled || working)
        .opacity(enabled ? 1 : 0.35)
        .animation(.easeInOut(duration: 0.2), value: enabled)
        .accessibilityLabel(working ? Text("Signing in") : Text("Sign in"))
    }
}
