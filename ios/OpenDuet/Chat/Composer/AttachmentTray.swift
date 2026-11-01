// Picked attachments above the composer text (prompt L179): removable thumbnails with an upload
// progress ring; a failed upload shows its reason under the tile with Retry.
import SwiftUI
import UIKit

struct AttachmentTray: View {
    var attachments: [ComposerAttachment]
    var onRemove: (UUID) -> Void
    var onRetry: (UUID) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 10) {
                ForEach(attachments) { attachment in
                    AttachmentTile(attachment: attachment, onRemove: { onRemove(attachment.id) }, onRetry: { onRetry(attachment.id) })
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.8).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 8)
            .padding(.top, 10)
            .padding(.bottom, 2)
        }
        .scrollClipDisabled()
    }
}

private struct AttachmentTile: View {
    var attachment: ComposerAttachment
    var onRemove: () -> Void
    var onRetry: () -> Void

    private var failure: String? {
        if case .failed(let reason) = attachment.upload { reason } else { nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            preview
                .overlay { overlay }
                .overlay(alignment: .topTrailing) { removeButton }
            if let failure {
                Button(action: onRetry) {
                    VStack(alignment: .leading, spacing: 1) {
                        // The store's reason is already localized.
                        Text(verbatim: failure).foregroundStyle(Palette.failure)
                        Text("Retry").fontWeight(.semibold).foregroundStyle(Palette.primaryText)
                    }
                    .font(.system(size: 11))
                    .lineLimit(2)
                    .frame(width: tileWidth, alignment: .leading)
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityLabel(Text("Couldn't upload \(attachment.name). Retry"))
            }
        }
        .animation(.easeInOut(duration: 0.25), value: attachment.upload)
        .sensoryFeedback(.warning, trigger: failure) { _, new in new != nil }
    }

    private var isImage: Bool { attachment.mime.hasPrefix("image/") }
    private var tileWidth: CGFloat { isImage ? Metrics.thumbnail : 140 }

    @ViewBuilder
    private var preview: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        if let data = attachment.thumbnail, let image = UIImage(data: data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: Metrics.thumbnail, height: Metrics.thumbnail)
                .clipShape(shape)
                .accessibilityLabel(Text("Image, \(attachment.name)"))
        } else {
            HStack(spacing: 8) {
                DuetIcon(FileKind(mime: attachment.mime, name: attachment.name).trayIcon, size: 22, tint: Palette.accent)
                if !isImage {
                    Text(verbatim: attachment.name)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(2)
                }
            }
            .padding(.horizontal, 10)
            .frame(width: tileWidth, height: Metrics.thumbnail, alignment: isImage ? .center : .leading)
            .background(shape.fill(Palette.background).strokeBorder(Palette.hairline, lineWidth: Metrics.hairline))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("File, \(attachment.name)"))
        }
    }

    @ViewBuilder
    private var overlay: some View {
        switch attachment.upload {
        case .uploading(let progress):
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous).fill(.black.opacity(0.28))
                ProgressRing(progress: progress)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("Uploading"))
            .accessibilityValue(Text(progress.formatted(.percent.precision(.fractionLength(0)))))
        case .failed:
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Palette.failure, lineWidth: 1.5)
        case .uploaded:
            EmptyView()
        }
    }

    private var removeButton: some View {
        Button(action: onRemove) {
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(Palette.background)
                .frame(width: 20, height: 20)
                .background(Circle().fill(Palette.composerAction))
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.85))
        .offset(x: 10, y: -10)
        .accessibilityLabel(Text("Remove \(attachment.name)"))
    }
}

/// The upload progress ring on a thumbnail.
private struct ProgressRing: View {
    var progress: Double

    var body: some View {
        ZStack {
            Circle().stroke(.white.opacity(0.35), lineWidth: 3)
            Circle()
                .trim(from: 0, to: max(0.02, min(progress, 1)))
                .stroke(.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.easeOut(duration: 0.2), value: progress)
        }
        .frame(width: 24, height: 24)
    }
}

extension FileKind {
    /// M9: the type's icon in the app's line set (the composer's attachment tiles).
    var trayIcon: CardIcon {
        switch self {
        case .pdf, .text, .document: .doc
        case .image: .camera
        case .csv, .spreadsheet: .chart
        case .presentation: .slides
        case .html: .webpage
        case .archive: .folder
        case .other: .file
        }
    }
}
