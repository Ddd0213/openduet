// A file card (prompt L179, "file" kind): a white rounded card with a hairline, the file-type
// glyph tile, the name and "size · TYPE", and a › because it opens. Tapping opens
// duet://files/<id>: the full-screen preview (Quick Look, or a locked-down web view for HTML).
// M26: a deleted file (file.deletedAt) keeps its card, dimmed: the tile, the name and "Deleted"
// instead of the size, no ›, and it doesn't open. Composer attachments in a user bubble use it too.
import SwiftUI

struct FileCard: View {
    var file: ChannelFile
    var caption: String = ""
    var onOpen: () -> Void

    @ScaledMetric(relativeTo: .body) private var nameSize: CGFloat = 15

    var body: some View {
        if file.isDeleted {
            deletedCard
        } else {
            liveCard
        }
    }

    /// M26: what stays of a deleted file in the chat.
    private var deletedCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                FileGlyphTile(kind: FileKind(mime: file.mime, name: file.name), size: 42)
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: file.name)
                        .font(.system(size: nameSize, weight: .medium))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .multilineTextAlignment(.leading)
                    Text("Deleted")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("File, \(file.name), deleted"))
            if !caption.isEmpty {
                Text(verbatim: caption)
                    .font(.system(size: nameSize))
                    .foregroundStyle(Palette.primaryText)
                    .multilineTextAlignment(.leading)
            }
        }
        .padding(12)
        .frame(maxWidth: 280, alignment: .leading)
        .cardSurface()
        .opacity(0.55)
        .accessibilityElement(children: .contain)
    }

    private var liveCard: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    FileGlyphTile(kind: FileKind(mime: file.mime, name: file.name), size: 42)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: file.name)
                            .font(.system(size: nameSize, weight: .medium))
                            .foregroundStyle(Palette.primaryText)
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .multilineTextAlignment(.leading)
                        detail
                            .font(Typography.caption)
                            .foregroundStyle(Palette.secondaryText)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    RowChevron()
                }
                if !caption.isEmpty {
                    Text(verbatim: caption)
                        .font(.system(size: nameSize))
                        .foregroundStyle(Palette.primaryText)
                        .multilineTextAlignment(.leading)
                }
            }
            .padding(12)
            .frame(maxWidth: 280, alignment: .leading)
            .cardSurface()
            .contentShape(RoundedRectangle(cornerRadius: Metrics.cardCorner, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("File, \(file.name), \(Self.size(file.size))"))
        .accessibilityHint(Text("Opens the file"))
    }

    /// "2.4 MB · PDF" (just the type while the size is unknown).
    private var detail: Text {
        let type = FileKind.typeLabel(name: file.name, mime: file.mime)
        guard file.size > 0 else { return type }
        return Text("\(Self.size(file.size)) · \(type)")
    }

    static func size(_ bytes: Int) -> String {
        Int64(bytes).formatted(.byteCount(style: .file))
    }

    /// The type glyph for a MIME type alone (attachments, approvals); FileKind decides it.
    static func glyph(for mime: String) -> String {
        FileKind(mime: mime, name: "").glyph
    }
}

extension FileKind {
    /// M9: the type as a key of the hand-drawn set, for small inline marks (attachment chips).
    /// Tiles keep FileGlyphTile. No image key in CardIcon yet: images use `camera`.
    var cardIcon: CardIcon {
        switch self {
        case .pdf, .document, .text: .doc
        case .csv, .spreadsheet: .chart
        case .presentation: .slides
        case .html: .webpage
        case .image: .camera
        case .archive: .folder
        case .other: .file
        }
    }
}
