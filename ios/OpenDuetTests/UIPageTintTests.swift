// The Make viewer's bar colour from the page (CSS colour parsing, body → html → theme-color → the
// app's background, the dark / light decision) and the shell's long edge fade.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Viewer bars: page colour")
struct UIPageTintTests {
    private func close(_ a: PageColor?, _ b: PageColor, _ tolerance: Double = 0.002) -> Bool {
        guard let a else { return false }
        return abs(a.red - b.red) < tolerance && abs(a.green - b.green) < tolerance
            && abs(a.blue - b.blue) < tolerance && abs(a.alpha - b.alpha) < tolerance
    }

    @Test("rgb / rgba with commas, spaces, percentages and a slash alpha")
    func parsesRGB() {
        #expect(close(PageTint.parse("rgb(255, 0, 0)"), PageColor(red: 1, green: 0, blue: 0)))
        #expect(close(PageTint.parse("rgba(0, 0, 0, 0.5)"), PageColor(red: 0, green: 0, blue: 0, alpha: 0.5)))
        #expect(close(PageTint.parse("  RGBA(12, 34, 56, 1) "), PageColor(red: 12 / 255, green: 34 / 255, blue: 56 / 255)))
        #expect(close(PageTint.parse("rgb(100% 50% 0% / 25%)"), PageColor(red: 1, green: 0.5, blue: 0, alpha: 0.25)))
        #expect(close(PageTint.parse("rgb(300, -4, 0)"), PageColor(red: 1, green: 0, blue: 0)))
        #expect(close(PageTint.parse("color(srgb 0.2 0.4 0.6 / 0.8)"), PageColor(red: 0.2, green: 0.4, blue: 0.6, alpha: 0.8)))
    }

    @Test("hex in 3, 4, 6 and 8 digits; transparent; junk is nil")
    func parsesHexAndJunk() {
        #expect(close(PageTint.parse("#fff"), PageColor(red: 1, green: 1, blue: 1)))
        #expect(close(PageTint.parse("#0C0C0C"), PageColor.appDark))
        #expect(close(PageTint.parse("#f008"), PageColor(red: 1, green: 0, blue: 0, alpha: 0x88 / 255)))
        #expect(close(PageTint.parse("#11223380"), PageColor(red: 0x11 / 255, green: 0x22 / 255, blue: 0x33 / 255, alpha: 0x80 / 255)))
        #expect(PageTint.parse("transparent")?.alpha == 0)
        #expect(PageTint.parse(nil) == nil)
        #expect(PageTint.parse("") == nil)
        #expect(PageTint.parse("#12") == nil)
        #expect(PageTint.parse("#ggg") == nil)
        #expect(PageTint.parse("oklch(0.5 0.1 200)") == nil)
        #expect(PageTint.parse("rgb(1, 2)") == nil)
        #expect(PageTint.parse("color(display-p3 1 0 0)") == nil)
    }

    @Test("body wins, then html, then theme-color, then the app's background")
    func order() {
        let navy = "rgb(10, 20, 60)"
        let white = "rgb(255, 255, 255)"
        let clear = "rgba(0, 0, 0, 0)"
        let base = PageColor.appLight
        #expect(close(PageTint.resolve(PageBackdrop(body: navy, html: white, theme: white), base: base), PageColor(red: 10 / 255, green: 20 / 255, blue: 60 / 255)))
        #expect(close(PageTint.resolve(PageBackdrop(body: clear, html: navy, theme: white), base: base), PageColor(red: 10 / 255, green: 20 / 255, blue: 60 / 255)))
        #expect(close(PageTint.resolve(PageBackdrop(body: clear, html: "transparent", theme: "#000"), base: base), PageColor(red: 0, green: 0, blue: 0)))
        #expect(PageTint.resolve(PageBackdrop(body: clear, html: clear, theme: nil), base: base) == base)
        #expect(PageTint.resolve(PageBackdrop(body: nil, html: nil, theme: "nonsense"), base: .appDark) == .appDark)
    }

