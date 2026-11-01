// Full-screen image viewer (prompt L179, L186): pinch and double-tap zoom, pan while zoomed,
// swipe down to dismiss (the thread shows through as the image follows the finger), Share and
// Save to Photos (needs NSPhotoLibraryAddUsageDescription).
import Photos
import SwiftUI
import UIKit

/// An image to show full screen; Identifiable for `.fullScreenCover(item:)`.
struct ViewedImage: Identifiable {
    let id = UUID()
    let image: UIImage
    let name: String
}

struct ImageViewer: View {
    var image: UIImage
    var name: String

    @Environment(\.dismiss) private var dismiss
    @State private var dismissOffset: CGSize = .zero
    @State private var saveState: SaveState = .idle
    @ScaledMetric(relativeTo: .subheadline) private var messageSize: CGFloat = 15

    enum SaveState: Hashable { case idle, saving, saved, denied, failed }

    private var dragProgress: Double { min(Double(abs(dismissOffset.height)) / 320.0, 1) }

    var body: some View {
        ZStack {
            Color.black.opacity(1 - dragProgress * 0.85).ignoresSafeArea()
            ZoomableImage(image: image, name: name, dismissOffset: $dismissOffset) { dismiss() }
                .ignoresSafeArea()
            VStack {
                topBar
                Spacer()
                if let message = saveMessage {
                    Text(message)
                        .font(.system(size: messageSize, weight: .medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Capsule().fill(.black.opacity(0.6)))
                        .padding(.bottom, 24)
                        .transition(.opacity)
                }
            }
            .opacity(max(0, 1 - dragProgress * 2.5))
        }
        .statusBarHidden()
        .presentationBackground(.clear)
        .animation(.easeInOut(duration: 0.25), value: saveState)
        .sensoryFeedback(trigger: saveState) { _, new in
            switch new {
            case .saved: .success
            case .denied, .failed: .warning
            default: nil
            }
        }
        .task(id: saveState) {
            guard saveState == .saved || saveState == .failed || saveState == .denied else { return }
            try? await Task.sleep(for: .seconds(2.5))
            if !Task.isCancelled { saveState = .idle }
        }
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            circleButton("xmark", label: Text("Close")) { dismiss() }
            Spacer()
            ShareLink(item: Image(uiImage: image), preview: SharePreview(name, image: Image(uiImage: image))) {
                glyph("square.and.arrow.up")
            }
            .buttonStyle(PressableButtonStyle(scale: 0.9))
            .accessibilityLabel(Text("Share"))
            circleButton(saveState == .saved ? "checkmark" : "square.and.arrow.down", label: Text("Save to Photos")) {
                Task { await save() }
            }
            .disabled(saveState == .saving)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    private func circleButton(_ systemName: String, label: Text, action: @escaping () -> Void) -> some View {
        Button(action: action) { glyph(systemName) }
            .buttonStyle(PressableButtonStyle(scale: 0.9))
            .accessibilityLabel(label)
    }

    private func glyph(_ systemName: String) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(.white)
            .contentTransition(.symbolEffect(.replace))
            .frame(width: 40, height: 40)
            .background(Circle().fill(.white.opacity(0.16)))
            .contentShape(Circle())
    }

    private var saveMessage: LocalizedStringKey? {
        switch saveState {
        case .saved: "Saved to Photos"
        case .denied: "Allow OpenDuet to add photos in Settings."
        case .failed: "Couldn't save the image."
        case .idle, .saving: nil
        }
    }

    private func save() async {
        saveState = .saving
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            saveState = .denied
            return
        }
        do {
            try await Self.addToLibrary(image)
            saveState = .saved
        } catch {
            saveState = .failed
        }
    }

    /// Outside the main actor: Photos runs the change block on its own queue.
    nonisolated private static func addToLibrary(_ image: UIImage) async throws {
        try await PHPhotoLibrary.shared().performChanges {
            _ = PHAssetChangeRequest.creationRequestForAsset(from: image)
        }
    }
}

