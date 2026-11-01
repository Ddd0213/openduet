// M22 (#47) Everything → Setup: what this iPhone and your server have set up. The phone's
// Notifications row first (UNUserNotificationCenter; off -> "Turn on"), then one row per server
// dependency (GET /api/setup) with its status word, detail line and fix. "Check again" (POST
// /api/setup/check) tries each set-up row; a 429 says "Try again in a moment" under the button.
// Loading is a skeleton, a failed load the grey line with Retry; never an alert.
import SwiftUI

struct SetupPage: View {
    var onBack: () -> Void
    /// a fix opens a page of the settings sheet (models, apps, voice)
    var onOpenPage: (DuetRoute.SettingsPage) -> Void
    /// a fix opens another in-app link (duet://computer)
    var onOpenLink: (URL) -> Void
    /// notifications are off in iOS Settings: AccountActions.openNotificationSettings
    var onOpenNotificationSettings: () -> Void

    @Environment(\.apiClient) private var api
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = SetupModel()

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Setup"), leading: .back, onLeading: onBack)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    SettingsNote(text: Text("What this iPhone and your server have set up. Anything that needs setup says how."))
                    rows
                    checkAgain
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .refreshable {
                await model.refreshNotifications()
                await model.load()
            }
        }
        .task {
            model.attach(api)
            await model.refreshNotifications()
            await model.load()
        }
        // Back from iOS Settings: the permission may have changed there.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refreshNotifications() } }
        }
        .animation(.easeInOut(duration: 0.2), value: model.info.value)
        .animation(.easeInOut(duration: 0.2), value: model.checkFailure)
        .sensoryFeedback(.success, trigger: model.checks)
        .sensoryFeedback(.warning, trigger: model.checkFailure) { _, new in new != nil }
    }

    private var rows: some View {
        CardSection(dividerInset: Metrics.settingsTileInset) {
            SetupPhoneNotificationsRow(access: model.notifications) {
                Task { await model.turnOnNotifications(openSettings: onOpenNotificationSettings) }
            }
            switch model.info.display {
            case .loading:
                ForEach(0..<3, id: \.self) { _ in SetupSkeletonRow() }
            case .failed(let reason):
                InlineRetryLine(reason: reason) { Task { await model.load() } }
            case .loaded(let info):
                ForEach(info.items) { item in
                    SetupItemRow(item: item, onFix: fix)
                }
            }
        }
    }

    @ViewBuilder private var checkAgain: some View {
        if model.info.value != nil {
            VStack(alignment: .leading, spacing: 8) {
                CapsuleButton(title: Text("Check again"), style: .outline, busy: model.checking) {
                    Task { await model.check() }
                }
                .disabled(model.checking)
                if let failure = model.checkFailure {
                    SettingsReasonLine(reason: failure)
                        .padding(.horizontal, 6)
                        .transition(.opacity)
                }
                SettingsNote(text: Text("Check again tries each part that is set up: a short model call, a search, OpenDuet's computer and the push channel."))
            }
            .transition(.opacity)
        }
    }

    private func fix(_ action: SetupFixAction) {
        switch action {
        case .page(let page): onOpenPage(page)
        case .link(let url): onOpenLink(url)
        case .env: break
        }
    }
}

/// A server row while GET /api/setup runs (the card around it is already there).
private struct SetupSkeletonRow: View {
    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Palette.skeleton)
                .frame(width: 32, height: 32)
            VStack(alignment: .leading, spacing: 6) {
                RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(width: 110, height: 13)
                RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(width: 200, height: 10)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: Metrics.sheetRowMinHeight + 8)
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading"))
    }
}
