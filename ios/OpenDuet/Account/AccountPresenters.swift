// The store-driven M4 sheets (AccountContract: `presented`, `connectorDetail`). The assistant,
// profile and Usage sheets follow ShellState.presented: a swipe down or ✕ calls account.dismiss.
// M11: the OpenDuet sheet follows the thread on screen (AssistantSheetRoute): Everything's sheet on
// the main thread, the channel's own sheet in a channel. M16: the profile sheet is the settings;
// "Set up models" and a call's "Set up" open it at Models / Voice.
// The connector detail follows ShellState.connectorDetail and stacks on whichever of those is
// up (or on the shell when none is): closing it calls connectors.closeDetail.
import SwiftUI

extension ShellPresentation: Identifiable {
    var id: Self { self }
}

/// Mirrors a store value into the sheet's item and reports a user dismissal back.
struct PresentedSheetModifier: ViewModifier {
    var state: ShellState
    var actions: ShellActions

    @State private var shown: ShellPresentation?
    /// M19: the settings' own models, kept between presentations (ProfileSheetCache); a new
    /// signed-in client starts them over.
    @State private var profileCache = ProfileSheetCache()
    @Environment(\.apiClient) private var api

    func body(content: Content) -> some View {
        content
            .onChange(of: api.map(ObjectIdentifier.init)) { _, _ in profileCache = ProfileSheetCache() }
            .onChange(of: state.presented, initial: true) { _, new in
                if shown != new { shown = new }
            }
            .onChange(of: shown) { _, new in
                // The user swiped the sheet away (or ✕): tell the store, and close a detail
                // stacked on it too so it doesn't reappear over the shell.
                guard new == nil, state.presented != nil else { return }
                if state.connectorDetail != nil { actions.connectors.closeDetail() }
                actions.account.dismiss()
            }
            .sheet(item: $shown) { sheet in
                PresentedSheet(sheet: sheet, state: state, actions: actions, profileCache: profileCache)
                    .connectorDetailSheet(state: state, actions: actions, active: true)
                    .duetSheetChrome()
                    .presentationDetents([.large])
            }
    }
}

/// The OpenDuet sheet, the profile sheet or the Usage screen on its own.
struct PresentedSheet: View {
    var sheet: ShellPresentation
    var state: ShellState
    var actions: ShellActions
    var profileCache: ProfileSheetCache

    /// M16 "Open profile": the OpenDuet sheet goes down first and the profile comes up after it,
    /// so one sheet never replaces the other in place (a swap could read as a swipe-down).
    private func openProfileFromAssistant() {
        actions.account.dismiss()
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(450))
            actions.openProfile()
        }
    }

    var body: some View {
        switch sheet {
        case .assistant:
            // M11: the mascot opens the sheet of the thread on screen (Settings/, iOS B).
            switch AssistantSheetRoute(menu: state.menu) {
            case .everything:
                EverythingSheet(actions: actions.connectors, onOpenSettings: openProfileFromAssistant, onClose: actions.account.dismiss)
            case .channel(let channel):
                ChannelAssistantSheet(channel: channel, assistant: state.assistant, requests: state.cardRequests, actions: actions.connectors, onClose: actions.account.dismiss)
                    // A different channel starts the page over (its own memory, access, soul addendum).
                    .id(channel.id)
            }
        case .profile:
            profile(initialPage: nil)
        case .usage:
            UsageView(
                screen: state.usageScreen, leading: .close, onLeading: actions.account.dismiss,
                onLoad: actions.account.loadUsageStats
            )
        case .models:
            // M12: "Set up" / "Set up models": the settings at their Models page (Back shows the rest).
            profile(initialPage: .models)
        case .voice:
            // M16: a voice call's "Set up": the settings at their Voice page.
            profile(initialPage: .voice)
        }
    }

    /// M19: the settings get their slices of the state and skip redraws while those are equal.
    private func profile(initialPage: ProfileSheet.Page?) -> some View {
        ProfileSheet(
            state: ProfileSheetState(state), actions: actions, initialPage: initialPage,
            cache: profileCache, onClose: actions.account.dismiss
        )
        .equatable()
    }
}

/// The connector detail sheet for one presenter: inside a presented sheet (`active` true) or on
/// the shell while no sheet is up.
struct ConnectorDetailSheetModifier: ViewModifier {
    var state: ShellState
    var actions: ShellActions
    var active: Bool

    struct Item: Identifiable, Hashable {
        var toolkit: String
        var id: String { toolkit }
    }

    @State private var shown: Item?

    private var source: Item? {
        guard active, let toolkit = state.connectorDetail?.toolkit else { return nil }
        return Item(toolkit: toolkit)
    }

    func body(content: Content) -> some View {
        content
            .onChange(of: source, initial: true) { _, new in
                if shown != new { shown = new }
            }
            .onChange(of: shown) { _, new in
                guard new == nil, source != nil else { return }
                actions.connectors.closeDetail()
            }
            .sheet(item: $shown) { _ in
                if let detail = state.connectorDetail {
                    ConnectorDetailSheet(detail: detail, requests: state.cardRequests, actions: actions.connectors)
                        .duetSheetChrome()
                        .presentationDetents([.large])
                }
            }
    }
}

extension View {
    /// The assistant / profile / Usage sheets that follow ShellState.presented.
    func presentedSheets(state: ShellState, actions: ShellActions) -> some View {
        modifier(PresentedSheetModifier(state: state, actions: actions))
    }

    func connectorDetailSheet(state: ShellState, actions: ShellActions, active: Bool) -> some View {
        modifier(ConnectorDetailSheetModifier(state: state, actions: actions, active: active))
    }
}
