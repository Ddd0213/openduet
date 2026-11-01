// The profile sheet (prompt L127), M16: also the settings. The initials circle opens it (and
// "Set up models" / a call's "Set up" open it at Models / Voice). Name and email; Usage; the assistant:
// Models, Voice, Apps and connectors, Skills (what the user sets up, moved here from the assistant
// sheet, decided by the user); Memory and Files; Send feedback; Sign out (asks in place first).
// Each row pushes its page. M9: no Notifications card (a morning brief is a scheduled task you ask
// for in chat) and no Payments row. Refreshes the user and the connectors when it appears. The
// long-press on the initials still replays onboarding (wired in the header). M19: the pages form a
// hierarchy (`parent`), so Apps and connectors > Add connector pushes over Apps and Back slides
// the right way; the sheet gets only the slices of ShellState it reads (ProfileSheetState) and
// skips what it fetched less than a minute ago (ProfileSheetCache). M22: Setup (#47), Language
// and Appearance under the assistant; Setup's fixes push Models / Voice / Apps over it (Back returns to
// Setup); a duet://settings/<page> link opens the sheet at that page, or switches the page while
// it is up (SettingsPageRequest, ChatStore+Settings.swift), Who OpenDuet is included. M25: Skills'
// Add skill menu: Create with OpenDuet (the sheet closes, the main thread's composer opens with
// the prefill: ComposeRequest), Upload a skill (the picked file's upload page) and Import from
// GitHub; the old New skill form has no entry any more.
import SwiftUI

struct ProfileSheet: View, Equatable {
    let state: ProfileSheetState
    let actions: ShellActions
    let onClose: () -> Void
    let initialPage: Page?
    let cache: ProfileSheetCache

    enum Page: Hashable, Sendable {
        case usage, memory, files, feedback
        /// M16: the settings that moved here from the OpenDuet sheet
        case models, modelsRoute(ModelsRoute), voice
        case apps, moreApps, connector(String), addConnector
        /// M17: Add connector's "Add your own" pages (Back goes to Add connector)
        case addManually, pasteConfig
        /// M25: Import from GitHub, and Upload a skill with the file picked in Files
        case skills, skill(String), importGitHub, uploadSkill(URL)
        /// M22: Setup (#47), and Who OpenDuet is when a link asks for it (duet://settings/soul)
        case setup, soul
        /// M28: Signed-in devices (sign out one / the others)
        case devices
    }

    @State private var page: Page?
    /// a create / import / add finished: one success haptic here (the page that did it is gone)
    @State private var successes = 0
    /// Where Models was opened from: Voice's "Set up models" goes back to Voice, the row to the root.
    @State private var modelsFrom: Page?
    /// M22: where Voice / Apps were opened from (Setup's fixes go back to Setup, the rows to the root).
    @State private var fixFrom: Page?
    @Environment(\.apiClient) private var api
    @Environment(\.locale) private var locale

    init(
        state: ProfileSheetState, actions: ShellActions, initialPage: Page? = nil,
        cache: ProfileSheetCache? = nil, onClose: @escaping () -> Void
    ) {
        self.state = state
        self.actions = actions
        self.onClose = onClose
        self.initialPage = initialPage
        self.cache = cache ?? ProfileSheetCache()
        // M22: a link's page (duet://settings/<page>) when the sheet opens without one of its own.
        _page = State(initialValue: initialPage ?? SettingsPageRequest.shared.wanted.map(Self.page(for:)))
    }

    /// M22: the sheet's page for a duet://settings/<page> link.
    static func page(for page: DuetRoute.SettingsPage) -> Page {
        switch page {
        case .models: .models
        case .apps: .apps
        case .voice: .voice
        case .setup: .setup
        case .soul: .soul
        }
    }

    /// M19: the closures always reach the same store, so only the slices decide a redraw.
    nonisolated static func == (lhs: ProfileSheet, rhs: ProfileSheet) -> Bool {
        lhs.state == rhs.state && lhs.initialPage == rhs.initialPage && lhs.cache === rhs.cache
    }

    /// M16: what the settings load through `\.apiClient` (models, skills, custom connectors).
    private var settings: EverythingModel { cache.settings }
    /// M13: GET / PUT /api/voice-settings (the Voice row and page)
    private var voice: VoiceSettingsModel { cache.voice }

