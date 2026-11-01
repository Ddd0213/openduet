// The main app shell (prompt L94-L97, L116-L121, L161): the system tab bar (M19) with one page
// per tab (Chat, Tasks, Make, the pinned artifact), each with the floating header (the offline
// bar under it) and, above the bar, the composer (Chat) or Make's one + FAB (M9: Tasks has a "+"
// in its title row instead). The open task detail covers it all and follows the finger back (DetailSwipeBack). M19:
// on the Chat tab a pull from the left screen edge opens the side menu. A long-pressed chat
// bubble opens its menu over everything (BubbleMenuHost). It renders ShellState and calls
// ShellActions; it never touches the network.
import SwiftUI

struct MainShellView: View {
    var state: ShellState
    var actions: ShellActions

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// M13: the app's voice call (nil in previews).
    @Environment(\.call) private var call
    @State private var tab: AppTab = .chat
    @State private var draft = ""
    @State private var composerFocused = false
    @State private var searchFocused = false
    @State private var jumpRequest = 0
    @State private var showNewTask = false
    /// The side menu (L123) and its New channel sheet (L124) are the UI's own state.
    @State private var menuOpen = false
    @State private var showNewChannel = false
    /// M19: bumped by every channel switch from the shell, so a menu pick that lands after the
    /// menu's slide doesn't undo one made meanwhile (the call pill, a link).
    @State private var selectToken = 0
    /// The last Mark complete / Archive per task, so a row's Retry repeats it.
    @State private var rowActions: [String: TaskRowAction] = [:]
    /// M6: the Make FAB's fan (L148), the FAB's frame for drawing it, and the Describe sheet's
    /// type (L149).
    @State private var fanOpen = false
    /// M9: the FAB's slot in the Make page's BottomChrome (MakeFanLayer.pageSpace).
    @State private var fabSlot: CGRect = .zero
    /// M9: the bubble long-press menu (one at a time, over the whole shell).
    @State private var bubbleMenu = BubbleMenuCenter()
    @State private var describing: ArtifactType?
    /// The 4th tab's page colour (ArtifactViewer.onChrome): the header and the tab bar take its
    /// look, and the viewer's colour reaches up behind the header as one block.
    @State private var pinnedChrome: ViewerChrome?
    /// The full-screen viewer's page colour (only for the status bar: it covers the shell).
    @State private var viewerChrome: ViewerChrome?
    /// M29: the build the Build view shows (kept through its hand-over to the viewer), and the
    /// mascot's `done` when it is ready.
    @State private var watchedBuild: String?
    @State private var buildDone: MascotEvent?
    /// Its last status line, shown through the hand-over (the store clears it when ready).
    @State private var watchedStatus: Phrase?
    @Environment(\.colorScheme) private var colorScheme

    /// `initialTab` is for previews; the app always opens on Chat.
    init(state: ShellState, actions: ShellActions, initialTab: AppTab = .chat) {
        self.state = state
        self.actions = actions
        _tab = State(initialValue: initialTab)
    }

