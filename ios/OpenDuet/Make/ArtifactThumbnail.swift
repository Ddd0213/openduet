// Live thumbnails of Make artifacts (prompt L147, L186): the artifact's HTML (fetched through the
// signed-in session, L172) rendered once in an offscreen WKWebView, snapshotted with
// takeSnapshot and cached in memory per version and colour scheme, so the gallery and chat
// cards never re-render a page they already drew. One snapshot at a time.
// M24 (review-make P2-1): the snapshots are also kept on disk (ThumbnailDiskCache: same key, so a
// new version misses; ~50 MB; deleted on sign-out), so a cold start shows them without rendering.
// A design is captured down to its end (up to two screens) so the gallery can show it whole.
// M27: the key stays `updatedAt` (live data moves it too); a tile whose only change is data keeps
// the newest snapshot of the artifact and re-renders at most every 30 s (ThumbnailPacing).
import SwiftUI
import UIKit
import WebKit

@MainActor
final class ArtifactSnapshots {
    static let shared = ArtifactSnapshots()

    private let cache = NSCache<NSString, UIImage>()
    /// M27: what the newest snapshot of each artifact (per scheme) showed, and when it rendered;
    /// the image itself stays in `cache` (or on disk).
    private var newest: [String: ThumbnailPacing.Shown] = [:]
    private var running: [String: Task<UIImage?, Never>] = [:]
    private var queue: Task<Void, Never>?
    private var webView: WKWebView?
    private let delegate = SnapshotNavigation()
    private let disk = ThumbnailDiskCache.shared
    /// Counts sign-outs: a render or disk read that started before one is dropped.
    private var generation = 0

    /// The page is laid out at a phone width, then scaled down.
    static let viewport = CGSize(width: 390, height: 520)
    static let snapshotWidth: CGFloat = 260
    /// How far down a design is captured (two screens).
    static let maxDesignHeight: CGFloat = 1040

    private init() {
        cache.totalCostLimit = 48 << 20
    }

    func cached(_ key: ThumbnailKey) -> UIImage? {
        cache.object(forKey: key.memoryKey as NSString)
    }

    /// Sign-out: drop every snapshot, in memory and on disk (they are this account's pages).
    func clear() {
        cache.removeAllObjects()
        newest = [:]
        running.values.forEach { $0.cancel() }
        running = [:]
        generation += 1
        let disk = disk, floor = generation
        Task { await disk.removeAll(generation: floor) }
    }

    /// M27: the newest snapshot of `artifactId` in a scheme, from memory, else from disk (`exact`:
    /// it is `key`'s own), so a tile shows it while a data-only change waits (ThumbnailPacing).
    func latest(_ artifactId: String, key: ThumbnailKey) async -> (image: UIImage, shown: ThumbnailPacing.Shown?, exact: Bool)? {
        let slot = Self.slot(artifactId, dark: key.dark)
        if let shown = newest[slot], let image = cached(shown.key) {
            return (image, shown, shown.key.memoryKey == key.memoryKey)
        }
        let started = generation
        guard let found = await disk.newest(artifactId, dark: key.dark), generation == started,
              let image = await Self.decoded(found.data) else { return nil }
        let exact = found.key.fileName == key.fileName
        // An exact copy is kept under the asked-for key (its date may differ below a millisecond).
        keep(image, exact ? key : found.key)
        return (image, nil, exact)
    }

    /// The snapshot for `key`: memory, then disk, then rendering `html` (deduplicated by key, one
    /// render at a time). `tall`: a design, captured down to its end. M27: `artifact` is the
    /// summary it shows (the newest snapshot per artifact paces data-only changes).
    func image(key: ThumbnailKey, artifact: ArtifactSummary, tall: Bool, html: @escaping @Sendable () async throws -> String) async -> UIImage? {
        if let hit = cached(key) { return hit }
        let name = key.memoryKey
        if let task = running[name] { return await task.value }
        let previous = queue
        let started = generation
        let task = Task<UIImage?, Never> { [weak self] in
            if let saved = await ArtifactSnapshots.saved(key), let self, !Task.isCancelled, self.generation == started {
                self.keep(saved, key)
                self.remember(key, artifact, renderedAt: .distantPast)
                return saved
            }
            await previous?.value
            guard let self, !Task.isCancelled, let page = try? await html() else { return nil }
            guard let image = await self.render(page, dark: key.dark, tall: tall), !Task.isCancelled,
                  self.generation == started else { return nil }
            self.keep(image, key)
            self.remember(key, artifact, renderedAt: .now)
            self.save(image, key, generation: started)
            return image
        }
        running[name] = task
        // The next render waits for this one (a disk hit finishes early, so wait for both).
        queue = Task { await previous?.value; _ = await task.value }
        let image = await task.value
        running[name] = nil
        return image
    }

