// M11: the main thread's OpenDuet sheet. Under the mascot and "OpenDuet": Who OpenDuet is (the soul),
// About you (shared memory), the assistant's computer, the channels (each one's memory read-only) and
// Activity. M16: what the user sets up (models, voice, apps and connectors, skills) moved to the
// settings, the profile sheet; the last line opens it. Loads its own data through `\.apiClient`
// when it appears; every page is one push deep (the computer's detail is a sheet). M21: the
// content is held to the sheet's width (it could be dragged sideways).
import OSLog
import SwiftUI

struct EverythingSheet: View {
    var actions: ConnectorActions
    /// M16: "Open profile" (the settings)
    var onOpenSettings: () -> Void = {}
    var onClose: () -> Void

    enum Page: Hashable {
        case soul, aboutYou, channel(String)
        case activity, run(String)
    }

    @Environment(\.apiClient) private var api
    @State private var model: EverythingModel
    @State private var page: Page?

    init(actions: ConnectorActions, onOpenSettings: @escaping () -> Void = {}, onClose: @escaping () -> Void) {
        self.actions = actions
        self.onOpenSettings = onOpenSettings
        self.onClose = onClose
        _model = State(initialValue: EverythingModel())
    }

    var body: some View {
        PushContainer(page: $page) {
            root
        } destination: { page in
            destination(page)
        }
        // The assistant's computer row reads the connectors' state (its detail opens through them).
        .onAppear(perform: actions.refresh)
        .task {
            model.attach(api)
            await model.refreshAssistant()
        }
    }

    private var root: some View {
        VStack(spacing: 0) {
            SheetHeader(title: nil, leading: .close, onLeading: onClose)
            ScrollView {
                // M21 (the sheet could be dragged sideways and sat ~70 pt to the right on the
                // phone): leading-aligned blocks, each as wide as the sheet; the content is held
                // to the scroll view's width, so a block that wants more can't widen it.
                VStack(alignment: .leading, spacing: 24) {
                    SettingsHero(title: Text(verbatim: "OpenDuet"))
                        .frame(maxWidth: .infinity)
                        .debugWidth("hero")
                    EverythingAboutSection(model: model, onOpen: { page = $0 })
                        .debugWidth("about")
                    // The assistant's own browser stays here: it belongs to the assistant (you can take it over),
                    // it isn't something you set up (decided by the user, M16).
                    CardSection(dividerInset: 16 + 32 + 12) {
                        // M21: its state is one line (a long domain is cut, not wrapped wide).
                        ComputerAccessRow { actions.openDetail(ComputerToolkit.slug) }
                            .lineLimit(1)
                    }
                    .debugWidth("computer")
                    EverythingChannelsSection(model: model, onOpen: { page = .channel($0) })
                        .debugWidth("channels")
                    RunsActivitySection(onOpenRun: { page = .run($0) }, onSeeAll: { page = .activity })
                        .debugWidth("activity")
                    SettingsHintLine(onOpen: onOpenSettings)
                        .debugWidth("hint")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
                .containerRelativeFrame(.horizontal)
            }
            .scrollIndicators(.hidden)
            .refreshable { await model.refreshAssistant() }
        }
    }

    @ViewBuilder private func destination(_ page: Page) -> some View {
        let back = { self.page = nil }
        switch page {
        case .soul:
            // M22: "Set up in chat" closes the sheet and opens the main thread.
            SoulPage(model: model, onBack: back, onOpenChat: openChannel)
        case .aboutYou:
            MemoryPage(
                model: model.aboutYou, title: Text("About you"),
                intro: Text("What OpenDuet knows about you in every channel that uses About you. Edit anything that's wrong or out of date."),
                onBack: back
            )
        case .channel(let id):
            ChannelMemoryReadPage(row: model.overview.value?.first { $0.id == id }, channelId: id, onOpen: openChannel, onBack: back)
        case .activity:
            RunsListPage(scope: .all, title: Text("Activity"), leading: .back, onLeading: back)
        case .run(let runId):
            RunDetailPage(runId: runId, leading: .back, onLeading: back)
        }
    }

    /// "Open channel": the sheet closes, then the chat switches to that channel's thread (after
    /// the dismissal has started, so the sheet doesn't redraw for the new channel on its way out).
    private func openChannel(_ url: URL) {
        onClose()
        Task {
            try? await Task.sleep(for: .milliseconds(350))
            NotificationsCoordinator.shared.open(url)
        }
    }
}

#if DEBUG
extension EverythingSheet {
    /// Previews: a model with fixed state and no API client.
    init(preview model: EverythingModel) {
        self.init(actions: ConnectorActions(), onClose: {})
        _model = State(initialValue: model)
    }
}

/// M21: debug builds log each block's width (Console, category "everything"), to find the one that
/// was wider than the sheet on the phone.
private let everythingLog = Logger(subsystem: "dev.openduet.OpenDuet", category: "everything")

private extension View {
    func debugWidth(_ name: String) -> some View {
        onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            everythingLog.debug("everything block \(name, privacy: .public) width=\(Int(width.rounded()), privacy: .public)")
        }
    }
}
#else
private extension View {
    func debugWidth(_ name: String) -> some View { self }
}
#endif