    var body: some View {
        PushContainer(page: $page, parent: parent) {
            root
        } destination: { page in
            destination(page)
        }
        // M22: a link asked for a page while the sheet is up; the one it opened with is used up.
        .onChange(of: SettingsPageRequest.shared.token) { _, _ in
            guard let wanted = SettingsPageRequest.shared.take() else { return }
            modelsFrom = nil
            fixFrom = nil
            page = Self.page(for: wanted)
        }
        .onAppear {
            _ = SettingsPageRequest.shared.take()
            // M19: what loaded less than a minute ago isn't fetched again (FetchFreshness).
            let cache = cache
            if cache.freshness.claim(ProfileSheetCache.Part.profile, loaded: state.profile.user != nil) {
                actions.account.refreshProfile()
            }
            if cache.freshness.claim(ProfileSheetCache.Part.connectors, loaded: state.assistant.phase == .loaded) {
                actions.connectors.refresh()
            }
        }
        .task {
            let settings = settings
            let voice = voice
            settings.attach(api)
            // A model or voice change (configured on / off): the session refreshes Me.
            settings.models.onChange = actions.account.refreshProfile
            voice.attach(api)
            voice.onChange = actions.account.refreshProfile
            // M27: a key or region saved on Voice is the same provider row Models lists.
            let models = settings.models
            voice.onProvidersChanged = { await models.load() }
            let loadSettings = cache.freshness.claim(ProfileSheetCache.Part.settings, loaded: settingsLoaded)
            let loadVoice = cache.freshness.claim(
                ProfileSheetCache.Part.voice, loaded: voice.settings.value != nil && voice.settings.failure == nil
            )
            await withTaskGroup(of: Void.self) { group in
                if loadSettings { group.addTask { await settings.refreshSettings() } }
                if loadVoice { group.addTask { await voice.load() } }
            }
        }
        .sensoryFeedback(.success, trigger: successes)
        // M6: a file tapped on the Files page previews over this sheet.
        .filePreviewHost(preview: state.filePreview, active: !state.previewCovered, actions: actions.files)
    }

    /// Models, skills and custom connectors are all on screen without a failure.
    private var settingsLoaded: Bool {
        let s = settings
        return s.models.state.value != nil && s.models.state.failure == nil
            && s.skills.value != nil && s.skills.failure == nil
            && s.connectors.value != nil && s.connectors.failure == nil
    }

    /// M19: where each page's Back goes (nil = the root), so the container knows a push from a pop.
    private func parent(_ page: Page) -> Page? {
        switch page {
        case .usage, .memory, .files, .feedback, .skills, .setup, .soul, .devices: nil
        case .voice, .apps: fixFrom
        case .models: modelsFrom
        case .modelsRoute(let route): route.parent(settings.models).map { .modelsRoute($0) } ?? .models
        case .moreApps, .connector, .addConnector: .apps
        case .addManually, .pasteConfig: .addConnector
        case .skill, .importGitHub, .uploadSkill: .skills
        }
    }

