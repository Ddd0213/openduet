// Images from the server (prompt L172, L186): loaded through the signed-in session
// (`authenticatedLoader`), decoded off the main thread and kept in a memory cache, so image
// bubbles scroll back in without a reload.
import SwiftUI
import UIKit

/// Decoded images by server path. NSCache is thread-safe and evicts under memory pressure.
final class ImageMemoryCache: @unchecked Sendable {
    static let shared = ImageMemoryCache()
    private let cache = NSCache<NSString, UIImage>()

    private init() { cache.totalCostLimit = 64 * 1024 * 1024 }

    func image(for path: String) -> UIImage? { cache.object(forKey: path as NSString) }

    func insert(_ image: UIImage, for path: String) {
        let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4)
        cache.setObject(image, forKey: path as NSString, cost: cost)
    }
}

enum ImagePhase {
    case loading
    case loaded(UIImage)
    case failed
}

struct AuthenticatedImage<Content: View>: View {
    var path: String
    @ViewBuilder var content: (_ phase: ImagePhase, _ retry: @escaping () -> Void) -> Content

    @Environment(\.authenticatedLoader) private var loader
    @State private var phase: ImagePhase = .loading
    @State private var attempt = 0

    var body: some View {
        content(phase) { attempt += 1 }
            .task(id: TaskKey(path: path, attempt: attempt)) { await load() }
    }

    private struct TaskKey: Hashable {
        var path: String
        var attempt: Int
    }

    private func load() async {
        if let cached = ImageMemoryCache.shared.image(for: path) {
            phase = .loaded(cached)
            return
        }
        phase = .loading
        do {
            let data = try await loader.data(for: path)
            let image = await Task.detached(priority: .userInitiated) { UIImage(data: data)?.preparingForDisplay() }.value
            guard !Task.isCancelled else { return }
            if let image {
                ImageMemoryCache.shared.insert(image, for: path)
                phase = .loaded(image)
            } else {
                phase = .failed
            }
        } catch {
            if !Task.isCancelled { phase = .failed }
        }
    }
}