    var body: some View {
        SideMenuContainer(isOpen: menuOpen, onClose: closeMenu, canOpen: canPullMenu, onOpen: openMenu) {
            ZStack {
                shell
                    .accessibilityHidden(state.taskDetail != nil || state.make.viewer != nil || fanOpen)
                // M9: Make's one FAB and its fan, in one layer over the shell (L148): the FAB keeps
                // its identity while it morphs into ✕, and the fan's open / close is one spring.
                MakeFanLayer(
                    isOpen: fanOpen, showsFAB: showsFAB, slot: fabSlot,
                    onToggle: { setFan(!fanOpen) },
                    onPick: { type in
                        setFan(false)
                        describing = type
                    },
                    onClose: { setFan(false) }
                )
                .accessibilityHidden(state.taskDetail != nil || state.make.viewer != nil)
                .zIndex(0.5)
                if let detail = state.taskDetail {
                    TaskDetailView(
                        detail: detail, actions: shellActions,
                        onMarkComplete: taskActions.markComplete, onArchive: taskActions.archive,
                        onClose: closeDetail
                    )
                    // M16: a new task starts with its updates folded and every detail closed.
                    .id(detail.taskId)
                    // M19: the drag lives in the modifier, so a swipe frame doesn't re-run the shell.
                    .modifier(DetailSwipeBack(onClose: closeDetail))
                    .accessibilityHidden(state.make.viewer != nil)
                    .transition(reduceMotion ? .opacity : .move(edge: .trailing))
                    .zIndex(1)
                }
                // M6: the artifact viewer / docs reader opens over whatever is on screen (L151).
                if let viewer = state.make.viewer, viewer.artifactId != handover {
                    ArtifactViewer(
                        viewer: viewer, make: state.make, actions: actions.make, onOpenRoute: actions.openRoute,
                        onClose: actions.make.close, onChrome: { viewerChrome = $0 }
                    )
                        .id(viewer.artifactId)
                        .accessibilityAction(.escape, actions.make.close)
                        .transition(reduceMotion ? .opacity : .move(edge: .bottom))
                        .zIndex(3)
                }
            }
            .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.42, dampingFraction: 0.9), value: state.taskDetail?.taskId)
            .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.42, dampingFraction: 0.9), value: state.make.viewer?.artifactId)
            .coordinateSpace(.named(MakeFanLayer.space))
        } menu: {
            SideMenuView(
                menu: state.menu, requests: state.cardRequests, actions: actions.menu,
                onSelect: selectChannel, onNewChannel: { showNewChannel = true }
            )
            .accessibilityAction(.escape, closeMenu)
            .sheet(isPresented: $showNewChannel) {
                NewChannelSheet(
                    request: state.cardRequests[ShellState.RequestKey.createChannel],
                    onCreate: actions.menu.create,
                    onCancel: { showNewChannel = false },
                    onCreated: {
                        showNewChannel = false
                        closeMenu()
                    },
                    // M11: "What can OpenDuet use here?" lists what the main thread can use.
                    mainChannelId: state.profile.user?.mainChannelId,
                    onCreateWithAccess: actions.menu.createWithAccess
                )
                .duetSheetChrome()
                .presentationDetents([.large])
            }
        }
        .environment(\.cardContext, CardContext(state: state))
        // M6: chat's artifact cards, reactions, skills and inline artifact pills read these.
        .environment(\.makeState, state.make)
        .environment(\.chatExtras, state.chatExtras)
        .environment(\.artifactTypes, artifactTypes)
        // M9: the bubble menu covers everything above (header, side menu, task detail, tab bar).
        .bubbleMenuHost(bubbleMenu)
        // M6: the Describe sheet (L149) stays until Create is answered, then the Build view shows.
        .fullScreenCover(item: $describing) { type in
            DescribeSheet(
                type: type, request: state.make.requests[MakeState.RequestKey.create],
                onCreate: { prompt in actions.make.create(type, prompt) },
                onClose: { describing = nil }
            )
        }
        .onChange(of: state.make.requests[MakeState.RequestKey.create]) { old, new in
            if old == .inFlight && new == nil { describing = nil }
        }
        // The pinned artifact went away (removed, or another took its place elsewhere): back to Make.
        .onChange(of: state.make.pinned?.id) { _, id in
            if id == nil && tab == .pinned { tab = .make }
        }
        .onChange(of: state.make.viewer?.artifactId) { _, id in
            if id != nil { composerFocused = false; searchFocused = false; fanOpen = false }
        }
        // M29: a build made here hands over to its viewer after the mascot's hop (BuildHeader).
        .onChange(of: state.make.build, initial: true) { _, id in
            if let id, id != watchedBuild { watchedStatus = state.make.buildStatus[id] }
            if id != nil || reduceMotion || state.make.viewer?.artifactId != watchedBuild { watchedBuild = id }
        }
        .onChange(of: state.make.build.flatMap { state.make.buildStatus[$0] }) { _, status in
            if let status { watchedStatus = status }
        }
        .onChange(of: handover) { old, new in
            if new != nil { buildDone = MascotEvent(.done) } else if old != nil { watchedBuild = nil }
        }
        .task(id: handover) {
            guard handover != nil else { return }
            try? await Task.sleep(for: .seconds(Self.handoverHold))
            guard !Task.isCancelled else { return }
            withAnimation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.42, dampingFraction: 0.9)) {
                watchedBuild = nil
            }
        }
        // The assistant / profile / Usage sheets and the connector detail follow the store (M4).
        .presentedSheets(state: state, actions: actions)
        .connectorDetailSheet(state: state, actions: actions, active: state.presented == nil)
        // M16: the call's "Set up" opens the settings (the profile sheet) at its Voice page.
        .onChange(of: call.map(ObjectIdentifier.init), initial: true) { _, _ in
            call?.onOpenVoiceSettings = actions.openVoice
        }
        // M6 (iOS 1): the assistant's computer, the file preview and the channel sheet.
        .computerOverlays(state: state, actions: shellActions)
        // The viewer's bars take the page's colour, but the clock and battery always follow the
        // system look: where they would clash (a dark page in light mode, or the other way) they
        // hide (decided by the user).
        .modifier(HideStatusBar(hidden: statusBarClashes))
        // A notification or duet:// link asks for a tab; every switch is reported (L91 rules).
        .onChange(of: state.tabRequest) { _, request in
            guard let request else { return }
            selectToken += 1
            menuOpen = false
            tab = AppTab(request.tab)
        }
        // M25: Settings › Skills › Create with OpenDuet: the main thread with a prefilled composer.
        .onChange(of: ComposeRequest.shared.token) { _, _ in
            guard let text = ComposeRequest.shared.take() else { return }
            composeInMain(text)
        }
        .onChange(of: tab, initial: true) { _, new in actions.tabChanged(ShellTab(new)) }
        .onChange(of: state.taskDetail?.taskId) { _, id in
            if id != nil { composerFocused = false; searchFocused = false }
        }
        .sheet(isPresented: $showNewTask) {
            NewTaskSheet(
                request: state.cardRequests[ShellState.createTaskRequest],
                saveRequest: state.cardRequests[ShellState.RequestKey.saveForLater],
                onStart: actions.tasks.create,
                onSave: actions.tasks.saveForLater,
                onDone: { showNewTask = false }
            )
        }
    }

    /// M19 (decided by the user): the system tab bar. Every tab is a page of its own, with the
    /// header on top and its bottom chrome above the bar; the TabView keeps each page alive, so the
    /// thread's scroll position survives a tab switch. The Build view covers the page it opens over
    /// (header included), not the bar; a tap on any tab leaves it (the build goes on).
    private var shell: some View {
        // M21 (L152): with the 4th tab, all four are icons only (TabBarRule); VoiceOver still
        // reads each tab's name (the 4th: its artifact's title).
        let titled = TabBarRule.showsTitles(tabCount: TabBarRule.tabCount(hasPinned: state.make.pinned != nil))
        return TabView(selection: tabSelection) {
            Tab(value: AppTab.chat) {
                tabPage(.chat) { chatPage }
            } label: {
                tabLabel(Text(AppTab.chat.title), systemImage: AppTab.chat.systemImage, titled: titled)
            }
            .accessibilityLabel(Text(AppTab.chat.title))
            Tab(value: AppTab.tasks) {
                tabPage(.tasks) { tasksPage }
            } label: {
                tabLabel(Text(AppTab.tasks.title), systemImage: AppTab.tasks.systemImage, titled: titled)
            }
            // The tasks that need the user (0 shows none).
            .badge(state.tasksNeedingUser)
            .accessibilityLabel(Text(AppTab.tasks.title))
            .accessibilityValue(state.tasksNeedingUser > 0 ? Text("\(state.tasksNeedingUser) waiting for you") : Text(verbatim: ""))
            Tab(value: AppTab.make) {
                tabPage(.make) { MakeTabView(state: state.make, actions: actions.make) }
            } label: {
                tabLabel(Text(AppTab.make.title), systemImage: AppTab.make.systemImage, titled: titled)
            }
            .accessibilityLabel(Text(AppTab.make.title))
            // M6 (L152): the artifact added to the tab bar, named after it, with its type's icon.
            if let pinned = state.make.pinned {
                let name = TabBarRule.pinnedLabel(title: pinned.title).map { Text(verbatim: $0) } ?? Text(AppTab.pinned.title)
                Tab(value: AppTab.pinned) {
                    tabPage(.pinned) {
                        PinnedArtifactTab(
                            make: state.make, actions: actions.make, onOpenRoute: actions.openRoute,
                            onEditing: { _ in }, onChrome: { pinnedChrome = $0 }
                        )
                    }
                } label: {
                    tabLabel(name, systemImage: pinned.type.systemImage, titled: titled)
                }
                .accessibilityLabel(name)
                // M21 (L152): long-press "− Remove from tab bar" (iOS 18 TabContent.contextMenu).
                // The page's ⋯ and Make's long-press keep offering it too.
                .contextMenu {
                    Button { actions.make.setPinned(pinned.id, false) } label: {
                        Label { Text("Remove from tab bar") } icon: { Image(glyph: .removeFromTabBar) }
                    }
                }
            }
        }
        // The selected tab in ink, as before (the pages keep the app's accent, see tabPage).
        .tint(Palette.primaryText)
        .modifier(NeverMinimizeTabBar())
        .onChange(of: tab) { _, new in
            if new != .chat { composerFocused = false }
            if new != .tasks { searchFocused = false }
            if fanOpen { setFan(false) }
        }
        .onChange(of: state.make.build) { _, id in
            if id != nil { composerFocused = false; searchFocused = false }
        }
        // The gallery loads once up front so an artifact added to the tab bar shows as the 4th tab.
        .task { if state.make.phase == .loading && state.make.artifacts.isEmpty { actions.make.refresh() } }
    }

    /// One tab's page: its content, the Build view over it while the assistant builds (L150, L164), the
    /// header on top and the bottom chrome above the system tab bar. M9: both sit on the
    /// progressive blur mask (Theme/ChromeBars; after M13 the long soft fade): the content passes
    /// under it while scrolling and rests clear of it. On the 4th tab there is no mask at all: the
    /// viewer's page colour reaches up behind the header (one block, no seam) and down under the
    /// bar; the header and the bar take its look (pinnedChrome).
    ///
    /// Type-erased on purpose: the TabView builds every Tab's content up front (unlike the old
    /// `switch tab`, which built one page), so with concrete types the shell's view value is the
    /// sum of all four pages. Unoptimized (Debug) builds copy that value through every wrapper in
    /// `body` on the main thread's stack and overflowed it right after sign-in (2026-10-28,
    /// "Thread stack size exceeded" in MainShellView.body). AnyView keeps each page in one heap
    /// box; each Tab's type stays fixed, so identity and state are unchanged.
    private func tabPage<Content: View>(_ page: AppTab, @ViewBuilder content: () -> Content) -> AnyView {
        let pinnedPage = page == .pinned && shownBuild == nil
        let tint = pinnedPage ? pinnedChrome : nil
        let main = content()
        return AnyView(ZStack {
            main
            if let id = shownBuild {
                BuildView(
                    artifact: state.make.artifact(id), artifactId: id,
                    status: state.make.buildStatus[id] ?? (id == handover ? watchedStatus : nil),
                    request: state.make.requests[MakeState.RequestKey.create],
                    onRetry: { actions.make.retryBuild(id) }
                )
                // Behind the header and the bottom chrome too: their long soft fade lets what is
                // under the Build view (a 4th tab's page colour, the thread) show through otherwise.
                .background(Palette.background.ignoresSafeArea())
                .transition(.opacity)
                .zIndex(1)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: shownBuild)
        // A tap outside the composer dismisses the keyboard (L162).
        .simultaneousGesture(TapGesture().onEnded { composerFocused = false })
        .duetBar(.top, masked: !pinnedPage, long: .shellTop) {
            header.environment(\.colorScheme, tint?.scheme ?? colorScheme)
        }
        // BottomChrome draws its own mask (behind the composer, down past the tab bar).
        .duetBar(.bottom, masked: false) {
            BottomChrome(
                makeSlot: page == .make && shownBuild == nil,
                onMakeFrame: { if $0 != .zero { fabSlot = $0 } },
                masked: !pinnedPage
            ) {
                bottomContent(page)
            }
            .environment(\.colorScheme, tint?.scheme ?? colorScheme)
        }
        .background(Palette.background.ignoresSafeArea())
        // The app's accent inside the pages (the TabView's ink tint is for the bar's selected tab).
        .tint(Color.accentColor)
        // The 4th tab's bar takes its page's look (nil elsewhere: the system's).
        .toolbarColorScheme(tint?.scheme, for: .tabBar)
        // The FAB's slot is measured in this space (it lines up with MakeFanLayer.space).
        .coordinateSpace(.named(MakeFanLayer.pageSpace)))
    }

    /// What sits above the tab bar: the assistant's working pill while it builds (a failed build shows
    /// Retry in the Build view instead), the composer on Chat, else nothing.
    @ViewBuilder private func bottomContent(_ page: AppTab) -> some View {
        if let id = shownBuild {
            if state.make.artifact(id)?.status != .failed {
                WorkingPill()
                    .padding(.horizontal, Metrics.threadInset)
                    .padding(.bottom, Metrics.composerAboveTabBar)
                    .transition(.opacity)
            }
        } else if page == .chat {
            VStack(spacing: 6) {
                // M12: a quiet line until a model is set up; "Set up" opens Everything → Models.
                if !state.modelsConfigured {
                    NoModelHint(onSetUp: shellActions.openModels)
                        .transition(.opacity)
                }
                ComposerBar(
                    draft: $draft, isFocused: $composerFocused, placeholder: placeholder,
                    composer: state.composer, actions: shellActions, allowsSkills: true,
                    callChannelId: threadChannelId,
                    // M23: the newest open Up next suggestion floats above the main composer
                    upNext: ComposerUpNext(state: state)
                ) { jumpRequest += 1 }
            }
            .animation(.easeInOut(duration: 0.25), value: state.modelsConfigured)
            // The composer's own changes in the focus update (its field, the circle) follow the
            // keyboard's curve; the keyboard's safe area lifts it 8 pt above the keyboard.
            .animation(ChromeBar.keyboardAnimation(reduceMotion: reduceMotion), value: composerFocused)
            .padding(.horizontal, Metrics.threadInset)
            .padding(.bottom, Metrics.composerAboveTabBar)
            .transition(.opacity)
        }
    }

    /// Chat: the thread (the TabView keeps it alive under the other tabs).
    private var chatPage: some View {
        ThreadView(thread: state.thread, status: state.status, isActive: tab == .chat && state.taskDetail == nil && !covered, actions: shellActions, jumpRequest: jumpRequest)
            .environment(\.cardHooks, CardHooks(
                focusComposer: { tab = .chat; composerFocused = true },
                showAllTasks: { tab = .tasks }
            ))
            // M16: one identity per channel, so a switch starts with fresh scroll state at the
            // bottom. The swap is instant (M19: it happens once the side menu has closed, see
            // selectChannel; a duet:// link can still switch while it slides).
            .transition(.identity)
            .id(state.threadChannelId)
            .transaction(value: state.threadChannelId) { $0.animation = nil }
    }

    private var tasksPage: some View {
        TasksTabView(
            state: state.tasks, requests: state.cardRequests, actions: taskActions, rowActions: rowActions,
            otherChannels: Set(state.menu.channels.map(\.id)),
            // M22: the 6 pt channel dot before a row's #channel in Everything.
            channelColors: Dictionary(state.menu.channels.map { ($0.id, $0.colorHex) }, uniquingKeysWith: { first, _ in first }),
            searchFocused: $searchFocused,
            onMarkComplete: taskActions.markComplete, onArchive: taskActions.archive,
            onMessageAssistant: messageAssistant,
            // M9: the title row's "+" replaces the Tasks FAB.
            onNewTask: state.make.build == nil ? { showNewTask = true } : nil
        )
    }

    /// The tab bar's selection: a tap on a tab leaves the Build view first (the build goes on);
    /// switches from the app itself (links, "Message OpenDuet") set `tab` directly, as before.
    private var tabSelection: Binding<AppTab> {
        Binding(
            get: { tab },
            set: { new in
                if state.make.build != nil { actions.make.closeBuild() }
                tab = new
            }
        )
    }

    /// M21: a tab's item: the icon with its text, or (with the 4th tab, TabBarRule) the icon alone,
    /// so the four share the bar evenly; the Tab's accessibilityLabel keeps the name for VoiceOver.
    /// The icon-alone item is a Label with empty text, not a bare Image: the 4th tab usually shows
    /// up after launch (the gallery loads), and the system bar keeps a tab's old text when its
    /// label turns into a bare Image, so the first three kept their names (reproduced on the
    /// iOS 26.3 simulator, 2026-11-01). An empty Text clears it; 3 tabs get their text back.
    @ViewBuilder
    private func tabLabel(_ title: Text, systemImage: String, titled: Bool) -> some View {
        if titled {
            Label { title } icon: { Image(systemName: systemImage) }
        } else {
            Label { Text(verbatim: "") } icon: { Image(systemName: systemImage) }
        }
    }

    /// The 4th tab's page is what shows (no Build view over it): no masks, the page's colour.
    private var onPinnedPage: Bool { tab == .pinned && shownBuild == nil }

    /// The 4th tab's page colour while it shows (nil elsewhere, or before the page reported it).
    private var pinnedTint: ViewerChrome? { onPinnedPage ? pinnedChrome : nil }

    /// The page colour behind the status bar has the other look than the system's: the full-screen
    /// viewer's when it's open, else the 4th tab's when nothing covers it.
    private var statusBarClashes: Bool {
        let chrome: ViewerChrome?
        if state.make.viewer != nil {
            chrome = viewerChrome
        } else if state.taskDetail == nil && !menuOpen {
            chrome = pinnedTint
        } else {
            chrome = nil
        }
        guard let chrome else { return false }
        return chrome.scheme != colorScheme
    }

    /// Make's FAB shows: the Make tab, nothing over it.
    private var showsFAB: Bool {
        tab == .make && shownBuild == nil && state.taskDetail == nil && state.make.viewer == nil
    }

    /// M29: how long a finished build's view stays for the mascot's `done` before its viewer slides up.
    static let handoverHold = 0.85

    /// M29: the build that just became ready here: the store opened its viewer, the Build view
    /// stays a moment for the mascot's hop. None with Reduce Motion (no hop to wait for).
    private var handover: String? {
        guard !reduceMotion, state.make.build == nil, let id = watchedBuild, state.make.viewer?.artifactId == id else { return nil }
        return id
    }

    /// The Build view on screen: the store's, or the one handing over.
    private var shownBuild: String? { state.make.build ?? handover }

    /// The fan opens and closes on one spring (FanMotion); the FAB, the dim and the capsules follow.
    private func setFan(_ open: Bool) {
        guard open != fanOpen else { return }
        withAnimation(FanMotion.animation(reduceMotion: reduceMotion)) { fanOpen = open }
    }

    /// The thread is covered by the Build view, the viewer or the fan.
    private var covered: Bool { shownBuild != nil || state.make.viewer != nil || fanOpen }

    /// Artifact id -> type, for inline duet://artifacts/<id> pills.
    private var artifactTypes: [String: ArtifactType] {
        Dictionary(state.make.artifacts.map { ($0.id, $0.type) }, uniquingKeysWith: { first, _ in first })
    }

    private var header: some View {
        VStack(spacing: 0) {
            if shownBuild != nil {
                // M6 (L164): one animating mascot, no ≡ and no initials, ✕ on the right.
                BuildHeader(event: buildDone, onClose: actions.make.closeBuild)
                    .transition(.opacity)
            } else {
                ChatHeader(
                    status: state.status, channel: state.menu.selected, userName: state.userName,
                    unreadChannels: state.unreadChannels,
                    onMenu: openMenu, onAssistant: actions.openAssistant, onProfile: actions.openProfile,
                    onPill: actions.files.openChannelSheet,
                    onRestart: actions.restartOnboarding
                )
                .transition(.opacity)
            }
            if state.connection == .offline {
                OfflineBar()
                    .padding(.top, -Metrics.composerAboveTabBar)
                    .padding(.bottom, 8)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
            }
            // M13: the voice call's bar (it shows itself only while a call is on).
            if let call {
                CallBar(
                    call: call, menu: state.menu, mainChannelId: mainChannelId,
                    topInset: state.connection == .offline ? 0 : -Metrics.composerAboveTabBar,
                    onGoToCall: goToCall
                )
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.4, dampingFraction: 0.85), value: state.connection)
        .animation(.easeInOut(duration: 0.3), value: shownBuild != nil)
    }

    /// "Message OpenDuet" (main), "Message #name" (channel), "Reply to OpenDuet" (task).
    private var placeholder: LocalizedStringResource {
        switch state.thread.context {
        case .main: "Message OpenDuet"
        case .channel(let name): "Message #\(name)"
        case .task: "Reply to OpenDuet"
        }
    }

    // MARK: - Actions

    /// The task actions, remembering which update each row asked for (its Retry repeats it).
    private var taskActions: TaskActions {
        var tasks = actions.tasks
        let base = actions.tasks
        let record = $rowActions
        tasks.markComplete = { id in
            record.wrappedValue[id] = .complete
            base.markComplete(id)
        }
        tasks.archive = { id in
            record.wrappedValue[id] = .archive
            base.archive(id)
        }
        return tasks
    }

    private var shellActions: ShellActions {
        var all = actions
        all.tasks = taskActions
        all.files = channelSheetFileActions
        return all
    }

    /// M26: the channel sheet's Files open a task (a task group's title) or an artifact (its
    /// page) over the shell, so the sheet goes down first and the link opens once it has.
    private var channelSheetFileActions: FileActions {
        var files = actions.files
        files.openLink = { url in
            actions.files.closeChannelSheet()
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(350))
                actions.openRoute(url)
            }
        }
        return files
    }

    private func messageAssistant() {
        tab = .chat
        composerFocused = true
    }

    /// M25: the main thread (Everything) on Chat with `text` in the composer, the cursor at the
    /// end and the keyboard up; nothing is sent. What covers the thread goes first; the focus
    /// comes a beat later, once the composer is on screen again.
    private func composeInMain(_ text: String) {
        if state.make.build != nil { actions.make.closeBuild() }
        if state.make.viewer != nil { actions.make.close() }
        if state.taskDetail != nil { actions.tasks.close() }
        setFan(false)
        menuOpen = false
        searchFocused = false
        composerFocused = false
        selectToken += 1
        tab = .chat
        if state.menu.selectedChannelId != nil { actions.menu.select(nil) }
        draft = SkillCreatePrefill.draft(prefill: text, current: draft)
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(150))
            composerFocused = true
        }
    }

    private func closeDetail() {
        actions.tasks.close()
    }

    // MARK: - Side menu (L123)

    /// ≡: the keyboard goes, the menu slides in and refreshes its channels and unread counts.
    private func openMenu() {
        guard state.taskDetail == nil else { return }
        composerFocused = false
        searchFocused = false
        actions.openMenu()
        actions.menu.refresh()
        menuOpen = true
    }

    private func closeMenu() {
        menuOpen = false
    }

    /// Everything (nil) or a channel: the chat and the Tasks tab follow it; the menu closes.
    /// M19: the menu closes first and the switch happens when its slide is over, so building the
    /// new thread (and the Tasks reload) doesn't land in the slide's frames.
    private func selectChannel(_ id: String?) {
        let select = actions.menu.select
        let changes = id != state.menu.selectedChannelId
        selectToken += 1
        let token = selectToken
        withAnimation(SideMenuMotion.animation(reduceMotion: reduceMotion)) { menuOpen = false } completion: {
            if changes && token == selectToken { select(id) }
        }
    }

    /// M19: the edge pull may open the menu: the Chat tab with nothing over it (task detail,
    /// artifact viewer, Build view, Make's fan). Sheets and covers sit above the shell anyway.
    private var canPullMenu: Bool {
        tab == .chat && !menuOpen && state.taskDetail == nil && state.make.viewer == nil
            && state.make.build == nil && !fanOpen
    }

    // MARK: - Voice call (M13)

    /// The main thread's channel (the menu shows it as Everything).
    private var mainChannelId: String? { state.profile.user?.mainChannelId }

    /// The thread on screen's channel: where the composer's waveform starts a call.
    private var threadChannelId: String? { state.menu.selectedChannelId ?? mainChannelId }

    /// "On a call in #shop": back to the call's thread (Chat, that channel).
    private func goToCall(_ channelId: String) {
        selectToken += 1
        tab = .chat
        let target: String? = channelId == mainChannelId ? nil : channelId
        if target != state.menu.selectedChannelId { actions.menu.select(target) }
    }
}

// The tab bar's tabs and the contract's tabs are the same four (M6: the pinned artifact).
private extension AppTab {
    init(_ tab: ShellTab) {
        switch tab {
        case .chat: self = .chat
        case .tasks: self = .tasks
        case .make: self = .make
        case .pinned: self = .pinned
        }
    }
}

private extension ShellTab {
    init(_ tab: AppTab) {
        switch tab {
        case .chat: self = .chat
        case .tasks: self = .tasks
        case .make: self = .make
        case .pinned: self = .pinned
        }
    }
}
