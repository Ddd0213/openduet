// The artifact page (prompt L151, L172, L181): HTML the app fetched through the signed-in session,
// rendered with loadHTMLString (baseURL nil, so nothing on the server is reachable from the page
// and it loads no public URL). Links leave through `onLink` (duet:// in the app, http(s) in the
// Safari sheet); a reload keeps the scroll position and brings the first changed passage
// ([data-duet-changed], glowed by the page's own CSS) into view. ArtifactPage drives it:
// select-to-comment, scrolling to a heading, Export PDF and Copy text.
// M9 ("应该给人的感觉就像是内置在这个应用中的小组件"): the page is a native panel, not a web page
// (NativePanel): no pinch or double-tap zoom, no sideways scroll or bounce, no link previews or
// callouts, a clear background (no white flash), only the app's own vertical bounce. Old artifacts
// get the same viewport and CSS the backend's base now ships (contract §6), injected at start.
// M27: ArtifactPage.handOver puts a dashboard's newer live data into the open page in place; it
// waits for the page's load to finish (finishedLoads).
import SwiftUI
import WebKit

@MainActor
@Observable
final class ArtifactPage {
    @ObservationIgnored fileprivate weak var webView: WKWebView?
    /// select-to-comment is on (the page outlines what's tapped and hands its text back)
    private(set) var selecting = false
    /// The page's own background, reported after each load and when the system scheme changes;
    /// the viewer's bars take it (PageTint). Nil until the first page has loaded.
    fileprivate(set) var backdrop: PageBackdrop?
    /// M27: bumps when a load finishes (or fails): a data hand-over asked for meanwhile runs then.
    fileprivate(set) var finishedLoads = 0
    /// M27: the HTML the web view was last asked to load, and whether it is still loading it.
    @ObservationIgnored fileprivate var loadedHTML: String?
    @ObservationIgnored fileprivate var loading = false

    func setSelecting(_ on: Bool) {
        selecting = on
        run("window.__duet && window.__duet.select(\(on ? "true" : "false"))")
    }

    /// Contents: scroll to the index-th h1-h3 (DocOutline's numbering).
    func scrollToHeading(_ index: Int, smooth: Bool) {
        run("window.__duet && window.__duet.heading(\(index), \(smooth ? "true" : "false"))")
    }

    /// Export PDF: the whole page through the page's print layout.
    func pdf() async -> Data? {
        guard let webView else { return nil }
        return try? await webView.pdf(configuration: WKPDFConfiguration())
    }

    /// Copy text: what the page shows, without markup.
    func text() async -> String? {
        guard let webView else { return nil }
        let value = try? await webView.callAsyncJavaScript("return document.body ? document.body.innerText : ''", contentWorld: .defaultClient)
        return value as? String
    }

    /// M27: the open page shows `html` and has finished loading it (a hand-over waits for that).
    func isShowing(_ html: String) -> Bool {
        webView != nil && !loading && loadedHTML == html
    }

    /// M27: newer live data into the open page, in place (no reload, no scroll jump, no glow):
    /// the JSON text exactly as GET /data sent it and its version go in as arguments
    /// (LiveDataRules.handOverScript). The version the page shows now, -1 when it has no data
    /// element, nil when there is no page or the script failed.
    func handOver(json: String, version: Int) async -> Int? {
        guard let webView, !loading else { return nil }
        let arguments = LiveDataRules.handOverArguments(json: json, version: version)
        let value = try? await webView.callAsyncJavaScript(LiveDataRules.handOverScript, arguments: arguments, contentWorld: .defaultClient)
        return (value as? NSNumber)?.intValue
    }

    fileprivate func run(_ script: String) {
        webView?.evaluateJavaScript(script, in: nil, in: .defaultClient, completionHandler: nil)
    }
}