    private func keep(_ image: UIImage, _ key: ThumbnailKey) {
        let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4)
        cache.setObject(image, forKey: key.memoryKey as NSString, cost: cost)
    }

    /// M27: the newest snapshot per artifact and scheme (an older version never replaces it).
    private func remember(_ key: ThumbnailKey, _ artifact: ArtifactSummary, renderedAt: Date) {
        let slot = Self.slot(key.artifactId, dark: key.dark)
        if let current = newest[slot], current.key.version > key.version { return }
        newest[slot] = ThumbnailPacing.Shown(key: key, pageVersion: artifact.pageVersion, dataVersion: artifact.dataVersion,
                                             status: artifact.status, renderedAt: renderedAt)
    }

    private static func slot(_ artifactId: String, dark: Bool) -> String { "\(artifactId)|\(dark ? "d" : "l")" }

    /// The disk copy, decoded off the main actor.
    private static func saved(_ key: ThumbnailKey) async -> UIImage? {
        guard let data = await ThumbnailDiskCache.shared.data(for: key) else { return nil }
        return await decoded(data)
    }

    private static func decoded(_ data: Data) async -> UIImage? {
        await Task.detached(priority: .utility) {
            UIImage(data: data)?.preparingForDisplay()
        }.value
    }

    /// Onto the tile colour of its scheme (JPEG has no alpha), encoded off the main actor.
    private func save(_ image: UIImage, _ key: ThumbnailKey, generation: Int) {
        let traits = UITraitCollection(userInterfaceStyle: key.dark ? .dark : .light)
        let backdrop = UIColor(Palette.tile).resolvedColor(with: traits)
        let disk = disk
        Task.detached(priority: .utility) {
            guard let data = ArtifactSnapshots.flattened(image, on: backdrop).jpegData(compressionQuality: 0.72) else { return }
            await disk.store(data, for: key, generation: generation)
        }
    }

    nonisolated private static func flattened(_ image: UIImage, on color: UIColor) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = image.scale
        format.opaque = true
        return UIGraphicsImageRenderer(size: image.size, format: format).image { context in
            color.setFill()
            context.fill(CGRect(origin: .zero, size: image.size))
            image.draw(at: .zero)
        }
    }

    private func render(_ html: String, dark: Bool, tall: Bool) async -> UIImage? {
        let view = webView ?? makeWebView()
        webView = view
        view.overrideUserInterfaceStyle = dark ? .dark : .light
        // WebKit paints only views in a window: park it behind the app's content.
        let origin = CGPoint(x: -Self.viewport.width - 40, y: 0)
        view.frame = CGRect(origin: origin, size: Self.viewport)
        if view.window == nil, let window = Self.keyWindow {
            window.insertSubview(view, at: 0)
        }
        let loaded = await delegate.load(html, in: view)
        guard loaded, !Task.isCancelled else { return nil }
        // Fonts and the page's own layout settle.
        try? await Task.sleep(for: .milliseconds(250))
        var size = Self.viewport
        if tall, let height = await contentHeight(view), height > size.height {
            // M24: a design is shown whole in the gallery: capture it down to its end.
            size.height = min(height, Self.maxDesignHeight)
            view.frame = CGRect(origin: origin, size: size)
            try? await Task.sleep(for: .milliseconds(150))
        }
        guard !Task.isCancelled else { return nil }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = CGRect(origin: .zero, size: size)
        configuration.snapshotWidth = NSNumber(value: Double(Self.snapshotWidth))
        configuration.afterScreenUpdates = true
        return try? await view.takeSnapshot(configuration: configuration)
    }

    /// The page's full height at the phone width (nil when it can't be read).
    private func contentHeight(_ view: WKWebView) async -> CGFloat? {
        let script = "return Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)"
        guard let value = try? await view.callAsyncJavaScript(script, contentWorld: .defaultClient) as? NSNumber else { return nil }
        return CGFloat(value.doubleValue)
    }

    private func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        let view = WKWebView(frame: CGRect(origin: .zero, size: Self.viewport), configuration: configuration)
        view.isOpaque = false
        view.isUserInteractionEnabled = false
        view.scrollView.isScrollEnabled = false
        view.navigationDelegate = delegate
        view.accessibilityElementsHidden = true
        return view
    }

    private static var keyWindow: UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
    }
}

