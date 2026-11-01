// An image bubble (prompt L142, L172, L179): loaded through the signed-in session and cached;
// a pulsing placeholder while it loads, tap to retry on failure, tap to open full screen.
// M26: a deleted image (file.deletedAt) is a placeholder of the same size with a photo glyph and
// "Deleted"; it never loads the bytes and doesn't open. Composer attachments use it too.
import SwiftUI

struct ImageBubble: View {
    var file: ChannelFile

    @State private var viewing: ViewedImage?

    private static let corner: CGFloat = 16

    var body: some View {
        if file.isDeleted {
            deletedPlaceholder
        } else {
            liveImage
        }
    }

    /// M26: the failed state's size and surface, quiet, never tappable.
    private var deletedPlaceholder: some View {
        VStack(spacing: 6) {
            Image(systemName: FileKind.image.glyph)
                .glyphFont(22)
                .accessibilityHidden(true)
            Text("Deleted")
                .font(Typography.caption)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(Palette.secondaryText)
        .padding(12)
        .frame(width: 200)
        .frame(minHeight: 150)
        .background(
            RoundedRectangle(cornerRadius: Self.corner, style: .continuous)
                .fill(Palette.skeleton)
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Image, \(file.name), deleted"))
    }

    private var liveImage: some View {
        AuthenticatedImage(path: file.url) { phase, retry in
            switch phase {
            case .loaded(let image):
                Button {
                    viewing = ViewedImage(image: image, name: file.name)
                } label: {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: Metrics.imageBubbleMax, maxHeight: Metrics.imageBubbleMax)
                        .clipShape(RoundedRectangle(cornerRadius: Self.corner, style: .continuous))
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityLabel(Text("Image, \(file.name)"))
                .accessibilityHint(Text("Opens the image full screen"))
                .transition(.opacity)
            case .loading:
                placeholder
                    .skeletonPulse()
                    .accessibilityLabel(Text("Loading image"))
            case .failed:
                Button(action: retry) {
                    // 200 x 150 at the default size; grows taller with larger text instead of clipping.
                    VStack(spacing: 6) {
                        DuetIcon(glyph: .refresh, size: 22, tint: Palette.secondaryText)
                        Text("Couldn't load the image. Tap to retry.")
                            .font(Typography.caption)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .foregroundStyle(Palette.secondaryText)
                    .padding(12)
                    .frame(width: 200)
                    .frame(minHeight: 150)
                    .background(
                        RoundedRectangle(cornerRadius: Self.corner, style: .continuous)
                            .fill(Palette.skeleton)
                    )
                }
                .buttonStyle(PressableButtonStyle())
            }
        }
        .fullScreenCover(item: $viewing) { item in
            ImageViewer(image: item.image, name: item.name)
        }
    }

    private var placeholder: some View {
        RoundedRectangle(cornerRadius: Self.corner, style: .continuous)
            .fill(Palette.skeleton)
            .frame(width: 200, height: 150)
    }
}