struct ArtifactWebView: UIViewRepresentable {
    var html: String
    var page: ArtifactPage
    /// The room under the page's end. The page starts at the top bar's lower edge (no inset, no
    /// offset); with the edit bar closed the view reaches the screen bottom and this keeps the last
    /// line above the home indicator (on the 4th tab, above the tab bar). 0 above the bar.
    var bottomInset: CGFloat = 0
    var onLink: (URL) -> Void
    var onSelect: (String) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.dataDetectorTypes = []
        let controller = configuration.userContentController
        controller.addUserScript(WKUserScript(source: NativePanel.script, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient))
        controller.addUserScript(WKUserScript(source: Self.bridge, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
        controller.add(WeakMessageHandler(context.coordinator), contentWorld: .defaultClient, name: "duetSelect")
        controller.add(WeakMessageHandler(context.coordinator), contentWorld: .defaultClient, name: "duetBackdrop")
        let view = ChromeInsetWebView(frame: .zero, configuration: configuration)
        // Clear: the app's background shows until the page paints (no white flash).
        view.isOpaque = false
        view.backgroundColor = .clear
        view.underPageBackgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        NativePanel.configure(view.scrollView, delegate: context.coordinator)
        view.allowsLinkPreview = false
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        page.webView = view
        context.coordinator.update(self)
        context.coordinator.apply(bottom: bottomInset, to: view)
        context.coordinator.load(html, in: view)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        page.webView = view
        context.coordinator.update(self)
        context.coordinator.apply(bottom: bottomInset, to: view)
        if context.coordinator.loadedHTML != html {
            context.coordinator.load(html, in: view)
        }
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "duetSelect", contentWorld: .defaultClient)
        view.configuration.userContentController.removeScriptMessageHandler(forName: "duetBackdrop", contentWorld: .defaultClient)
        view.stopLoading()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UIScrollViewDelegate {
        var loadedHTML: String?
        private var onLink: (URL) -> Void = { _ in }
        private var onSelect: (String) -> Void = { _ in }
        private var page: ArtifactPage?
        private var reduceMotion = false
        /// The scroll offset to put back after a reload (edits re-render in place).
        private var restoreOffset: CGPoint?
        /// M27: the navigation of the last load (an earlier one ending doesn't count).
        private var navigation: WKNavigation?

        func update(_ parent: ArtifactWebView) {
            onLink = parent.onLink
            onSelect = parent.onSelect
            page = parent.page
            reduceMotion = parent.reduceMotion
        }

        func load(_ html: String, in view: WKWebView) {
            restoreOffset = loadedHTML == nil ? nil : view.scrollView.contentOffset
            loadedHTML = html
            page?.loadedHTML = html
            page?.loading = true
            navigation = view.loadHTMLString(html, baseURL: nil)
        }

        /// M27: the last load ended (a hand-over waiting for it runs now).
        private func ended(_ finished: WKNavigation?) {
            guard finished === navigation else { return }
            navigation = nil
            page?.loading = false
            page?.finishedLoads += 1
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            ended(navigation)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            ended(navigation)
        }

        /// Only the bottom: the view itself starts at the top bar's lower edge, so the page's first
        /// line rests there with no inset and no offset to push it down.
        func apply(bottom: CGFloat, to view: WKWebView) {
            let scroll = view.scrollView
            let new = UIEdgeInsets(top: 0, left: 0, bottom: bottom, right: 0)
            guard new != scroll.contentInset else { return }
            scroll.contentInset = new
            scroll.verticalScrollIndicatorInsets = new
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            ended(navigation)
            if page?.selecting == true { page?.run("window.__duet && window.__duet.select(true)") }
            // The bars take the page's background (PageTint); the page reports it again if the
            // system scheme changes while it's open.
            page?.run("window.__duet && window.__duet.reportBackdrop()")
            guard let offset = restoreOffset else { return }
            restoreOffset = nil
            webView.scrollView.setContentOffset(offset, animated: false)
            // The changed passage glows by the page's CSS; bring it into view if it's off screen.
            page?.run("window.__duet && window.__duet.revealChanged(\(reduceMotion ? "false" : "true"))")
        }

        /// No sideways scroll, whatever the page's width.
        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            NativePanel.clamp(scrollView)
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .cancel }
            if url.scheme == "about" { return .allow }
            if action.navigationType == .linkActivated || action.targetFrame == nil { onLink(url) }
            return .cancel
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url { onLink(url) }
            return nil
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            switch message.name {
            case "duetSelect":
                guard let text = message.body as? String else { return }
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { onSelect(String(trimmed.prefix(280))) }
            case "duetBackdrop":
                guard let body = message.body as? [String: Any] else { return }
                func field(_ key: String) -> String? {
                    (body[key] as? String).map { String($0.prefix(120)) }.flatMap { $0.isEmpty ? nil : $0 }
                }
                let backdrop = PageBackdrop(body: field("body"), html: field("html"), theme: field("theme"))
                if page?.backdrop != backdrop { page?.backdrop = backdrop }
            default:
                break
            }
        }
    }

    /// Runs in the app's own content world (the page's CSP and scripts can't see or block it).
    static let bridge = """
    (function () {
      if (window.__duet) return;
      var selecting = false, outlined = null;
      function clear() { if (outlined) { outlined.style.outline = ''; outlined.style.outlineOffset = ''; outlined = null; } }
      document.addEventListener('click', function (e) {
        if (!selecting) return;
        e.preventDefault(); e.stopPropagation();
        var el = e.target && e.target.closest ? e.target.closest('p,li,h1,h2,h3,h4,td,th,blockquote,figcaption,section,article,div') : null;
        if (!el) return;
        clear(); outlined = el;
        el.style.outline = '2px solid #D65A45'; el.style.outlineOffset = '3px';
        var text = (el.innerText || '').trim();
        if (text) window.webkit.messageHandlers.duetSelect.postMessage(text.slice(0, 280));
      }, true);
      function cssColor(value) {
        try {
          var c = document.createElement('canvas').getContext('2d');
          if (!c) return null;
          c.fillStyle = '#010203'; c.fillStyle = value; var a = String(c.fillStyle);
          c.fillStyle = '#040506'; c.fillStyle = value; var b = String(c.fillStyle);
          return a === b ? a : null;
        } catch (e) { return null; }
      }
      function themeColor() {
        var metas = document.querySelectorAll('meta[name=theme-color]');
        for (var i = 0; i < metas.length; i++) {
          var media = metas[i].getAttribute('media');
          if (media && !window.matchMedia(media).matches) continue;
          var content = (metas[i].getAttribute('content') || '').trim();
          if (content) return cssColor(content);
        }
        return null;
      }
      var probe = null;
      function srgb(value) {
        // Any CSS colour (oklch, lab, display-p3...) painted on a 1x1 sRGB canvas and read back,
        // so the app only ever parses rgba(); the raw value if the canvas can't be used.
        if (!value) return null;
        try {
          if (!probe) { var cv = document.createElement('canvas'); cv.width = 1; cv.height = 1; probe = cv.getContext('2d', { willReadFrequently: true }); }
          if (!probe) return value;
          probe.clearRect(0, 0, 1, 1);
          probe.fillStyle = 'rgba(0,0,0,0)';
          probe.fillStyle = value;
          probe.fillRect(0, 0, 1, 1);
          var d = probe.getImageData(0, 0, 1, 1).data;
          return 'rgba(' + d[0] + ', ' + d[1] + ', ' + d[2] + ', ' + (d[3] / 255) + ')';
        } catch (e) { return value; }
      }
      function backdrop() {
        var handlers = window.webkit && window.webkit.messageHandlers;
        if (!handlers || !handlers.duetBackdrop) return;
        handlers.duetBackdrop.postMessage({
          body: document.body ? srgb(getComputedStyle(document.body).backgroundColor) : null,
          html: document.documentElement ? srgb(getComputedStyle(document.documentElement).backgroundColor) : null,
          theme: srgb(themeColor())
        });
      }
      try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', backdrop); } catch (e) {}
      // A theme switched by the page's own script (a class or style on html / body): read again,
      // at most every 200 ms.
      var pending = false;
      function soon() { if (pending) return; pending = true; setTimeout(function () { pending = false; backdrop(); }, 200); }
      try {
        var watch = new MutationObserver(soon);
        var options = { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] };
        watch.observe(document.documentElement, options);
        if (document.body) watch.observe(document.body, options);
      } catch (e) {}
      window.__duet = {
        select: function (on) { selecting = !!on; if (!on) clear(); },
        reportBackdrop: backdrop,
        heading: function (i, smooth) {
          var h = document.querySelectorAll('h1,h2,h3')[i];
          if (h) h.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
        },
        revealChanged: function (smooth) {
          var el = document.querySelector('[data-duet-changed]');
          if (!el) return;
          var r = el.getBoundingClientRect();
          if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
        }
      };
    })();
    """
}

