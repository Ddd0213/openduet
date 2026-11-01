// Turning picked items into PickedFile (prompt L179): photos become JPEG (the server takes HEIC
// but models can't read it), files are read through their security scope, and the camera is a
// UIImagePickerController.
import ImageIO
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

enum AttachmentLoader {
    /// Photos are sent at up to this many pixels on the long side.
    static let maxPhotoPixels = 4096

    static func photos(_ items: [PhotosPickerItem]) async -> [PickedFile] {
        var files: [PickedFile] = []
        for (index, item) in items.enumerated() {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            if let file = await jpeg(data, name: photoName(index: index)) { files.append(file) }
        }
        return files
    }

    /// `index`: the photo's place among several taken at once (M29 paste), for distinct names.
    static func camera(_ image: UIImage, index: Int = 0) async -> PickedFile? {
        let data = await Task.detached(priority: .userInitiated) { image.jpegData(compressionQuality: 0.85) }.value
        guard let data else { return nil }
        return PickedFile(name: photoName(index: index), mime: "image/jpeg", data: data)
    }

    static func files(_ urls: [URL]) async -> [PickedFile] {
        var files: [PickedFile] = []
        for url in urls {
            if let file = await Task.detached(priority: .userInitiated, operation: { readFile(url) }).value {
                files.append(await heicAsJPEG(file))
            }
        }
        return files
    }

    /// M29: the images of a paste (ComposerUITextView), at most PasteRules.maxImages. An image
    /// file (PNG / JPEG / HEIC with a name, PasteRules.source) keeps its bytes and name, HEIC
    /// turned into JPEG as in `files`; any other picture goes as the camera's photo (JPEG 0.85).
    static func pasted(_ providers: [NSItemProvider]) async -> [PickedFile] {
        let images = providers.filter { $0.canLoadObject(ofClass: UIImage.self) }.prefix(PasteRules.maxImages)
        var files: [PickedFile] = []
        var pictures = 0
        for provider in images {
            let types = provider.registeredContentTypes.map(\.identifier)
            if case .file(let type) = PasteRules.source(types: types, suggestedName: provider.suggestedName),
               let data = await loadData(provider, type: type) {
                let file = PickedFile(name: PasteRules.fileName(provider.suggestedName, type: type), mime: PasteRules.mime(type: type), data: data)
                files.append(await heicAsJPEG(file))
            } else if let image = await loadImage(provider), let file = await camera(image, index: pictures) {
                pictures += 1
                files.append(file)
            }
        }
        return files
    }

    /// HEIC / HEIF become JPEG (models can't read them); the original when that fails.
    private static func heicAsJPEG(_ file: PickedFile) async -> PickedFile {
        guard file.mime == "image/heic" || file.mime == "image/heif" else { return file }
        let base = (file.name as NSString).deletingPathExtension
        return await jpeg(file.data, name: base + ".jpg") ?? file
    }

    // The providers' callbacks come on a background queue: these stay off any actor.
    nonisolated private static func loadData(_ provider: NSItemProvider, type: String) async -> Data? {
        await withCheckedContinuation { continuation in
            _ = provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in continuation.resume(returning: data) }
        }
    }

    nonisolated private static func loadImage(_ provider: NSItemProvider) async -> UIImage? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: UIImage.self) { object, _ in continuation.resume(returning: object as? UIImage) }
        }
    }

    /// JPEG at most `maxPhotoPixels` on the long side, upright (ImageIO, off the main actor).
    private static func jpeg(_ data: Data, name: String) async -> PickedFile? {
        let converted = await Task.detached(priority: .userInitiated) { Thumbnail.jpeg(from: data, maxPixels: maxPhotoPixels) }.value
        guard let converted else { return nil }
        return PickedFile(name: name, mime: "image/jpeg", data: converted)
    }

    nonisolated private static func readFile(_ url: URL) -> PickedFile? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        // Over the server's limit: don't read it; a placeholder of the same size fails as "Too large".
        if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > UploadFileResponse.maxUploadBytes {
            return PickedFile(name: url.lastPathComponent, mime: mime, data: Data(count: size))
        }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return PickedFile(name: url.lastPathComponent, mime: mime, data: data)
    }

    private static func photoName(index: Int) -> String {
        let stamp = Date.now.formatted(.verbatim("\(year: .defaultDigits)\(month: .twoDigits)\(day: .twoDigits)-\(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased))\(minute: .twoDigits)\(second: .twoDigits)", timeZone: .current, calendar: .current))
        return index == 0 ? "Photo-\(stamp).jpg" : "Photo-\(stamp)-\(index + 1).jpg"
    }
}

/// The camera, presented full screen; hands back the photo or nothing.
struct CameraPicker: UIViewControllerRepresentable {
    var onFinish: (UIImage?) -> Void

    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onFinish: (UIImage?) -> Void

        init(onFinish: @escaping (UIImage?) -> Void) { self.onFinish = onFinish }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onFinish(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onFinish(nil)
        }
    }
}