/// Waits for one loadHTMLString to finish (or 8 s) and refuses any other navigation.
@MainActor
private final class SnapshotNavigation: NSObject, WKNavigationDelegate {
    private var waiting: CheckedContinuation<Bool, Never>?

    func load(_ html: String, in view: WKWebView) async -> Bool {
        finish(false)
        return await withCheckedContinuation { continuation in
            waiting = continuation
            view.loadHTMLString(html, baseURL: nil)
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(8))
                self?.finish(false)
            }
        }
    }

    private func finish(_ ok: Bool) {
        waiting?.resume(returning: ok)
        waiting = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(true) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { finish(false) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { finish(false) }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        navigationAction.request.url?.scheme == "about" ? .allow : .cancel
    }
}

/// A live thumbnail of an artifact: the cached snapshot, a pulsing block while it renders or
/// builds, the type's outline drawing when it can't be shown.
struct ArtifactThumbnail: View {
    /// M24: how the snapshot sits in the frame.
    enum Fit {
        /// a page: the frame's width, from the top, the rest cut off
        case top
        /// a design: all of it, scaled down, centred on the tile colour
        case whole
    }

    var artifact: ArtifactSummary
    var corner: CGFloat = 12
    var fit: Fit = .top

    @Environment(\.authenticatedLoader) private var loader
    @Environment(\.colorScheme) private var colorScheme
    @State private var image: UIImage?
    @State private var failed = false

    private var key: ThumbnailKey {
        ThumbnailKey(artifactId: artifact.id, version: artifact.updatedAt, dark: colorScheme == .dark)
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: corner, style: .continuous).fill(Palette.tile)
            if let image {
                switch fit {
                case .top:
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        .transition(.opacity)
                case .whole:
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                        .shadow(color: .black.opacity(0.12), radius: 3, y: 1)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .transition(.opacity)
                }
            } else if failed || artifact.status == .failed {
                TypeIllustration(type: artifact.type, lineWidth: 1.5)
                    .padding(18)
                    .opacity(0.7)
            } else {
                RoundedRectangle(cornerRadius: corner, style: .continuous)
                    .fill(Palette.skeleton)
                    .skeletonPulse()
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
        .animation(.easeInOut(duration: 0.3), value: image != nil)
        .task(id: artifact.status == .ready ? key.memoryKey : "") {
            guard artifact.status == .ready else { return }
            let key = key
            let artifact = artifact
            let snapshots = ArtifactSnapshots.shared
            if let hit = snapshots.cached(key) {
                image = hit
                return
            }
            // M27: the newest snapshot of this artifact stays on screen; a change that is only
            // live data re-renders at most every 30 s (ThumbnailPacing), a new page at once.
            if let latest = await snapshots.latest(artifact.id, key: key) {
                guard !Task.isCancelled else { return }
                image = latest.image
                if !latest.exact, case .wait(let left) = ThumbnailPacing.decide(shown: latest.shown, artifact: artifact, now: .now) {
                    try? await Task.sleep(for: .seconds(left))
                    guard !Task.isCancelled else { return }
                }
            }
            let loader = loader
            let path = "/api/artifacts/\(artifact.id.pathSegment)/html?v=\(Int(artifact.updatedAt.timeIntervalSince1970))"
            let tall = MakeGallery.designTypes.contains(artifact.type)
            let rendered = await snapshots.image(key: key, artifact: artifact, tall: tall) {
                let data = try await loader.data(for: path)
                return String(decoding: data, as: UTF8.self)
            }
            guard !Task.isCancelled else { return }
            if let rendered { image = rendered } else { failed = image == nil }
        }
        .accessibilityHidden(true)
    }
}