/// The web view reaches under the app's chrome, which sets the scroll insets itself; reporting
/// no safe area keeps the page's `env(safe-area-inset-*)` padding at zero so the status bar and
/// home indicator aren't added a second time. M9: it also keeps the page at scale 1 (WebKit
/// resets the zoom limits from the viewport on each layout).
@MainActor
final class ChromeInsetWebView: WKWebView {
    override var safeAreaInsets: UIEdgeInsets { .zero }

    override func layoutSubviews() {
        super.layoutSubviews()
        NativePanel.lockZoom(scrollView)
    }
}

/// M9: what makes a web page feel like a panel of the app (artifacts, HTML files, the 4th tab).
@MainActor
enum NativePanel {
    /// The viewport and CSS of Make's base (contract §6), for pages made before it.
    static let viewport = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
    static let css = """
    html,body{overflow-x:hidden !important;max-width:100% !important;touch-action:pan-y;-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}    body{overflow-wrap:break-word}    img,svg,canvas,video,iframe{max-width:100% !important}    img,video{height:auto}    pre{max-width:100%;overflow-x:auto}    .duet-scroll-x{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y}    a,img{-webkit-touch-callout:none}
    """

    /// At document start: the CSS now, and once the page's own head is parsed our viewport last
    /// (so it wins over the page's) and wide tables in their own scrolling box.
    static let script = """
    (function () {
      var style = document.createElement('style');
      style.id = 'duet-native-panel';
      style.textContent = \(jsString(css));
      (document.head || document.documentElement).appendChild(style);
      function viewport() {
        var metas = document.querySelectorAll('meta[name="viewport"]');
        for (var i = 0; i < metas.length; i++) { if (metas[i].id !== 'duet-viewport') metas[i].remove(); }
        var meta = document.getElementById('duet-viewport');
        if (!meta) { meta = document.createElement('meta'); meta.id = 'duet-viewport'; meta.name = 'viewport'; }
        meta.content = \(jsString(viewport));
        (document.head || document.documentElement).appendChild(meta);
        if (style.parentNode !== document.head && document.head) document.head.appendChild(style);
      }
      function tables() {
        var all = document.querySelectorAll('table');
        for (var i = 0; i < all.length; i++) {
          var t = all[i], p = t.parentElement;
          if (!p || p.classList.contains('duet-scroll-x')) continue;
          var s = getComputedStyle(p).overflowX;
          if (s === 'auto' || s === 'scroll') continue;
          if (t.scrollWidth <= p.clientWidth + 1) continue;
          var box = document.createElement('div');
          box.className = 'duet-scroll-x';
          p.insertBefore(box, t);
          box.appendChild(t);
        }
      }
      viewport();
      document.addEventListener('DOMContentLoaded', function () { viewport(); tables(); });
      window.addEventListener('load', tables);
    })();
    """

