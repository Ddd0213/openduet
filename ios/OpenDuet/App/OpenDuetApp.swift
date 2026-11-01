// App entry point. RootView restores the saved session behind the launch mascot (L185), then
// crossfades to sign-in (L131), the onboarding flow (the server's onboardedAt is nil, or a
// long-press replay; real chips and Slack row from OnboardingModel, L77) or the main shell,
// which renders the ChatStore's ShellState. The app delegate and NotificationsCoordinator handle
// notifications, remote push and the background keep-alive (L78, L170).
import SwiftUI

@main
struct OpenDuetApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var session = SessionStore()

    var body: some Scene {
        WindowGroup {
            RootView(session: session)
        }
    }
}

struct RootView: View {
    let session: SessionStore

    @Environment(\.scenePhase) private var scenePhase
    /// Onboarding showed in this launch (its page 6 already asked for notifications).
    @State private var onboardingShown = false
    /// M29: the app's language on the iPhone's region and clock (AppLocale), for every date and
    /// duration the views format; read again when the iPhone's settings change.
    @State private var locale = AppLocale.current

    private enum Screen: Hashable { case launch, signIn, onboarding, shell }

    private var screen: Screen {
        switch session.phase {
        case .restoring: .launch
        case .signedOut: .signIn
        case .signedIn: session.needsOnboarding ? .onboarding : .shell
        }
    }

    var body: some View {
        ZStack {
            Palette.background.ignoresSafeArea()
            switch screen {
            case .launch:
                LaunchView()
                    .transition(.opacity)
            case .signIn:
                SignInView(session: session)
                    .transition(.opacity)
            case .onboarding:
                OnboardingHost(
                    model: session.onboarding,
                    needsModel: session.gate?.showsModelStep(modelsConfigured: session.user?.features.models ?? true) ?? false,
                    onModelsChanged: { session.chat?.refreshProfile() }
                ) { session.finishOnboarding() }
                    .environment(\.apiClient, session.client)
                    .id(session.onboardingRun)
                    .transition(.opacity)
            case .shell:
                if let chat = session.chat, let client = session.client {
                    ShellHost(
                        chat: chat,
                        onReplayOnboarding: { session.replayOnboarding() },
                        onSignOut: { session.signOut() }
                    )
                    .environment(\.authenticatedLoader, client)
                    .transition(.opacity)
                }
            }
        }
        .animation(.easeInOut(duration: 0.45), value: screen)
        // Signing in is an action of the user's that completed (L186).
        .sensoryFeedback(.success, trigger: session.phase) { old, new in old == .signedOut && new == .signedIn }
        .task {
            NotificationsCoordinator.shared.session = session
            await session.restore()
        }
        .onChange(of: screen, initial: true) { _, screen in
            switch screen {
            case .onboarding: onboardingShown = true
            case .shell: NotificationsCoordinator.shared.shellAppeared(afterOnboarding: onboardingShown)
            default: break
            }
        }
        // M22: Everything → Appearance on the window (WindowAppearance).
        .modifier(WindowAppearance())
        .onChange(of: scenePhase, initial: true) { _, phase in
            switch phase {
            case .active:
                NotificationsCoordinator.shared.didBecomeActive()
                session.setForeground(true)
            case .background:
                // Keep the event stream for as long as iOS allows; close it when time runs out.
                NotificationsCoordinator.shared.didEnterBackground { session.setForeground(false) }
            default: break
            }
        }
        // duet:// links from outside (ntfy / bark pushes carry one); OAuth callbacks go to
        // ASWebAuthenticationSession, not here.
        .onOpenURL { url in NotificationsCoordinator.shared.open(url) }
        .onReceive(NotificationCenter.default.publisher(for: NSLocale.currentLocaleDidChangeNotification)) { _ in
            locale = AppLocale.current
        }
        .environment(\.locale, locale)
    }
}

/// The onboarding flow with its real data and page 5's Slack OAuth page.
private struct OnboardingHost: View {
    let model: OnboardingModel?
    /// M12: "Add a model" first (OnboardingGate.showsModelStep) and the Me refresh after a change
    var needsModel = false
    var onModelsChanged: () -> Void = {}
    let onFinished: () -> Void

    @State private var asksModel: Bool?

    var body: some View {
        // Decided once: the step moves on by itself when a model gets configured, not by vanishing.
        let needsModel = asksModel ?? self.needsModel
        Group {
            if let model {
                let actions = model.actions
                OnboardingFlow(
                    chips: model.state.chips,
                    slackConnected: model.state.slackConnected,
                    slackConnecting: model.state.slackConnecting,
                    onConnectSlack: { actions.connectSlack() },
                    needsModel: needsModel,
                    onModelsChanged: onModelsChanged,
                    onFinished: { actions.finish() }
                )
                .oauthPresenter(model.state.oauth) { id, url in actions.oauthFinished(id, url) }
                .task { model.load() }
            } else {
                OnboardingFlow(needsModel: needsModel, onModelsChanged: onModelsChanged, onFinished: onFinished)
            }
        }
        .onAppear { if asksModel == nil { asksModel = self.needsModel } }
    }
}