    private var root: some View {
        VStack(spacing: 0) {
            SheetHeader(title: nil, leading: .close, onLeading: onClose)
            ScrollView {
                VStack(spacing: 22) {
                    ProfileHeader(user: state.profile.user)
                    CardSection(dividerInset: 16 + 32 + 12) {
                        SheetRow(title: Text("Usage"), action: { page = .usage }) {
                            RowSymbol(systemImage: "chart.bar")
                        } trailing: { RowChevron() }
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        SheetSectionTitle(text: Text(verbatim: "OpenDuet"))
                        CardSection(dividerInset: 16 + 32 + 12) {
                            SettingsModelsRow(models: settings.models, onOpen: { modelsFrom = nil; page = .models })
                            SettingsVoiceRow(voice: voice, models: settings.models, onOpen: { fixFrom = nil; page = .voice })
                            SheetRow(title: Text("Apps and connectors"), subtitle: appsLine, action: { fixFrom = nil; page = .apps }) {
                                RowSymbol(systemImage: "square.grid.2x2")
                            } trailing: { RowChevron() }
                            SettingsSkillsRow(model: settings, onOpen: { page = .skills })
                        }
                    }
                    // M22: what's set up, the app's language (iOS Settings) and its appearance.
                    CardSection(dividerInset: 16 + 32 + 12) {
                        SettingsSetupRow(onOpen: { page = .setup })
                        SettingsLanguageRow()
                        SettingsAppearanceRow()
                    }
                    CardSection(dividerInset: 16 + 32 + 12) {
                        SheetRow(title: Text("Memory"), action: { page = .memory }) {
                            RowSymbol(systemImage: DuetGlyph.memory.symbol)
                        } trailing: { RowChevron() }
                        SheetRow(title: Text("Files"), action: { page = .files }) {
                            RowSymbol(systemImage: "doc")
                        } trailing: { RowChevron() }
                    }
                    CardSection(dividerInset: 16 + 32 + 12) {
                        SheetRow(title: Text("Send feedback"), action: { page = .feedback }) {
                            RowSymbol(systemImage: "bubble.left")
                        } trailing: { RowChevron() }
                    }
                    // M28: the devices signed in to this account (nothing is fetched until it opens).
                    CardSection(dividerInset: 16 + 32 + 12) {
                        SheetRow(title: Text("Signed-in devices"), action: { page = .devices }) {
                            RowSymbol(systemImage: "iphone.and.arrow.forward")
                        } trailing: { RowChevron() }
                    }
                    InlineConfirm(
                        title: Text("Sign out"),
                        question: Text("Sign out of this server? Your chats and tasks stay on it."),
                        confirmTitle: Text("Sign out"),
                        onConfirm: actions.account.signOut
                    )
                    .cardSurface()
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
        }
    }

    /// "Gmail, Google Calendar and My MCP": the connected apps' and custom connectors' names, when
    /// there are any.
    private var appsLine: Text? {
        var seen = Set<String>()
        let names = (ConnectedApps.list(state.assistant).map(\.name) + (settings.connectors.value ?? []).map(\.name))
            .filter { seen.insert($0).inserted }
        guard !names.isEmpty else { return nil }
        return Text(verbatim: names.formatted(.list(type: .and).locale(locale)))
    }

    /// M22: a Setup fix pushes its page over Setup; Back comes back to Setup.
    private func openFromSetup(_ wanted: DuetRoute.SettingsPage) {
        let next = Self.page(for: wanted)
        switch next {
        case .models: modelsFrom = .setup
        case .voice, .apps: fixFrom = .setup
        default: break
        }
        page = next
    }

    /// M22: a link to somewhere outside the sheet (Setup's duet://computer, Set up in chat's main
    /// thread). The computer closes the sheet itself; anything else opens once the sheet is down.
    private func openLink(_ url: URL) {
        if DuetRoute(url) == .computer {
            actions.openRoute(url)
            return
        }
        onClose()
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            NotificationsCoordinator.shared.open(url)
        }
    }

    /// M26: Files' task group titles (duet://tasks/<id>) and artifact pages (duet://artifacts/<id>)
    /// open what they name over the shell, so the sheet goes down first (openLink).
    private var filesActions: FileActions {
        var files = actions.files
        files.openLink = { url in openLink(url) }
        return files
    }

    /// M25 Create with OpenDuet: the sheet goes down, then the main thread opens with the composer
    /// prefilled ("Help me create a skill: ", cursor at the end, keyboard up); nothing is sent.
    private func createWithAssistant() {
        let text = String(localized: SkillCreatePrefill.text)
        onClose()
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            ComposeRequest.shared.ask(text)
        }
    }

    @ViewBuilder private func destination(_ page: Page) -> some View {
        let back = { self.page = nil }
        switch page {
        case .usage:
            UsageView(
                screen: state.usageScreen, leading: .back, onLeading: back,
                onLoad: actions.account.loadUsageStats
            )
        case .memory:
            MemoryPage(
                phase: state.profile.memoryPhase, memory: state.profile.memory,
                request: state.cardRequests[ShellState.RequestKey.saveMemory],
                onLoad: actions.account.loadMemory, onSave: actions.account.saveMemory,
                onBack: back
            )
        case .files:
            FilesPage(list: state.mainFiles, actions: filesActions, onBack: back)
        case .feedback:
            FeedbackPage(request: state.cardRequests[ShellState.RequestKey.feedback], onSend: actions.account.sendFeedback, onBack: back)
        case .models:
            ModelsPage(models: settings.models, onLeading: { self.page = modelsFrom }, onOpen: { self.page = .modelsRoute($0) })
        case .modelsRoute(let route):
            modelsDestination(route)
        case .voice:
            VoicePage(voice: voice, models: settings.models, onBack: { self.page = fixFrom }, onOpenModels: { modelsFrom = .voice; self.page = .models })
        case .apps:
            AppsAndConnectorsPage(
                assistant: state.assistant, model: settings, actions: actions.connectors,
                onOpenConnector: { self.page = .connector($0) }, onAddConnector: { self.page = .addConnector },
                onMoreApps: { self.page = .moreApps }, onBack: { self.page = fixFrom }
            )
        case .setup:
            SetupPage(
                onBack: back, onOpenPage: openFromSetup, onOpenLink: openLink,
                onOpenNotificationSettings: actions.account.openNotificationSettings
            )
        case .soul:
            // M22: only through a link (duet://settings/soul); the OpenDuet sheet has the row.
            SoulPage(model: settings, onBack: back, onOpenChat: openLink)
        case .devices:
            DevicesPage(onBack: back)
        case .moreApps:
            MoreAppsView(assistant: state.assistant, requests: state.cardRequests, actions: actions.connectors) { self.page = .apps }
        case .connector(let id):
            CustomConnectorPage(model: settings, connectorId: id) { self.page = .apps }
        case .addConnector:
            AddConnectorPage(
                model: settings, onBack: { self.page = .apps },
                onAdded: { connector in
                    successes += 1
                    self.page = .connector(connector.id)
                },
                onOpen: { self.page = .connector($0) },
                onAddManually: { self.page = .addManually },
                onPasteConfig: { self.page = .pasteConfig }
            )
        case .addManually:
            ManualConnectorPage(model: settings, onBack: { self.page = .addConnector }) { connector in
                successes += 1
                self.page = .connector(connector.id)
            }
        case .pasteConfig:
            PasteConfigPage(model: settings, onBack: { self.page = .addConnector }, onOpen: { self.page = .connector($0) })
        case .skills:
            SkillsPage(
                model: settings, onOpen: { self.page = .skill($0) },
                onCreateWithAssistant: createWithAssistant,
                onUpload: { self.page = .uploadSkill($0) },
                onGitHub: { self.page = .importGitHub }, onBack: back
            )
        case .skill(let id):
            SkillDetailPage(model: settings, skillId: id) { self.page = .skills }
        case .importGitHub:
            SkillImportPage(model: settings, mode: .github, onBack: { self.page = .skills }) { _ in
                successes += 1
                self.page = .skills
            }
        case .uploadSkill(let url):
            SkillImportPage(model: settings, mode: .upload(url), onBack: { self.page = .skills }) { _ in
                successes += 1
                self.page = .skills
            }
        }
    }