    /// The same for a page that may not run scripts (shared HTML files): the meta and the style
    /// go in as markup, after the page's own head so ours win.
    static func inject(into html: String) -> String {
        let tags = "<meta name=\"viewport\" content=\"\(viewport)\"><style id=\"duet-native-panel\">\(css)</style>"
        if let head = html.range(of: "</head>", options: .caseInsensitive) {
            var out = html
            out.insert(contentsOf: tags, at: head.lowerBound)
            return out
        }
        return tags + html
    }

    /// The scroll view: vertical only, the app's own bounce, no zoom, insets set by hand.
    static func configure(_ scroll: UIScrollView, delegate: UIScrollViewDelegate) {
        // The chrome's insets are set by hand, so nothing is counted twice.
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.alwaysBounceVertical = true
        scroll.alwaysBounceHorizontal = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.isDirectionalLockEnabled = true
        scroll.delegate = delegate
        lockZoom(scroll)
        if #available(iOS 26, *) {
            // No system edge blur: file previews draw the app's own mask (Theme/ChromeBars.swift),
            // the Make viewer none at all (its bars take the page's colour).
            scroll.topEdgeEffect.isHidden = true
            scroll.bottomEdgeEffect.isHidden = true
        }
    }

    static func lockZoom(_ scroll: UIScrollView) {
        if scroll.minimumZoomScale != 1 { scroll.minimumZoomScale = 1 }
        if scroll.maximumZoomScale != 1 { scroll.maximumZoomScale = 1 }
        scroll.bouncesZoom = false
        scroll.pinchGestureRecognizer?.isEnabled = false
    }

    /// Back to the left edge if anything nudged the page sideways.
    static func clamp(_ scroll: UIScrollView) {
        if scroll.contentOffset.x != 0 {
            scroll.contentOffset = CGPoint(x: 0, y: scroll.contentOffset.y)
        }
    }

    private static func jsString(_ value: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [value])) ?? Data("[\"\"]".utf8)
        let array = String(decoding: data, as: UTF8.self)
        return String(array.dropFirst().dropLast())
    }
}

/// WKUserContentController keeps its handlers strongly; this breaks the cycle.
@MainActor
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any WKScriptMessageHandler)?

    init(_ target: any WKScriptMessageHandler) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
