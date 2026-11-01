// M26: where an HTML file's page sits in the file preview, the way the Make viewer does it
// (ArtifactViewer.content / bottomInset). The web view starts below the header (it no longer
// runs under it), so the page's first line, a fixed or sticky header and a 100vh layout all start
// at that edge with no top inset to wait for. It still reaches the screen bottom (under the soft
// edge over the home indicator); a bottom inset keeps its last line above it. Pure Foundation
// (host-tested); FilePreviewView and HTMLFileView use it.
import Foundation

enum FilePreviewLayout {
    /// The room kept below the page's last line once the web view reaches past the page.
    static let bottomAir: CGFloat = 8

    /// The web view's bottom inset (its top inset is always 0) from the page's frame (inside the
    /// header and the bottom safe area) and the web view's own (it ignores the bottom safe area),
    /// both global: how far the web view reaches past the page, plus `bottomAir`. 0 until both
    /// are measured, and when it doesn't reach past (less than half a point).
    static func bottomInset(page: CGRect, web: CGRect, air: CGFloat = bottomAir) -> CGFloat {
        guard page != .zero, web != .zero else { return 0 }
        let below = max(web.maxY - page.maxY, 0)
        return below > 0.5 ? below + air : 0
    }
}
