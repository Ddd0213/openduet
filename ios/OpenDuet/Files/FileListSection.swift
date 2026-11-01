// The Files lists (PART C, L180): a channel's files in its sheet and every file in profile >
// Files, newest first (FileRow). Skeleton rows on the first load, a grey reason + Retry when it
// fails, a short empty line when there are none. Tapping a row opens the full-screen preview.
// M9: long-press a row for Open, Share, Copy name and Delete (FileRow).
// M26: the rows sit in groups by where they came from (FileGroups): the assistant sent you, You
// uploaded, Screenshots, one card per task (folded until its chevron is tapped; the expanded ones
// stay open while the list is on screen; the title opens the task), Other. An artifact's page
// opens the artifact. A delete that found the original gone already leaves a note under the list.
import SwiftUI

/// Skeleton rows shaped like file rows while the first load runs.
struct FileRowsSkeleton: View {
    var rows = 4

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<rows, id: \.self) { index in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Palette.skeleton)
                        .frame(width: 32, height: 32)
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton)
                            .frame(width: CGFloat(index % 2 == 0 ? 150 : 110), height: 13)
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton)
                            .frame(width: CGFloat(index % 2 == 0 ? 100 : 80), height: 10)
                    }
                    Spacer()
                }
                .padding(.horizontal, 16)
                .frame(minHeight: Metrics.sheetRowMinHeight + 4)
            }
        }
        .cardSurface()
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading files"))
    }
}

/// A file list in its loading, failed, empty and loaded states.
struct FileListSection: View {
    var list: FileListState
    var empty: LocalizedStringKey
    var onOpen: (ChannelFile) -> Void
    var onRetry: () -> Void
    /// M9: long-press Delete after the in-place confirmation (FileActions.delete). M26: with the
    /// "Also delete from OpenDuet's computer" switch.
    var onDelete: ((_ file: ChannelFile, _ alsoWorkspace: Bool) -> Void)? = nil
    /// M26: a task group's title and an artifact's page (FileActions.openLink)
    var onOpenLink: (URL) -> Void = { _ in }

    /// M26: the task groups unfolded while this list is on screen
    @State private var expanded: Set<String> = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let dividerInset: CGFloat = 16 + 32 + 12

    var body: some View {
        Group {
            switch list.phase {
            case .loading where list.files.isEmpty:
                FileRowsSkeleton()
            case .failed(let reason) where list.files.isEmpty:
                InlineRetryLine(reason: reason, onRetry: onRetry)
                    .cardSurface()
            default:
                if list.files.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        EmptyStateView(systemImage: DuetGlyph.copy.symbol, message: empty)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 24)
                        if list.workspaceGoneAt != nil { WorkspaceGoneNote().transition(.opacity) }
                    }
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        VStack(alignment: .leading, spacing: 20) {
                            ForEach(FileGroups.groups(list.files)) { group in
                                section(group)
                            }
                        }
                        if list.workspaceGoneAt != nil { WorkspaceGoneNote().transition(.opacity) }
                        if case .failed(let reason) = list.phase {
                            InlineFailure(reason: reason) { onRetry() }
                                .padding(.horizontal, 6)
                        }
                    }
                }
            }
        }
        .animation(.easeInOut(duration: 0.25), value: list.phase)
        .animation(.easeInOut(duration: 0.25), value: list.files.map(\.id))
        .animation(.easeInOut(duration: 0.25), value: list.workspaceGoneAt)
    }

    @ViewBuilder private func section(_ group: FileGroup) -> some View {
        if case .task(_, let title) = group.kind {
            taskCard(group, title: title)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                SheetSectionTitle(text: Self.title(group.kind))
                CardSection(dividerInset: Self.dividerInset) {
                    ForEach(group.files) { file in
                        row(file, taskTitle: FileGroups.taskLine(file))
                    }
                }
            }
        }
    }

    /// A task's working files: one card, its header row first, the rows below once unfolded.
    private func taskCard(_ group: FileGroup, title: String?) -> some View {
        let open = expanded.contains(group.id)
        return CardSection(dividerInset: Self.dividerInset) {
            FileTaskGroupHeader(
                title: title, count: group.files.count, expanded: open,
                onOpenTask: group.taskLink.map { url in { onOpenLink(url) } },
                onToggle: { toggle(group.id) }
            )
            if open {
                ForEach(group.files) { file in
                    row(file, taskTitle: nil)
                        .transition(.opacity)
                }
            }
        }
    }

    private func row(_ file: ChannelFile, taskTitle: String?) -> some View {
        let artifact = FileGroups.artifactLink(file)
        return FileRow(
            file: file, deleteRequest: list.deleting[file.id], taskTitle: taskTitle,
            opensArtifact: artifact != nil,
            onOpen: {
                if let artifact { onOpenLink(artifact) } else { onOpen(file) }
            },
            onDelete: onDelete.map { delete in { alsoWorkspace in delete(file, alsoWorkspace) } }
        )
    }

    private func toggle(_ id: String) {
        withAnimation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.36, dampingFraction: 0.86)) {
            if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
        }
    }

    /// The small grey title over a group's card (task groups carry theirs in the card).
    private static func title(_ kind: FileGroup.Kind) -> Text {
        switch kind {
        case .sent: return Text("OpenDuet sent you")
        case .uploaded: return Text("You uploaded")
        case .screenshots: return Text("Screenshots")
        case .other: return Text("Other")
        case .task(_, let title?): return Text(verbatim: title)
        case .task: return Text("Deleted task")
        }
    }
}
