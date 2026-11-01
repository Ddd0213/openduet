// A channel under "Everything" in the side menu (prompt L123): the grey tree connector, the
// tinted icon, the name and the truncated purpose, the selected channel in a grey pill, an
// unread count, and Archive on long-press (spinner while archiving, the reason + Retry on failure).
// M9: the long-press also offers Edit, Mark as read and Delete (asks in place under the row).
import SwiftUI

/// Where the rows of the tree sit, shared by Everything, the channels and "+ New channel".
enum MenuRowMetrics {
    /// Inner padding of a row's pill.
    static let inset: CGFloat = 8
    /// The trunk runs under the centre of the Everything icon.
    static let trunkX: CGFloat = inset + Metrics.menuIcon / 2
    /// The branch column: channel pills start here.
    static let branchWidth: CGFloat = 40
    static let branchIcon: CGFloat = 26
    static let pillCorner: CGFloat = 12
}

/// One row's grey lines: ├ or └ from the trunk to the row's pill (MenuTree.lines).
struct TreeConnector: Shape {
    var connector: MenuTree.Connector
    var trunkX: CGFloat = MenuRowMetrics.trunkX

    func path(in rect: CGRect) -> Path {
        let lines = MenuTree.lines(connector, height: rect.height, trunkX: trunkX, branchToX: rect.width)
        var path = Path()
        path.move(to: CGPoint(x: lines.trunkX, y: lines.trunkFromY))
        if lines.cornerRadius > 0 {
            path.addLine(to: CGPoint(x: lines.trunkX, y: lines.branchY - lines.cornerRadius))
            path.addQuadCurve(
                to: CGPoint(x: lines.trunkX + lines.cornerRadius, y: lines.branchY),
                control: CGPoint(x: lines.trunkX, y: lines.branchY)
            )
        } else {
            path.addLine(to: CGPoint(x: lines.trunkX, y: lines.trunkToY))
            path.move(to: CGPoint(x: lines.trunkX, y: lines.branchY))
        }
        path.addLine(to: CGPoint(x: lines.branchToX, y: lines.branchY))
        return path
    }
}

/// The trunk carrying on past a row's extra content (a failure line under a ├ row).
struct TrunkLine: Shape {
    var trunkX: CGFloat = MenuRowMetrics.trunkX
    /// Starts this far below the top (under the Everything icon).
    var fromY: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: trunkX, y: rect.minY + fromY))
        path.addLine(to: CGPoint(x: trunkX, y: rect.maxY))
        return path
    }
}

extension Shape {
    /// The menu tree's grey hairline.
    func treeStroke() -> some View {
        stroke(Palette.treeLine, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
    }
}

/// M9: what a channel row's long-press needs besides Archive: its Mark as read and Delete
/// states (cardRequests[RequestKey.markRead(id)] / [RequestKey.deleteChannel(id)]) and the
/// Edit / Mark as read / Delete taps. nil = Archive only (previews).
struct MenuChannelRowMenu {
    var markReadRequest: CardRequest?
    var deleteRequest: CardRequest?
    var onEdit: () -> Void
    var onMarkRead: () -> Void
    var onDelete: () -> Void
}

struct MenuChannelRow: View {
    var channel: Channel
    var connector: MenuTree.Connector
    var selected: Bool
    /// cardRequests[RequestKey.archive(id)]
    var request: CardRequest?
    var onSelect: () -> Void
    var onArchive: () -> Void
    var menu: MenuChannelRowMenu? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var confirmingDelete = false
    @ScaledMetric(relativeTo: .body) private var nameSize: CGFloat = 16
    @ScaledMetric(relativeTo: .footnote) private var purposeSize: CGFloat = 13

