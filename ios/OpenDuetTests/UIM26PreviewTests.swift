// M26: an HTML file in the file preview sits below the header (FilePreviewLayout): the web view
// gets a bottom inset only, measured from how far it reaches past the page (under the soft edge
// over the home indicator), and nothing at the top, so a sticky header or a 100vh page can't
// start under the header and nothing waits for a top inset before the page loads.
import CoreGraphics
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("File preview: HTML below the header (M26)")
struct UIM26PreviewTests {
    @Test("no inset until both frames are measured")
    func unmeasured() {
        let page = CGRect(x: 0, y: 116, width: 402, height: 702)
        #expect(FilePreviewLayout.bottomInset(page: .zero, web: .zero) == 0)
        #expect(FilePreviewLayout.bottomInset(page: page, web: .zero) == 0)
        #expect(FilePreviewLayout.bottomInset(page: .zero, web: page) == 0)
    }

    @Test("portrait and landscape: how far the web view reaches past the page, plus the air")
    func reachesPastThePage() {
        // Portrait (402 × 874): the page ends 16 pt (the soft edge) above the home indicator's
        // 34 pt; the web view, ignoring the bottom safe area only, reaches the screen bottom.
        let page = CGRect(x: 0, y: 116, width: 402, height: 708)
        let web = CGRect(x: 0, y: 116, width: 402, height: 758)
        #expect(FilePreviewLayout.bottomInset(page: page, web: web) == 50 + FilePreviewLayout.bottomAir)
        // Landscape (874 × 402, inset sideways by the notch): 21 pt home indicator + 16 pt edge.
        let wide = CGRect(x: 62, y: 66, width: 750, height: 299)
        let wideWeb = CGRect(x: 62, y: 66, width: 750, height: 336)
        #expect(FilePreviewLayout.bottomInset(page: wide, web: wideWeb) == 37 + FilePreviewLayout.bottomAir)
    }

    @Test("the top never counts: the web view starts at the header's lower edge")
    func topIgnored() {
        let page = CGRect(x: 0, y: 116, width: 402, height: 708)
        let web = CGRect(x: 0, y: 116, width: 402, height: 758)
        // The old layout ran the web view from the screen top; its top edge doesn't change the
        // bottom inset, and there is no top inset to compute at all.
        let underHeader = CGRect(x: 0, y: 0, width: 402, height: 874)
        #expect(FilePreviewLayout.bottomInset(page: page, web: underHeader) == FilePreviewLayout.bottomInset(page: page, web: web))
    }

    @Test("no inset when the web view ends with the page (under half a point)")
    func endsWithThePage() {
        let page = CGRect(x: 0, y: 116, width: 402, height: 708)
        #expect(FilePreviewLayout.bottomInset(page: page, web: page) == 0)
        #expect(FilePreviewLayout.bottomInset(page: page, web: CGRect(x: 0, y: 116, width: 402, height: 708.4)) == 0)
        #expect(FilePreviewLayout.bottomInset(page: page, web: CGRect(x: 0, y: 116, width: 402, height: 600)) == 0)
        #expect(FilePreviewLayout.bottomInset(page: page, web: CGRect(x: 0, y: 116, width: 402, height: 718), air: 0) == 10)
    }
}
