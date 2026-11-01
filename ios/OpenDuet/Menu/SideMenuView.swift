// The side menu panel (prompt L123): mascot + "OpenDuet" (22 pt) and a divider; "Everything"
// (the orange stacked-layers tile, "All chat context across every channel") with the channels
// nested under it on grey tree lines; "+ New channel"; then "Archived", which pushes its list.
import SwiftUI

struct SideMenuView: View {
    var menu: MenuState
    var requests: ShellState.CardRequests
    var actions: MenuActions
    /// The user picked Everything (nil) or a channel: the shell selects it and closes the menu.
    var onSelect: (String?) -> Void
    var onNewChannel: () -> Void

    private enum Page: Hashable { case archived }
    @State private var page: Page?
    /// M9: the channel whose Edit sheet is open.
    @State private var editing: Channel?
    /// M19: the user's picks, for the selection haptic (the selection itself changes only once
    /// the menu has closed, MainShellView.selectChannel).
    @State private var picks = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .footnote) private var subtitleSize: CGFloat = 13

    var body: some View {
        PushContainer(page: $page) {
            main
        } destination: { _ in
            ArchivedChannelsView(
                archived: menu.archived, error: menu.archivedError, requests: requests,
                onLoad: actions.loadArchived,
                onUnarchive: { actions.setArchived($0, false) },
                onBack: { page = nil },
                onDelete: { actions.delete($0) }
            )
        }
        .background(Palette.sheetBackground)
        // M9: long-press Edit: the New channel sheet, prefilled; Save = PATCH.
        .sheet(item: $editing) { channel in
            NewChannelSheet(
                request: requests[ShellState.RequestKey.updateChannel(channel.id)],
                onCreate: { name, purpose, icon, color in actions.update(channel.id, name, purpose, icon, color) },
                onCancel: { editing = nil },
                onCreated: { editing = nil },
                editing: channel
            )
            .duetSheetChrome()
            .presentationDetents([.large])
        }
        // The channel went away (deleted or archived elsewhere) while its sheet was open.
        .onChange(of: menu.channels.map(\.id)) { _, ids in
            if let id = editing?.id, !ids.contains(id) { editing = nil }
        }
    }

    private var main: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Palette.hairline)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    everything
                    ForEach(MenuTree.branches(channelIds: menu.channels.map(\.id))) { branch in
                        switch branch.node {
                        case .channel(let id):
                            if let channel = menu.channels.first(where: { $0.id == id }) {
                                MenuChannelRow(
                                    channel: channel, connector: branch.connector,
                                    selected: menu.selectedChannelId == id,
                                    request: requests[ShellState.RequestKey.archive(id)],
                                    onSelect: { pick(id) },
                                    onArchive: { actions.setArchived(id, true) },
                                    menu: MenuChannelRowMenu(
                                        markReadRequest: requests[ShellState.RequestKey.markRead(id)],
                                        deleteRequest: requests[ShellState.RequestKey.deleteChannel(id)],
                                        onEdit: { editing = channel },
                                        onMarkRead: { actions.markRead(id) },
                                        onDelete: { actions.delete(id) }
                                    )
                                )
                                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .leading)))
                            }
                        case .newChannel:
                            NewChannelBranchRow(action: onNewChannel)
                        }
                    }
                    Divider().overlay(Palette.hairline).padding(.vertical, 12)
                    archivedRow
                }
                .padding(.horizontal, 12)
                .padding(.top, 14)
                .padding(.bottom, 32)
                .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.35, dampingFraction: 0.86), value: menu.channels.map(\.id))
            }
            .scrollIndicators(.hidden)
        }
        .sensoryFeedback(.selection, trigger: picks)
    }

    private func pick(_ id: String?) {
        if id != menu.selectedChannelId { picks += 1 }
        onSelect(id)
    }

    private var header: some View {
        HStack(spacing: 10) {
            DuetMascot(pose: .idle, size: 30)
                .frame(width: 40, height: 40)
                .accessibilityHidden(true)
            Text(verbatim: "OpenDuet")
                .font(Typography.serifTitle(22))
                .foregroundStyle(Palette.primaryText)
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 14)
    }

    /// The root of the tree; a short trunk runs from under its tile to the first branch.
    private var everything: some View {
        let selected = MenuTree.everythingSelected(selectedChannelId: menu.selectedChannelId, channelIds: menu.channels.map(\.id))
        return Button { pick(nil) } label: {
            HStack(spacing: 12) {
                EverythingGlyph()
                VStack(alignment: .leading, spacing: 1) {
                    Text("Everything")
                        .font(.system(size: titleSize, weight: .semibold))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(1)
                    Text("All chat context across every channel")
                        .font(.system(size: subtitleSize))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, MenuRowMetrics.inset)
            .padding(.vertical, 9)
            .background {
                RoundedRectangle(cornerRadius: MenuRowMetrics.pillCorner, style: .continuous)
                    .fill(selected ? Palette.menuSelection : .clear)
            }
            .contentShape(RoundedRectangle(cornerRadius: MenuRowMetrics.pillCorner, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .background(alignment: .leading) {
            EverythingTrunk().treeStroke().frame(width: MenuRowMetrics.branchWidth)
        }
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    private var archivedRow: some View {
        Button { page = .archived } label: {
            HStack(spacing: 12) {
                DuetIcon(glyph: .archive, size: 18, tint: Palette.secondaryText)
                    .frame(width: Metrics.menuIcon, height: Metrics.menuIcon)
                Text("Archived")
                    .font(.system(size: titleSize, weight: .medium))
                    .foregroundStyle(Palette.primaryText)
                Spacer(minLength: 0)
                RowChevron()
            }
            .padding(.horizontal, MenuRowMetrics.inset)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
    }
}

/// From the bottom of the Everything tile down to the row's bottom edge.
private struct EverythingTrunk: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: MenuRowMetrics.trunkX, y: rect.midY + Metrics.menuIcon / 2 + 3))
        path.addLine(to: CGPoint(x: MenuRowMetrics.trunkX, y: rect.maxY))
        return path
    }
}