/// The zoomable, pannable image; at 1x a vertical drag moves `dismissOffset` instead.
private struct ZoomableImage: View {
    let image: UIImage
    let name: String
    @Binding var dismissOffset: CGSize
    var onDismiss: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var scale: CGFloat = 1
    @State private var baseScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var baseOffset: CGSize = .zero

    private static let maxScale: CGFloat = 4
    private static let doubleTapScale: CGFloat = 2.5

    private var spring: Animation {
        reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.35, dampingFraction: 0.85)
    }

    var body: some View {
        GeometryReader { geo in
            let fitted = fittedSize(in: geo.size)
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(width: fitted.width, height: fitted.height)
                .scaleEffect(scale)
                .offset(x: offset.width + dismissOffset.width, y: offset.height + dismissOffset.height)
                .frame(width: geo.size.width, height: geo.size.height)
                .contentShape(Rectangle())
                .onTapGesture(count: 2) { location in doubleTap(at: location, container: geo.size, fitted: fitted) }
                .gesture(magnify(container: geo.size, fitted: fitted))
                .simultaneousGesture(drag(container: geo.size, fitted: fitted))
                .accessibilityElement()
                .accessibilityLabel(Text(verbatim: name))
                .accessibilityAddTraits(.isImage)
                .accessibilityZoomAction { action in
                    withAnimation(spring) {
                        switch action.direction {
                        case .zoomIn: scale = min(scale + 1, Self.maxScale)
                        case .zoomOut: scale = max(scale - 1, 1)
                        }
                        offset = clamp(offset, scale: scale, container: geo.size, fitted: fitted)
                    }
                    baseScale = scale
                    baseOffset = offset
                }
        }
    }

    private func fittedSize(in container: CGSize) -> CGSize {
        let size = image.size
        guard size.width > 0, size.height > 0, container.width > 0, container.height > 0 else { return container }
        let ratio = min(container.width / size.width, container.height / size.height)
        return CGSize(width: size.width * ratio, height: size.height * ratio)
    }

    private func magnify(container: CGSize, fitted: CGSize) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                scale = min(max(baseScale * value.magnification, 0.85), Self.maxScale)
            }
            .onEnded { _ in
                withAnimation(spring) {
                    if scale < 1 { scale = 1 }
                    offset = clamp(offset, scale: scale, container: container, fitted: fitted)
                }
                baseScale = scale
                baseOffset = offset
            }
    }

    private func drag(container: CGSize, fitted: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                if scale > 1.01 {
                    offset = CGSize(width: baseOffset.width + value.translation.width, height: baseOffset.height + value.translation.height)
                } else if !reduceMotion {
                    // Reduce Motion: the image holds still; a long enough swipe still closes it.
                    dismissOffset = value.translation
                }
            }
            .onEnded { value in
                if scale > 1.01 {
                    withAnimation(spring) { offset = clamp(offset, scale: scale, container: container, fitted: fitted) }
                    baseOffset = offset
                } else if abs(value.translation.height) > 120 || abs(value.predictedEndTranslation.height) > 360 {
                    onDismiss()
                } else {
                    withAnimation(spring) { dismissOffset = .zero }
                }
            }
    }

    private func doubleTap(at location: CGPoint, container: CGSize, fitted: CGSize) {
        withAnimation(spring) {
            if scale > 1.01 {
                scale = 1
                offset = .zero
            } else {
                // Zoom in on the tapped point: it stays under the finger.
                let target = Self.doubleTapScale
                let proposed = CGSize(
                    width: (container.width / 2 - location.x) * (target - 1),
                    height: (container.height / 2 - location.y) * (target - 1)
                )
                scale = target
                offset = clamp(proposed, scale: target, container: container, fitted: fitted)
            }
        }
        baseScale = scale
        baseOffset = offset
    }

    private func clamp(_ proposed: CGSize, scale: CGFloat, container: CGSize, fitted: CGSize) -> CGSize {
        let maxX = max((fitted.width * scale - container.width) / 2, 0)
        let maxY = max((fitted.height * scale - container.height) / 2, 0)
        return CGSize(width: min(max(proposed.width, -maxX), maxX), height: min(max(proposed.height, -maxY), maxY))
    }
}
