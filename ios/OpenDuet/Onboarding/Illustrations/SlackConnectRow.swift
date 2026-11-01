// Onboarding page 5 (prompt L29, L77): one white rounded row with a hairline border, the
// four-colour Slack mark, "Slack", and a "+" on the right that turns into a green check once
// Slack is connected. The parent owns the state: "+" calls `onConnect` (which starts the real
// Composio connection) and the row only reflects `isConnected`.
import SwiftUI

struct SlackConnectRow: View {
    var isConnected: Bool
    var onConnect: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 12) {
            SlackMark()
                .frame(width: 26, height: 26)
                .accessibilityHidden(true)
            Text("Slack")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(OnboardingTheme.ink)
                .lineLimit(1)
            Spacer(minLength: 8)
            trailing
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .frame(height: 60)
        .onboardingCard(cornerRadius: 18)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(isConnected ? Text("Slack connected") : Text("Connect Slack"))
        .accessibilityAddTraits(isConnected ? [] : .isButton)
        .accessibilityAction {
            if !isConnected { onConnect() }
        }
        .sensoryFeedback(.success, trigger: isConnected) { old, new in !old && new }
    }

    /// "+" until connected, then the green check; the swap springs.
    private var trailing: some View {
        Button {
            if !isConnected { onConnect() }
        } label: {
            ZStack {
                if isConnected {
                    CheckBadge(size: 28)
                        .transition(swap)
                } else {
                    Image(systemName: "plus")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(OnboardingTheme.ink)
                        .frame(width: 30, height: 30)
                        .background(Circle().fill(OnboardingTheme.pillFill))
                        .transition(swap)
                }
            }
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .allowsHitTesting(!isConnected)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.38, dampingFraction: 0.62), value: isConnected)
    }

    private var swap: AnyTransition {
        reduceMotion ? .opacity : .scale(scale: 0.4).combined(with: .opacity)
    }
}

/// Shrinks a little while pressed (no system highlight).
private struct PressScaleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.88 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

#Preview {
    @Previewable @State var connected = false
    VStack(spacing: 20) {
        SlackConnectRow(isConnected: connected) { connected = true }
        SlackConnectRow(isConnected: true) {}
    }
    .padding(.vertical)
    .padding(.horizontal, OnboardingTheme.sideMargin)
    .background(OnboardingTheme.background)
}
