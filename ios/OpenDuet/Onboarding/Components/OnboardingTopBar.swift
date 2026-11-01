// The top of every onboarding page (prompt L19): six 22x3 pt progress dashes centred, and on
// pages 2-6 a 44 pt white circular back button at the top left.
import SwiftUI

struct ProgressDashes: View {
    let current: Int
    var count = 6

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<count, id: \.self) { i in
                Capsule()
                    .fill(i == current ? OnboardingTheme.ink : OnboardingTheme.dashInactive)
                    .frame(width: 22, height: 3)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: current)
        .accessibilityElement()
        .accessibilityLabel(Text("Page \(current + 1) of \(count)"))
    }
}

struct OnboardingBackButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.left")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(OnboardingTheme.ink)
                .frame(width: 44, height: 44)
                .background(Circle().fill(.white).shadow(color: OnboardingTheme.softShadow, radius: 6, y: 2))
                .contentShape(Circle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.92))
        .accessibilityLabel(Text("Back"))
    }
}

struct OnboardingTopBar: View {
    let page: OnboardingPage
    let onBack: () -> Void

    var body: some View {
        ZStack {
            ProgressDashes(current: page.rawValue)
            HStack {
                if page.previous != nil {
                    OnboardingBackButton(action: onBack).transition(.opacity)
                }
                Spacer()
            }
        }
        .frame(height: 44)
        .animation(.easeInOut(duration: 0.25), value: page.previous != nil)
    }
}