    @Test("a see-through background is laid over html's and the app's, so the bars are opaque")
    func composites() {
        let half = PageTint.resolve(PageBackdrop(body: "rgba(0, 0, 0, 0.5)", html: clear, theme: "#f00"), base: PageColor(red: 1, green: 1, blue: 1))
        #expect(close(half, PageColor(red: 0.5, green: 0.5, blue: 0.5)))
        let stacked = PageTint.resolve(PageBackdrop(body: "rgba(255, 255, 255, 0.5)", html: "rgb(0, 0, 0)", theme: nil), base: .appLight)
        #expect(close(stacked, PageColor(red: 0.5, green: 0.5, blue: 0.5)))
        #expect(PageTint.over(PageColor(red: 0, green: 0, blue: 0, alpha: 0), PageColor(red: 0, green: 0, blue: 0, alpha: 0)).alpha == 0)
    }
    private var clear: String { "rgba(0, 0, 0, 0)" }

    @Test("dark when white text reads better than black (crossover near luminance 0.18)")
    func darkOrLight() {
        #expect(PageTint.isDark(.appDark))
        #expect(!PageTint.isDark(.appLight))
        #expect(PageTint.isDark(PageColor(red: 10 / 255, green: 20 / 255, blue: 60 / 255)))
        #expect(!PageTint.isDark(PageColor(red: 1, green: 0.85, blue: 0.4)))
        #expect(PageTint.isDark(PageColor(red: 0.30, green: 0.30, blue: 0.30)))
        #expect(!PageTint.isDark(PageColor(red: 0.60, green: 0.60, blue: 0.60)))
        #expect(abs(PageTint.luminance(PageColor(red: 1, green: 1, blue: 1)) - 1) < 1e-9)
        #expect(PageTint.luminance(PageColor(red: 0, green: 0, blue: 0)) == 0)
    }

    @Test("the small line keeps the app's grey where it reads and stays readable on mid-tone pages")
    func secondaryInk() {
        #expect(PageTint.secondaryInk(on: .appLight) == .greyLight)
        #expect(PageTint.secondaryInk(on: .appDark) == .greyDark)
        var tints: [PageColor] = stride(from: 0, through: 255, by: 5).map { PageColor(red: Double($0) / 255, green: Double($0) / 255, blue: Double($0) / 255) }
        tints += [PageColor.rgb(0x3B82F6), .rgb(0xEF4444), .rgb(0x10B981), .rgb(0xF59E0B), .rgb(0x8B5CF6), .rgb(0x0F172A), .rgb(0xFDE68A)]
        for tint in tints {
            let ink = PageTint.secondaryInk(on: tint)
            #expect(PageTint.contrast(ink, tint) >= 3, "tint \(tint)")
            #expect(abs(ink.alpha - 1) < 1e-9)
        }
    }

    @Test("non-ASCII digits are not hex")
    func asciiHexOnly() {
        #expect(PageTint.parse("#ｆｆｆ") == nil)
        #expect(PageTint.parse("#١٢٣") == nil)
    }
}

@Suite("Shell masks: long edge fade")
struct UIEdgeFadeTests {
    @Test("the shell header's mask is solid behind the status bar only and clear before the content rests")
    func top() {
        let span = EdgeFade.shellTop.span(height: 170)
        #expect(abs(span.near - 57.8) < 0.5)
        #expect(abs(span.far - 139.4) < 0.5)
        #expect(span.far < 170 - 24)
    }

    @Test("the bottom mask is solid behind the home indicator only; a stronger layer ends earlier")
    func bottom() {
        let span = EdgeFade.shellBottom.span(height: 174)
        #expect(abs(span.near - 38.3) < 0.5)
        #expect(abs(span.far - 135.7) < 0.5)
        let strong = EdgeFade.shellBottom.span(height: 174, layer: 0.45)
        #expect(strong.near == span.near)
        #expect(strong.far < span.far && strong.far > strong.near)
        let empty = EdgeFade.shellTop.span(height: 0)
        #expect(empty.near == 0 && empty.far == 0)
    }
}
