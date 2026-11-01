// A shared HTML file in the app's own web view (PART C, L180): no scripts, no network, no
// navigation past the file itself, and the strict CSP from HTMLPreview.harden, so a shared page
// can't run or phone home.
// M9: it reads like a panel of the app (NativePanel): no zoom, no sideways scroll or bounce, no
// link previews or callouts. It fades in once it has painted (no white flash).
// M26: the view starts at the preview header's lower edge (FilePreviewLayout), so the page's top,
// fixed or sticky headers and 100vh layouts included, is never under the header; only the bottom
// reaches under the soft edge over the home indicator, with a bottom inset for the last line.
import SwiftUI
import WebKit

/// A shared HTML file, shown inert: JavaScript off, a non-persistent store, the CSP meta, and
/// every navigation after the first load cancelled (links do nothing).
struct HTMLFileView: UIViewRepresentable {
    var url: URL
    /// How far the web view reaches past the page at the bottom (FilePreviewLayout.bottomInset).
    var bottomInset: CGFloat = 0

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.dataDetectorTypes = []
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = ChromeInsetWebView(frame: .zero, configuration: configuration)
        view.allowsLinkPreview = false
        // Shown once the page has painted.
        view.alpha = 0
        NativePanel.configure(view.scrollView, delegate: context.coordinator)
        view.navigationDelegate = context.coordinator
        context.coordinator.apply(bottom: bottomInset, to: view)
        context.coordinator.load(url, in: view)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.apply(bottom: bottomInset, to: view)
        context.coordinator.load(url, in: view)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.task?.cancel()
        view.stopLoading()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, UIScrollViewDelegate {
        private var loadedURL: URL?
        /// true while our own loadHTMLString is the next navigation
        private var expectingLoad = false
        var task: Task<Void, Never>?

        func load(_ url: URL, in view: WKWebView) {
            guard loadedURL != url else { return }
            loadedURL = url
            task?.cancel()
            task = Task { [weak self, weak view] in
                let html = await Self.read(url)
                guard let self, let view, !Task.isCancelled else { return }
                self.expectingLoad = true
                view.loadHTMLString(NativePanel.inject(into: HTMLPreview.harden(html)), baseURL: nil)
            }
        }

        /// Only the bottom: the view itself starts at the header's lower edge, so the page's first
        /// line rests there with no inset and no offset to push it down (as ArtifactWebView).
        func apply(bottom: CGFloat, to view: WKWebView) {
            let scroll = view.scrollView
            let new = UIEdgeInsets(top: 0, left: 0, bottom: bottom, right: 0)
            guard new != scroll.contentInset else { return }
            scroll.contentInset = new
            scroll.verticalScrollIndicatorInsets = new
        }

        nonisolated private static func read(_ url: URL) async -> String {
            guard let data = try? Data(contentsOf: url) else { return "" }
            return String(decoding: data, as: UTF8.self)
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            NativePanel.clamp(scrollView)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard webView.alpha < 1 else { return }
            UIView.animate(withDuration: 0.2) { webView.alpha = 1 }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            // Only the document we load ourselves (and its own about: frames); never a link.
            if expectingLoad, action.navigationType == .other, action.targetFrame?.isMainFrame == true {
                expectingLoad = false
                return .allow
            }
            if action.request.url?.scheme == "about", action.navigationType == .other { return .allow }
            return .cancel
        }
    }
}
