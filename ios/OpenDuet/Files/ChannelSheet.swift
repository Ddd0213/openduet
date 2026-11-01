// The channel sheet (PART C, L180): tapping a channel's header pill. The channel's glyph, name
// and purpose, then its files, newest first. Tapping a file opens the full-screen preview over
// the sheet. The profile's Files page (FilesPage) lists the main thread's files the same way.
// M9: long-press a file for Open, Share, Copy name and Delete. M26: the files sit in groups by
// origin (FileListSection), so "Files" is a heading over their small grey titles; a task group's
// title and an artifact's page open through `actions.openLink` (the sheet closes first).
import SwiftUI

struct ChannelSheet: View {
    var sheet: ChannelSheetState
    var actions: FileActions

    @ScaledMetric(relativeTo: .title) private var nameSize: CGFloat = 26
    @ScaledMetric(relativeTo: .subheadline) private var purposeSize: CGFloat = 15
    @ScaledMetric(relativeTo: .headline) private var sectionSize: CGFloat = 17

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: nil, leading: .close, onLeading: actions.closeChannelSheet)
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let channel = sheet.channel {
                        header(channel)
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        // The task detail's section heading (the groups below have the grey titles).
                        Text("Files")
                            .font(.system(size: sectionSize, weight: .semibold))
                            .foregroundStyle(Palette.primaryText)
                            .padding(.horizontal, 6)
                            .accessibilityAddTraits(.isHeader)
                        FileListSection(
                            list: sheet.list, empty: "Files you or OpenDuet share in this channel show up here.",
                            onOpen: { actions.open($0.id) }, onRetry: actions.refreshChannelFiles,
                            onDelete: { actions.delete($0.id, $1) }, onOpenLink: actions.openLink
                        )
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            .refreshable { actions.refreshChannelFiles() }
        }
    }

    private func header(_ channel: Channel) -> some View {
        VStack(spacing: 10) {
            ChannelGlyph(icon: channel.icon, color: channel.colorHex, size: 56)
                .accessibilityHidden(true)
            Text(verbatim: "#\(channel.name)")
                .font(Typography.serifTitle(nameSize))
                .foregroundStyle(Palette.primaryText)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            if !channel.purpose.isEmpty {
                Text(verbatim: channel.purpose)
                    .font(.system(size: purposeSize))
                    .foregroundStyle(Palette.secondaryText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity)
    }
}
