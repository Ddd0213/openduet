// M11: a channel's OpenDuet sheet. Under the mascot and "#name": the channel's activity, its own
// memory (the same editor as About you, on GET /api/channels/:id/memory), "Use About you" (PATCH
// useSharedMemory), "Here, OpenDuet also…" (PATCH soulExtra), and the skills, connectors and apps
// it can use, each with a switch. The shell gives it `.id(channel.id)`; keep this init.
import SwiftUI

struct ChannelAssistantSheet: View {
    var channel: Channel
    var assistant: AssistantAccessState
    var requests: ShellState.CardRequests
    var actions: ConnectorActions
    var onClose: () -> Void

    private enum Page: Hashable { case memory, soulExtra, activity, run(String) }

    @Environment(\.apiClient) private var api
    @State private var model: ChannelSettingsModel
    @State private var page: Page?

    init(channel: Channel, assistant: AssistantAccessState, requests: ShellState.CardRequests, actions: ConnectorActions, onClose: @escaping () -> Void) {
        self.channel = channel
        self.assistant = assistant
        self.requests = requests
        self.actions = actions
        self.onClose = onClose
        _model = State(initialValue: ChannelSettingsModel(channel: channel))
    }

    var body: some View {
        PushContainer(page: $page) {
            root
        } destination: { page in
            destination(page)
        }
        .task {
            model.attach(api)
            await model.refresh()
        }
        .onChange(of: channel) { _, channel in model.sync(channel) }
    }

    private var root: some View {
        VStack(spacing: 0) {
            SheetHeader(title: nil, leading: .close, onLeading: onClose)
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    SettingsHero(title: Text(verbatim: "#" + channel.name), subtitle: purpose)
                    ChannelActivitySection(channelId: channel.id, onOpenRun: { page = .run($0) }, onSeeAll: { page = .activity })
                    memory
                    // M12: the channel's own model and thinking level (the main thread has none).
                    if !channel.isMain {
                        ChannelModelSection(model: model)
                    }
                    ChannelAccessSections(model: model)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .refreshable { await model.refresh() }
        }
    }

    private var purpose: Text? {
        let text = channel.purpose.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : Text(verbatim: text)
    }

    private var memory: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Memory"))
            CardSection(dividerInset: Metrics.settingsTileInset) {
                SheetRow(
                    title: Text("This channel"), subtitle: memoryLine, action: { page = .memory },
                    leading: { RowSymbol(systemImage: "book.closed", tint: Palette.secondaryText) },
                    trailing: { RowChevron() }
                )
                SettingsToggleRow(
                    title: Text("Use About you"),
                    subtitle: model.useSharedMemory
                        ? Text("OpenDuet also knows what's in About you here.")
                        : Text("OpenDuet only uses this channel's memory here."),
                    on: model.useSharedMemory,
                    busy: model.sharedBusy,
                    failure: model.sharedFailure,
                    onChange: { model.setUseSharedMemory($0) }
                ) {
                    RowSymbol(systemImage: "person.crop.circle", tint: Palette.secondaryText)
                }
                SheetRow(
                    title: Text("Here, OpenDuet also…"), subtitle: soulExtraLine, action: { page = .soulExtra },
                    leading: { RowSymbol(systemImage: "sparkle", tint: Palette.secondaryText) },
                    trailing: { RowChevron() }
                )
            }
        }
    }

    private var memoryLine: Text? {
        guard let state = model.memory.state.value else { return nil }
        switch state.facts.count {
        case 0: return state.document.isEmpty ? Text("Nothing saved yet") : Text("Notes, no facts yet")
        case 1: return Text("1 fact")
        case let count: return Text("\(count) facts")
        }
    }

    private var soulExtraLine: Text {
        let text = model.soulExtra.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? Text("Not set yet") : Text(verbatim: text)
    }

    @ViewBuilder private func destination(_ page: Page) -> some View {
        let back = { self.page = nil }
        switch page {
        case .memory:
            MemoryPage(
                model: model.memory, title: Text(verbatim: "#" + channel.name),
                intro: Text("What OpenDuet keeps for this channel only. Edit anything that's wrong or out of date."),
                onBack: back
            )
        case .soulExtra:
            SoulExtraPage(model: model, channelName: channel.name, onBack: back)
        case .activity:
            RunsListPage(scope: .channel(channel.id), title: Text("Activity"), leading: .back, onLeading: back)
        case .run(let runId):
            RunDetailPage(runId: runId, leading: .back, onLeading: back)
        }
    }
}

#if DEBUG
extension ChannelAssistantSheet {
    /// Previews: a model with fixed state and no API client.
    init(preview model: ChannelSettingsModel, channel: Channel, assistant: AssistantAccessState) {
        self.init(channel: channel, assistant: assistant, requests: [:], actions: ConnectorActions(), onClose: {})
        _model = State(initialValue: model)
    }
}
#endif
