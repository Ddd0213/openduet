// PART A's buttons (prompt L19, L31): the black primary capsule, the white "Not now"
// capsule, and page 6's notification button with its requesting and "Notifications on" states.
import SwiftUI

private let buttonHeight: CGFloat = 56
private let labelFont = Font.system(size: 17, weight: .medium)

struct OnboardingPrimaryButton: View {
    let title: LocalizedStringKey
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(labelFont)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: buttonHeight)
                .background(Capsule().fill(OnboardingTheme.ink))
                .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
    }
}

struct OnboardingSecondaryButton: View {
    var title: LocalizedStringKey = "Not now"
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(labelFont)
                .foregroundStyle(OnboardingTheme.ink)
                .frame(maxWidth: .infinity)
                .frame(height: buttonHeight)
                .background(Capsule().fill(.white))
                .overlay(Capsule().strokeBorder(OnboardingTheme.hairline, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
    }
}

enum NotificationButtonState: Sendable { case idle, requesting, on }

struct NotificationButton: View {
    let state: NotificationButtonState
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                switch state {
                case .idle:
                    Text("Turn on notifications")
                case .requesting:
                    ProgressView().controlSize(.small).tint(.white)
                    Text("Turn on notifications")
                case .on:
                    Image(systemName: "checkmark").font(.system(size: 15, weight: .bold))
                    Text("Notifications on")
                }
            }
            .font(labelFont)
            .foregroundStyle(state == .on ? OnboardingTheme.successText : .white)
            .frame(maxWidth: .infinity)
            .frame(height: buttonHeight)
            .background(Capsule().fill(state == .on ? OnboardingTheme.successFill : OnboardingTheme.ink))
            .opacity(state == .requesting ? 0.6 : 1)
            .contentShape(Capsule())
            .contentTransition(.opacity)
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(state != .idle)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: state)
    }
}

#Preview {
    VStack(spacing: 10) {
        OnboardingPrimaryButton(title: "Next") {}
        OnboardingSecondaryButton {}
        NotificationButton(state: .idle) {}
        NotificationButton(state: .requesting) {}
        NotificationButton(state: .on) {}
    }
    .padding(20)
    .background(OnboardingTheme.background)
}