    private var deleteRequest: CardRequest? { menu?.deleteRequest }
    private var busy: Bool { request == .inFlight || deleteRequest == .inFlight }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            pill
                .padding(.leading, MenuRowMetrics.branchWidth)
                .padding(.vertical, 2)
                .background(alignment: .leading) {
                    TreeConnector(connector: connector).treeStroke().frame(width: MenuRowMetrics.branchWidth)
                }
            if case .failed(let reason) = request {
                under(InlineFailure(reason: reason, onRetry: onArchive))
            }
            if let menu, let reason = menu.markReadRequest?.failureReason {
                under(InlineFailure(reason: reason, onRetry: menu.onMarkRead))
            }
            if let menu, confirmingDelete || deleteRequest == .inFlight {
                under(
                    DeleteConfirmStrip(
                        question: Text("Delete #\(channel.name)? Deletes its messages, tasks and files. Creations move to your main chat."),
                        busy: deleteRequest == .inFlight, failure: deleteRequest?.failureReason, compact: true,
                        onConfirm: menu.onDelete,
                        onCancel: { confirmingDelete = false }
                    ),
                    transition: .confirmReveal(reduceMotion: reduceMotion)
                )
            }
        }
        .animation(.easeInOut(duration: 0.2), value: request)
        .animation(.easeInOut(duration: 0.2), value: menu?.markReadRequest)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.36, dampingFraction: 0.86), value: confirmingDelete)
        .sensoryFeedback(.warning, trigger: request) { _, new in new?.failureReason != nil }
        .sensoryFeedback(.warning, trigger: menu?.markReadRequest) { _, new in new?.failureReason != nil }
    }

    /// A line under the row's pill; the trunk carries on past it under a ├ row.
    private func under<Content: View>(_ content: Content, transition: AnyTransition = .opacity) -> some View {
        content
            .padding(.leading, MenuRowMetrics.branchWidth + MenuRowMetrics.inset)
            .padding(.bottom, 6)
            .background(alignment: .leading) {
                if connector == .tee { TrunkLine().treeStroke().frame(width: MenuRowMetrics.branchWidth) }
            }
            .transition(transition)
    }

    private var pill: some View {
        Button(action: onSelect) {
            HStack(spacing: 10) {
                ChannelGlyph(icon: channel.icon, color: channel.colorHex, size: MenuRowMetrics.branchIcon)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: channel.name)
                        .font(.system(size: nameSize, weight: selected ? .semibold : .medium))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(1)
                    if !channel.purpose.isEmpty {
                        Text(verbatim: channel.purpose)
                            .font(.system(size: purposeSize))
                            .foregroundStyle(Palette.secondaryText)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                Spacer(minLength: 4)
                if busy {
                    ProgressView().controlSize(.small).transition(.opacity)
                } else if unread > 0 {
                    CountBadge(count: unread).transition(.scale.combined(with: .opacity))
                }
            }
            .padding(.horizontal, MenuRowMetrics.inset)
            .padding(.vertical, 8)
            .background {
                RoundedRectangle(cornerRadius: MenuRowMetrics.pillCorner, style: .continuous)
                    .fill(selected ? Palette.menuSelection : .clear)
            }
            .contentShape(RoundedRectangle(cornerRadius: MenuRowMetrics.pillCorner, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .disabled(busy)
        .cleanContextPreview(corner: MenuRowMetrics.pillCorner)
        .contextMenu { menuItems }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityValue(unread > 0 ? Text("\(unread) unread") : Text(verbatim: ""))
        .modifier(ChannelRowAccessibility(menu: menu, unread: unread, onArchive: onArchive) { confirmingDelete = true })
    }

    /// M21: the selected row (the channel on screen) shows no count, like the ≡ badge.
    private var unread: Int { ChannelMenu.shownUnread(channel, selected: selected) }

    /// Edit, Mark as read (only with unread messages), Archive, Delete (asks under the row).
    @ViewBuilder private var menuItems: some View {
        if let menu {
            Button(action: menu.onEdit) {
                Label { Text("Edit") } icon: { Image(systemName: DuetGlyph.edit.symbol) }
            }
            Button(action: menu.onMarkRead) {
                Label { Text("Mark as read") } icon: { Image(systemName: DuetGlyph.check.symbol) }
            }
            .disabled(unread == 0 || menu.markReadRequest == .inFlight)
        }
        Button(action: onArchive) {
            Label { Text("Archive") } icon: { Image(systemName: DuetGlyph.archive.symbol) }
        }
        if menu != nil {
            Divider()
            Button(role: .destructive) { confirmingDelete = true } label: {
                Label { Text("Delete") } icon: { Image(systemName: DuetGlyph.delete.symbol) }
            }
        }
    }
}

/// The row's long-press items as VoiceOver actions.
private struct ChannelRowAccessibility: ViewModifier {
    var menu: MenuChannelRowMenu?
    var unread: Int
    var onArchive: () -> Void
    var onConfirmDelete: () -> Void

    func body(content: Content) -> some View {
        if let menu {
            content
                .accessibilityAction(named: Text("Edit"), menu.onEdit)
                .accessibilityAction(named: Text("Mark as read")) { if unread > 0 { menu.onMarkRead() } }
                .accessibilityAction(named: Text("Archive"), onArchive)
                .accessibilityAction(named: Text("Delete"), onConfirmDelete)
        } else {
            content.accessibilityAction(named: Text("Archive"), onArchive)
        }
    }
}

/// "+ New channel": the last branch of the tree.
struct NewChannelBranchRow: View {
    var action: () -> Void

    @ScaledMetric(relativeTo: .body) private var nameSize: CGFloat = 16

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                DuetIcon(glyph: .add, size: 15, tint: Palette.secondaryText)
                    .frame(width: MenuRowMetrics.branchIcon, height: MenuRowMetrics.branchIcon)
                    .background(
                        RoundedRectangle(cornerRadius: MenuRowMetrics.branchIcon * 0.28, style: .continuous)
                            .strokeBorder(Palette.dashedRing, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    )
                    .accessibilityHidden(true)
                Text("New channel")
                    .font(.system(size: nameSize, weight: .medium))
                    .foregroundStyle(Palette.primaryText)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, MenuRowMetrics.inset)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .padding(.leading, MenuRowMetrics.branchWidth)
        .padding(.vertical, 2)
        .background(alignment: .leading) {
            TreeConnector(connector: .elbow).treeStroke().frame(width: MenuRowMetrics.branchWidth)
        }
    }
}