/// The main shell, fed by the session's ChatStore. The app injects what the store can't do
/// itself: the long-press replay, sign-out and the iOS Settings link. Composio's OAuth page for
/// the OpenDuet sheet and connector detail is shown here, so the shell UI never handles it.
private struct ShellHost: View {
    let chat: ChatStore
    let onReplayOnboarding: () -> Void
    let onSignOut: () -> Void

    /// M13: the voice call of this session (one per ChatStore; a new session ends the old call).
    @State private var call: CallSession?

    var body: some View {
        let state = chat.state
        var actions = chat.actions
        actions.restartOnboarding = onReplayOnboarding
        actions.account.signOut = onSignOut
        actions.account.openNotificationSettings = { NotificationsCoordinator.openSettings() }
        let oauthFinished = actions.connectors.oauthFinished
        return MainShellView(state: state, actions: actions)
            .oauthPresenter(state.oauth) { id, url in oauthFinished(id, url) }
            // M8: run records for the OpenDuet sheet's Activity and the task detail's Run details.
            .environment(\.runs, chat.runsContext)
            // M11: pages that load their own data (Settings/**) reach the signed-in client.
            .environment(\.apiClient, chat.client)
            // M13: the voice call for the composer, the call bar and the Voice page.
            .environment(\.call, call)
            // M9: "Task deleted" / "Channel deleted" when what was open went away.
            .overlay(alignment: .top) { NoticeLayer(notice: state.notice) }
            .onChange(of: ObjectIdentifier(chat), initial: true) { _, _ in attachCall() }
            .onChange(of: chat.user.features.voice, initial: true) { _, ready in call?.voiceReady = ready }
            .onDisappear { detachCall() }
    }

    /// A call session wired to this ChatStore: its transcript lands in the chat, `call` cues reach
    /// the engine, and the event stream stays open in the background while a call is on.
    private func attachCall() {
        detachCall()
        let session = CallSession.live(client: chat.client)
        session.voiceReady = chat.user.features.voice
        session.onCallMessage = { [weak chat] message in chat?.insertCallMessage(message) }
        session.onActiveChanged = { [weak chat] active in chat?.holdStreamForCall(active) }
        chat.onCallCue = { [weak session] cue in session?.hear(cue) }
        call = session
    }

    private func detachCall() {
        call?.shutDown()
        call = nil
    }
}

/// M22 Everything → Appearance (System / Light / Dark, @AppStorage) set on the window, so sheets,
/// menus, share sheets and the Make page's web view follow too. The launch screen and the
/// system's notification banners still follow the iPhone.
private struct WindowAppearance: ViewModifier {
    @AppStorage(AppearanceChoice.storageKey) private var stored = AppearanceChoice.system.rawValue
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .onChange(of: stored, initial: true) { old, new in
                AppearanceChoice(stored: new).applyToWindows(animated: old != new)
            }
            // A window that wasn't there for the first pass (launch) gets the choice too.
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { AppearanceChoice(stored: stored).applyToWindows(animated: false) }
            }
    }
}

/// M22: the appearance choice as the windows' interface style (System: unspecified, the iPhone's).
extension AppearanceChoice {
    var interfaceStyle: UIUserInterfaceStyle {
        switch self {
        case .system: .unspecified
        case .light: .light
        case .dark: .dark
        }
    }

    /// Every window of the app's scenes; a change crossfades instead of jumping.
    @MainActor func applyToWindows(animated: Bool) {
        let style = interfaceStyle
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            for window in scene.windows where window.overrideUserInterfaceStyle != style {
                if animated {
                    UIView.transition(with: window, duration: 0.3, options: [.transitionCrossDissolve, .allowUserInteraction]) {
                        window.overrideUserInterfaceStyle = style
                    }
                } else {
                    window.overrideUserInterfaceStyle = style
                }
            }
        }
    }
}

/// M9: ShellState.notice floating under the header for a moment; it never takes touches.
private struct NoticeLayer: View {
    var notice: ShellNotice?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if let notice {
                ShellNoticeToast(notice: notice)
                    .id(notice.id)
                    .padding(.horizontal, 24)
                    .padding(.top, Metrics.headerMascot + 12)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity)
        .allowsHitTesting(false)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.38, dampingFraction: 0.86), value: notice)
    }
}
