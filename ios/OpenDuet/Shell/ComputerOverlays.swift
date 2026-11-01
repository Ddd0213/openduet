// M6 (iOS 1, owned by the iOS-1 agent): what the assistant's computer and files put over the shell:
// the full-screen "OpenDuet's computer" view (ShellState.computer.isOpen), the full-screen file
// preview (ShellState.files.preview) and the channel sheet (ShellState.files.channelSheet).
// MainShellView applies this once at its root, after the other sheets, so the environment it
// sets (the computer's state and actions) reaches the OpenDuet sheet and connector detail too.
import SwiftUI

extension View {
    func computerOverlays(state: ShellState, actions: ShellActions) -> some View {
        modifier(ComputerOverlays(state: state, actions: actions))
    }
}

private struct ComputerOverlays: ViewModifier {
    var state: ShellState
    var actions: ShellActions

    /// One link per live screen, so readers deep in sheets don't refresh on every shell change.
    @State private var link: ComputerLink?
    /// M20: opens the computer detail (the OpenDuet sheet row's action) for Make's Describe sheet.
    @State private var detailLink: ComputerDetailLink?
    /// The last channel sheet shown, so it keeps its content while it slides away.
    @State private var channelSheet: ChannelSheetState?

    private var screenID: ObjectIdentifier? { actions.computer.screen.map(ObjectIdentifier.init) }

    private var liveChannelSheet: ChannelSheetState? {
        guard var sheet = state.files.channelSheet else { return nil }
        // The channel as it is now (a rename or new purpose shows at once).
        if let channel = state.menu.channels.first(where: { $0.id == sheet.channelId }) {
            sheet.channel = channel
        }
        return sheet
    }

    private func makeDetailLink() -> ComputerDetailLink {
        let open = actions.connectors.openDetail
        return ComputerDetailLink { open(ComputerToolkit.slug) }
    }

    func body(content: Content) -> some View {
        content
            // M20: every way this cover closes (✕, swipe down and Escape in ComputerScreen, which
            // call onClose; a system dismissal through this binding) ends in the store's
            // closeComputer(), which hands back to the assistant when the user was in control.
            .fullScreenCover(isPresented: Binding(
                get: { state.computer.isOpen },
                set: { open in if !open, state.computer.isOpen { actions.computer.close() } }
            )) {
                ComputerScreen(
                    view: state.computer, status: state.status, actions: actions.computer,
                    onClose: actions.computer.close
                )
            }
            .sheet(isPresented: Binding(
                get: { state.files.channelSheet != nil },
                set: { shown in if !shown, state.files.channelSheet != nil { actions.files.closeChannelSheet() } }
            )) {
                if let sheet = liveChannelSheet ?? channelSheet {
                    ChannelSheet(sheet: sheet, actions: actions.files)
                        .filePreviewHost(preview: state.files.preview, active: true, actions: actions.files)
                        .duetSheetChrome()
                }
            }
            .filePreviewHost(
                preview: state.files.preview,
                active: state.presented == nil && state.files.channelSheet == nil && state.connectorDetail == nil,
                actions: actions.files
            )
            .onChange(of: liveChannelSheet, initial: true) { _, sheet in
                if let sheet { channelSheet = sheet }
            }
            .onChange(of: screenID, initial: true) { _, _ in
                link = ComputerLink(actions: actions.computer)
                detailLink = makeDetailLink()
            }
            .environment(\.computerScene, ComputerScene(view: state.computer, status: state.status))
            .environment(\.computerLink, link ?? ComputerLink(actions: actions.computer))
            .environment(\.computerDetailLink, detailLink ?? makeDetailLink())
    }
}
