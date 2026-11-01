// One file in a Files list (PART C, L180): the type tile, the name, "size · date" and a ›.
// Tapping opens the full-screen preview. M9: long-press Open, Share, Copy name, Delete; Delete
// asks in place under the row (spinner while it runs, the reason with Retry when it fails).
// M26: a second grey line with the file's path on the assistant's computer (middle-truncated); a `send`
// or `screenshot` made in a task names the task after the date; an artifact's page opens the
// artifact (the list decides, `opensArtifact`; its Delete removes only the chat's copy); the
// question in place is FileDeleteConfirm (the "Also delete from OpenDuet's computer" switch). A
// deleted file (a task's Files from the assistant) is dimmed with "Deleted", no › and no tap.
import CoreTransferable
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct FileRow: View {
    var file: ChannelFile
    /// M9: FileListState.deleting[file.id]
    var deleteRequest: FileDeleteRequest? = nil
    /// M26: FileGroups.taskLine (nil where the list already says the task, or there is none)
    var taskTitle: String? = nil
    /// M26: the row opens an artifact, not the preview (VoiceOver's hint)
    var opensArtifact = false
    var onOpen: () -> Void
    /// M9: Delete after the in-place confirmation (nil: no Delete, e.g. previews). M26: with the
    /// switch's value.
    var onDelete: ((_ alsoWorkspace: Bool) -> Void)? = nil

    @Environment(\.authenticatedLoader) private var loader
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var subtitleSize: CGFloat = 13.5
    @ScaledMetric(relativeTo: .footnote) private var pathSize: CGFloat = 12.5
    @State private var confirmingDelete = false
    @State private var alsoWorkspace = false
    @State private var copies = 0

    private var deleting: Bool { deleteRequest == .inFlight }

    var body: some View {
        if file.isDeleted {
            deletedRow
        } else {
            liveRow
        }
    }

    private var liveRow: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onOpen) {
                label(detail: detail, path: file.workspacePath) {
                    if deleting {
                        ProgressView().controlSize(.small).transition(.opacity)
                    } else {
                        RowChevron()
                    }
                }
            }
            .buttonStyle(RowPressStyle())
            .disabled(deleting)
            .opacity(deleting ? 0.6 : 1)
            .cleanContextPreview(corner: 12)
            .contextMenu { menuItems }
            .accessibilityHint(opensArtifact ? Text("Opens the artifact") : Text("Opens the file"))
            .accessibilityAction(named: Text("Copy name"), copyName)
            .modifier(FileDeleteAccessibility(enabled: onDelete != nil) { askDelete() })
            if let onDelete, confirmingDelete || deleting {
                FileDeleteConfirm(
                    file: file, alsoWorkspace: $alsoWorkspace, busy: deleting, failure: deleteRequest?.failure,
                    onConfirm: onDelete,
                    onCancel: { confirmingDelete = false }
                )
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
                .transition(.confirmReveal(reduceMotion: reduceMotion))
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.36, dampingFraction: 0.86), value: confirmingDelete)
        .animation(.easeInOut(duration: 0.2), value: deleteRequest)
        .sensoryFeedback(.success, trigger: copies)
    }

    /// M26: what a deleted file's card says, in a row (a task's Files from the assistant).
    private var deletedRow: some View {
        label(detail: Text("Deleted"), path: nil) { EmptyView() }
            .opacity(0.55)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("File, \(file.name), deleted"))
    }

    /// SheetRow's look, with the path on its own middle-truncated line.
    private func label<Trailing: View>(detail: Text, path: String?, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: 12) {
            FileGlyphTile(kind: FileKind(mime: file.mime, name: file.name), size: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: file.name)
                    .font(.system(size: titleSize, weight: .medium))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                detail
                    .font(.system(size: subtitleSize))
                    .foregroundStyle(Palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                if let path, !path.isEmpty {
                    Text(verbatim: path)
                        .font(.system(size: pathSize))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minHeight: Metrics.sheetRowMinHeight)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var menuItems: some View {
        Button(action: onOpen) {
            Label { Text("Open") } icon: { Image(systemName: DuetGlyph.forward.symbol) }
        }
        // The bytes come through the signed-in session only once a share target is picked.
        ShareLink(
            item: SharedChannelFile(file: file, loader: loader),
            preview: SharePreview(Text(verbatim: file.name))
        ) {
            Label { Text("Share") } icon: { Image(systemName: DuetGlyph.share.symbol) }
        }
        Button(action: copyName) {
            Label { Text("Copy name") } icon: { Image(systemName: DuetGlyph.copy.symbol) }
        }
        if onDelete != nil {
            Divider()
            Button(role: .destructive) { askDelete() } label: {
                Label { Text("Delete") } icon: { Image(systemName: DuetGlyph.delete.symbol) }
            }
            .disabled(deleting)
        }
    }

    /// The question opens with the switch off every time.
    private func askDelete() {
        alsoWorkspace = false
        confirmingDelete = true
    }

    private func copyName() {
        UIPasteboard.general.string = file.name
        copies += 1
        AccessibilityNotification.Announcement(String(localized: "Name copied")).post()
    }

    /// "size · date", and M26's "· task" for a send or screenshot made in a task.
    private var detail: Text {
        let date = file.createdAt.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted).locale(locale))
        let base = file.size > 0 ? Text("\(FileCard.size(file.size)) · \(date)") : Text(verbatim: date)
        guard let taskTitle, !taskTitle.isEmpty else { return base }
        return Text("\(base) · \(taskTitle)")
    }
}

/// The row's Delete as a VoiceOver action (only where the list offers Delete).
private struct FileDeleteAccessibility: ViewModifier {
    var enabled: Bool
    var onAsk: () -> Void

    func body(content: Content) -> some View {
        if enabled {
            content.accessibilityAction(named: Text("Delete"), onAsk)
        } else {
            content
        }
    }
}

/// M9: long-press Share on a Files row. A server file has no public URL: the share sheet gets
/// a temporary copy downloaded through the signed-in session (the preview's folder, removed on
/// sign-out), named like the file.
struct SharedChannelFile: Transferable, Sendable {
    var file: ChannelFile
    var loader: any AuthenticatedLoading

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .data) { item in
            let data = try await item.loader.data(for: item.file.url)
            return SentTransferredFile(try ComputerFiles.write(data, for: item.file).url, allowAccessingOriginalFile: false)
        }
    }
}
