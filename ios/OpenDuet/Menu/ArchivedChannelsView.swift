// "Archived" in the side menu (prompt L123): pushed over the menu, the archived channels each
// with Unarchive (spinner in flight, the reason + Retry on failure). Loads when it appears;
// skeleton rows while loading, a grey reason + Retry when loading fails, an empty state.
// M9: Unarchive and Delete by swipe and by long-press too; Delete asks in place under the row
// ("Deletes its messages, tasks and files. Creations move to your main chat.").
import SwiftUI

struct ArchivedChannelsView: View {
    var archived: [Channel]?
    var error: String?
    var requests: ShellState.CardRequests
    var onLoad: () -> Void
    var onUnarchive: (String) -> Void
    var onBack: () -> Void
    /// M9: Delete after the in-place confirmation (cardRequests[RequestKey.deleteChannel(id)])
    var onDelete: (String) -> Void = { _ in }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The channel whose Delete question is open under its row.
    @State private var confirming: String?

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Archived"), leading: .back, onLeading: onBack)
            content
                .animation(.easeInOut(duration: 0.25), value: archived?.map(\.id))
                .animation(.easeInOut(duration: 0.2), value: error)
                .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.36, dampingFraction: 0.86), value: confirming)
        }
        .onAppear(perform: onLoad)
        .onChange(of: archived?.map(\.id)) { _, ids in
            if let confirming, !(ids ?? []).contains(confirming) { self.confirming = nil }
        }
    }

    @ViewBuilder private var content: some View {
        if let archived, !archived.isEmpty {
            // A List for the swipe actions, drawn like the card section it was.
            List {
                if let error {
                    InlineFailure(reason: error, onRetry: onLoad)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 8, trailing: 4))
                        .listRowSeparator(.hidden)
                }
                Section {
                    ForEach(archived) { channel in
                        ArchivedChannelRow(
                            channel: channel,
                            request: requests[ShellState.RequestKey.archive(channel.id)],
                            deleteRequest: requests[ShellState.RequestKey.deleteChannel(channel.id)],
                            confirming: confirming == channel.id,
                            onUnarchive: { onUnarchive(channel.id) },
                            onAskDelete: { confirming = channel.id },
                            onCancelDelete: { confirming = nil },
                            onDelete: { onDelete(channel.id) }
                        )
                        .listRowBackground(Palette.cardSurface)
                        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                        .listRowSeparatorTint(Palette.cardBorder)
                        .alignmentGuide(.listRowSeparatorLeading) { _ in 16 + MenuRowMetrics.branchIcon + 12 }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button { confirming = channel.id } label: {
                                Label { Text("Delete") } icon: { Image(systemName: DuetGlyph.delete.symbol) }
                            }
                            .tint(Palette.destructive)
                            Button { onUnarchive(channel.id) } label: {
                                Label { Text("Unarchive") } icon: { Image(systemName: DuetGlyph.tray.symbol) }
                            }
                            .tint(Palette.accent)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(0)
            .scrollContentBackground(.hidden)
            .scrollIndicators(.hidden)
            .contentMargins(.top, 8, for: .scrollContent)
            .contentMargins(.horizontal, 16, for: .scrollContent)
            .environment(\.defaultMinListRowHeight, 1)
        } else {
            ScrollView {
                Group {
                    if let archived {
                        VStack(alignment: .leading, spacing: 12) {
                            if let error {
                                InlineFailure(reason: error, onRetry: onLoad)
                            }
                            if archived.isEmpty {
                                EmptyStateView(systemImage: DuetGlyph.archive.symbol, message: "Channels you archive show up here.")
                                    .frame(minHeight: 280)
                            }
                        }
                    } else if let error {
                        InlineRetryLine(reason: error, onRetry: onLoad)
                    } else {
                        skeleton
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
        }
    }

    private var skeleton: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(0..<3, id: \.self) { index in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(Palette.skeleton)
                        .frame(width: MenuRowMetrics.branchIcon, height: MenuRowMetrics.branchIcon)
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton)
                            .frame(width: CGFloat(index % 2 == 0 ? 140 : 110), height: 14)
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton)
                            .frame(width: CGFloat(index % 2 == 0 ? 190 : 160), height: 10)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading archived channels"))
    }
}

/// One archived channel: icon, name and purpose, Unarchive; long-press Unarchive / Delete; the
/// Delete question in place under it.
private struct ArchivedChannelRow: View {
    var channel: Channel
    var request: CardRequest?
    var deleteRequest: CardRequest?
    var confirming: Bool
    var onUnarchive: () -> Void
    var onAskDelete: () -> Void
    var onCancelDelete: () -> Void
    var onDelete: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var nameSize: CGFloat = 16
    @ScaledMetric(relativeTo: .footnote) private var purposeSize: CGFloat = 13

    private var busy: Bool { request == .inFlight || deleteRequest == .inFlight }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                ChannelGlyph(icon: channel.icon, color: channel.colorHex, size: MenuRowMetrics.branchIcon)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: channel.name)
                        .font(.system(size: nameSize, weight: .medium))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(1)
                    if !channel.purpose.isEmpty {
                        Text(verbatim: channel.purpose)
                            .font(.system(size: purposeSize))
                            .foregroundStyle(Palette.secondaryText)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                CapsuleButton(title: Text("Unarchive"), style: .outline, busy: request == .inFlight, fullWidth: false, action: onUnarchive)
                    .disabled(busy)
                    .accessibilityLabel(Text("Unarchive \(channel.name)"))
            }
            .contentShape(Rectangle())
            .cleanContextPreview(corner: 12)
            .contextMenu {
                Button(action: onUnarchive) {
                    Label { Text("Unarchive") } icon: { Image(systemName: DuetGlyph.tray.symbol) }
                }
                .disabled(busy)
                Divider()
                Button(role: .destructive, action: onAskDelete) {
                    Label { Text("Delete") } icon: { Image(systemName: DuetGlyph.delete.symbol) }
                }
                .disabled(busy)
            }
            .accessibilityAction(named: Text("Delete"), onAskDelete)
            if case .failed(let reason) = request {
                InlineFailure(reason: reason, onRetry: onUnarchive)
                    .padding(.leading, MenuRowMetrics.branchIcon + 12)
                    .transition(.opacity)
            }
            if confirming || deleteRequest == .inFlight {
                DeleteConfirmStrip(
                    question: Text("Delete #\(channel.name)? Deletes its messages, tasks and files. Creations move to your main chat."),
                    busy: deleteRequest == .inFlight, failure: deleteRequest?.failureReason,
                    onConfirm: onDelete,
                    onCancel: onCancelDelete
                )
                .padding(.top, 4)
                .transition(.confirmReveal(reduceMotion: reduceMotion))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .opacity(deleteRequest == .inFlight ? 0.7 : 1)
        .animation(.easeInOut(duration: 0.2), value: request)
        .sensoryFeedback(.warning, trigger: request) { _, new in new?.failureReason != nil }
    }
}