    /// M27: StepFun's regions and their hosts (the voice settings the sheet loads; none on an older server)
    private var presets: [VoiceProviderPreset] { voice.settings.value?.presets ?? [] }

    /// M12: the Models pages; Back goes to the page above (the Models page at the top).
    @ViewBuilder private func modelsDestination(_ route: ModelsRoute) -> some View {
        let models = settings.models
        // Taken now: after a delete the model is gone but Back still goes to its provider.
        let parent: Page = route.parent(models).map { .modelsRoute($0) } ?? .models
        let back = { self.page = parent }
        let open = { (next: ModelsRoute) in self.page = .modelsRoute(next) }
        switch route {
        case .addProvider:
            AddProviderPage(onLeading: back, onPick: { open(.providerForm($0)) })
        case .providerForm(let kind):
            ProviderFormPage(models: models, kind: kind, presets: presets, onBack: back) { provider in
                successes += 1
                open(.remoteModels(provider.id))
            }
        case .provider(let id):
            ProviderDetailPage(models: models, providerId: id, presets: presets, onBack: back, onOpen: open)
        case .remoteModels(let providerId):
            RemoteModelsPage(models: models, providerId: providerId, onLeading: back) {
                successes += 1
                open(.provider(providerId))
            }
        case .model(let id):
            ModelDetailPage(models: models, modelId: id, onBack: back)
        }
    }
}

/// The large initials circle, the name in the serif and the email (or username) under it.
struct ProfileHeader: View {
    var user: CurrentUser?

    @ScaledMetric(relativeTo: .title) private var nameSize: CGFloat = 26
    @ScaledMetric(relativeTo: .subheadline) private var emailSize: CGFloat = 15

    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                if let monogram = Initials.monogram(for: user?.name) {
                    Text(verbatim: monogram)
                        .font(.system(size: 26, weight: .semibold))
                        .minimumScaleFactor(0.6)
                        .transition(.opacity)
                } else {
                    DuetIcon(glyph: .profile, size: 34, tint: Palette.primaryText)
                        .transition(.opacity)
                }
            }
            .foregroundStyle(Palette.primaryText)
            .floatingCircle(76, interactive: false)
            .accessibilityHidden(true)
            if let user {
                Text(verbatim: user.name)
                    .font(Typography.serifTitle(nameSize))
                    .foregroundStyle(Palette.primaryText)
                    .multilineTextAlignment(.center)
                    .transition(.opacity)
                Text(verbatim: user.email ?? user.username)
                    .font(.system(size: emailSize))
                    .foregroundStyle(Palette.secondaryText)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                    .transition(.opacity)
            } else {
                VStack(spacing: 8) {
                    RoundedRectangle(cornerRadius: 5).fill(Palette.skeleton).frame(width: 150, height: 22)
                    RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(width: 190, height: 13)
                }
                .skeletonPulse()
                .accessibilityLabel(Text("Loading"))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
        .animation(.easeInOut(duration: 0.25), value: user?.id)
        .accessibilityElement(children: .combine)
    }
}

/// The connected apps across the access rows and the catalog, each once, in that order.
enum ConnectedApps {
    static func list(_ assistant: AssistantAccessState) -> [Connector] {
        var seen = Set<String>()
        return (assistant.rows.flatMap(\.connected) + assistant.catalog).filter { $0.isConnected && seen.insert($0.toolkit).inserted }
    }
}
