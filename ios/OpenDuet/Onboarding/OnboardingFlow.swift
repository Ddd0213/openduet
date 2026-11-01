// The six onboarding pages, the notification step and the check celebration (prompt L11-L31).
// Page change: the old text and illustration fade out in 0.2 s, the new ones fade in in
// 0.35 s, and the new illustration starts from the beginning (also when going Back).
// PART A's palette is light only, so the flow forces light mode (L3).
import SwiftUI

struct OnboardingFlow: View {
    /// Page 2's chips from GET /api/onboarding (M4 wires them; empty until then).
    var chips: [OnboardingInfo.Chip] = []
    var slackConnected = false
    /// OnboardingDataState.slackConnecting: page 5's "+" shows a small spinner meanwhile.
    var slackConnecting = false
    var onConnectSlack: () -> Void = {}
    /// M12: "Add a model" comes first (a real first run on a server without a usable model).
    var needsModel = false
    var onModelsChanged: () -> Void = {}
    let onFinished: () -> Void

    @State private var page: OnboardingPage = .proactive
    @State private var contentVisible = true
    @State private var notification: NotificationButtonState = .idle
    @State private var celebrating = false
    @State private var modelStepDone = false

    var body: some View {
        if needsModel && !modelStepDone {
            // The app's own look (light / dark, Dynamic Type): not PART A's light-only pages.
            OnboardingModelStep(onDone: { withAnimation(.easeInOut(duration: 0.35)) { modelStepDone = true } }, onModelsChanged: onModelsChanged)
                .transition(.opacity)
        } else {
            pages.transition(.opacity)
        }
    }

    private var pages: some View {
        ZStack {
            OnboardingTheme.background.ignoresSafeArea()
            VStack(spacing: 0) {
                OnboardingTopBar(page: page, onBack: back)
                    .padding(.horizontal, 20)
                    .padding(.top, 6)
                OnboardingPageView(
                    page: page, chips: chips, slackConnected: slackConnected,
                    slackConnecting: slackConnecting, onConnectSlack: onConnectSlack
                )
                    .id(page)
                    .padding(.top, 24)
                    .opacity(contentVisible ? 1 : 0)
                buttons
                    .padding(.horizontal, 20)
                    .padding(.bottom, 12)
            }
            .opacity(celebrating ? 0 : 1)
            .allowsHitTesting(!celebrating)
            if celebrating {
                CelebrationView(onFinished: onFinished)
            }
        }
        .preferredColorScheme(.light)
        .dynamicTypeSize(.large)
    }

    @ViewBuilder private var buttons: some View {
        VStack(spacing: 10) {
            switch page.buttons {
            case .next:
                OnboardingPrimaryButton(title: "Next") { go(to: page.next) }
            case .connect:
                OnboardingPrimaryButton(title: "Continue") { go(to: .notify) }
                OnboardingSecondaryButton { go(to: .notify) }
            case .notify:
                NotificationButton(state: notification, action: turnOnNotifications)
                OnboardingSecondaryButton(action: celebrate)
            }
        }
        .id(page.buttons)
        .transition(.opacity)
        .animation(.easeInOut(duration: 0.25), value: page.buttons)
        .disabled(!contentVisible)
    }

    private func go(to target: OnboardingPage?) {
        guard let target, contentVisible else { return }
        withAnimation(.easeOut(duration: 0.2)) {
            contentVisible = false
        } completion: {
            page = target
            withAnimation(.easeIn(duration: 0.35)) { contentVisible = true }
        }
    }

    private func back() {
        go(to: page.previous)
    }

    private func turnOnNotifications() {
        notification = .requesting
        Task {
            let allowed = await NotificationPermission.request()
            guard allowed else {
                // Declined: nothing turns green; continue as "Not now" does.
                notification = .idle
                celebrate()
                return
            }
            notification = .on
            try? await Task.sleep(for: .seconds(1.0))
            celebrate()
        }
    }

    private func celebrate() {
        guard !celebrating else { return }
        withAnimation(.easeOut(duration: 0.3)) { celebrating = true }
    }
}

#Preview {
    OnboardingFlow {}
}
