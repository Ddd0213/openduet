// M20b (plan §3b): the whole-window stream. A portrait frame (the Chrome window, about 860×1600)
// in the full-screen "OpenDuet's computer" (ComputerGeometry.screenFit) and in the chat's live
// browser card / the computer page's 16:10 preview (cardFill); input stays 0...1 fractions of the
// whole frame. M27 W6: the 1280 × 800 page (the default since C2) sits at the top, right under
// the app's own bar, and starts at the full width when the keyboard leaves too little height.
import CoreGraphics
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private var window: CGSize { CGSize(width: 860, height: 1600) }
private var page: CGSize { CGSize(width: 1280, height: 800) }

private func near(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) < 0.01 }
private func near(_ a: CGSize, _ b: CGSize) -> Bool { near(a.width, b.width) && near(a.height, b.height) }

@Suite("Computer screen fit (M20b)")
struct UIComputerScreenFitTests {
    @Test func landscapePageSitsUnderTheBar() {
        // M27 W6: upright under the bar, upright with the address field's keyboard, the landscape
        // full screen's frame rect: fitted, at the top (no longer centred), not zoomed in
        for container in [CGSize(width: 361, height: 567), CGSize(width: 361, height: 165), CGSize(width: 448, height: 280)] {
            let fit = ComputerGeometry.screenFit(frame: page, in: container)
            #expect(fit.size == ComputerGeometry.fitted(frame: page, in: container))
            #expect(fit.topAligned)
            #expect(fit.startZoom == 1)
            #expect(fit.maxZoom == 4)
            #expect(fit.doubleTapZoom == 2.5)
            #expect(ComputerGeometry.screenFit(frame: page, in: container, landscape: true) == fit)
        }
    }

    @Test func landscapePageStartsAtTheFullWidthWhenTheKeyboardLeavesTooLittle() {
        // M27 W6: upright with the remote keyboard up, about 90 pt are left: shrunk it would be
        // 144 pt wide (0.4 of the width), so it starts at the full width from the top and pans
        let container = CGSize(width: 361, height: 90)
        let fit = ComputerGeometry.screenFit(frame: page, in: container)
        #expect(near(fit.size, CGSize(width: 144, height: 90)))
        #expect(fit.topAligned)
        #expect(near(fit.size.width * fit.startZoom, 361))
        #expect(near(fit.doubleTapZoom, fit.startZoom))
        // sideways the frame has its own rect: never zoomed in at the start
        #expect(ComputerGeometry.screenFit(frame: page, in: container, landscape: true).startZoom == 1)
    }

    @Test func portraitWindowFitsTheWidthWhenItFits() {
        let fit = ComputerGeometry.screenFit(frame: window, in: CGSize(width: 361, height: 800))
        #expect(near(fit.size, CGSize(width: 361, height: 361.0 * 1600 / 860)))
        #expect(fit.topAligned)
        #expect(fit.startZoom == 1)
    }

    @Test func portraitWindowShrinksToShowAllOfIt() {
        // iPhone 15 portrait while OpenDuet drives: 567 pt tall, so about 305 pt wide, all of it shows
        let fit = ComputerGeometry.screenFit(frame: window, in: CGSize(width: 361, height: 567))
        #expect(near(fit.size, CGSize(width: 567.0 * 860 / 1600, height: 567)))
        #expect(fit.topAligned)
        #expect(fit.startZoom == 1)
        #expect(fit.maxZoom == 4)
        #expect(fit.doubleTapZoom == 2.5)
    }

    @Test func tooSmallStartsAtTheFullWidthFromTheTop() {
        // portrait with the keyboard up: shrunk to 165 pt it would be about 89 pt wide
        let fit = ComputerGeometry.screenFit(frame: window, in: CGSize(width: 361, height: 165))
        #expect(near(fit.size.height, 165))
        #expect(fit.topAligned)
        #expect(near(fit.size.width * fit.startZoom, 361))
        #expect(near(fit.maxZoom, fit.startZoom * 2))
        #expect(near(fit.doubleTapZoom, fit.startZoom))
    }

    @Test func minimumShrinkIsTheLine() {
        let width: CGFloat = 400
        let line = width * ComputerGeometry.minimumShrink * 1600 / 860
        #expect(ComputerGeometry.screenFit(frame: window, in: CGSize(width: width, height: line + 2)).startZoom == 1)
        #expect(ComputerGeometry.screenFit(frame: window, in: CGSize(width: width, height: line - 2)).startZoom > 1)
    }

    @Test func landscapePhoneFitsTheHeight() {
        let container = CGSize(width: 812, height: 330)
        let fit = ComputerGeometry.screenFit(frame: window, in: container, landscape: true)
        #expect(near(fit.size, CGSize(width: 330.0 * 860 / 1600, height: 330)))
        #expect(fit.topAligned)
        #expect(fit.startZoom == 1)
        #expect(fit.maxZoom == 4)
        // the same box held upright (keyboard up) would count as too small
        #expect(ComputerGeometry.screenFit(frame: window, in: container).startZoom > 1)
    }

    @Test func emptyFrameOrViewIsZero() {
        #expect(ComputerGeometry.screenFit(frame: .zero, in: CGSize(width: 361, height: 567)).size == .zero)
        let none = ComputerGeometry.screenFit(frame: window, in: .zero)
        #expect(none.size == .zero)
        #expect(none.startZoom == 1)
    }

    @Test func inputIsAFractionOfTheWholeWindow() throws {
        // Points are measured on the image at zoom 1 (the fit's size), whatever the zoom or pan.
        for container in [CGSize(width: 361, height: 567), CGSize(width: 361, height: 165)] {
            let size = ComputerGeometry.screenFit(frame: window, in: container).size
            // a tab in the tab strip at the very top of the window
            let tab = try #require(ComputerGeometry.fraction(of: CGPoint(x: size.width * 0.2, y: size.height * 0.03), in: size))
            #expect(abs(tab.x - 0.2) < 0.0001 && abs(tab.y - 0.03) < 0.0001)
            #expect(ComputerGeometry.fraction(of: CGPoint(x: size.width, y: size.height), in: size) == ComputerClientMessage.Point(x: 1, y: 1))
            // a one-finger scroll over the whole shown height scrolls the window's height in frame pixels
            let step = ComputerGeometry.scroll(translation: CGSize(width: 0, height: -size.height), shown: size, page: window)
            #expect(abs(step.dy - 1600) < 0.01)
            #expect(abs(step.dx) < 0.0001)
        }
    }
}

@Suite("Computer card fill (M20b)")
struct UIComputerCardFillTests {
    private var box: CGSize { CGSize(width: 320, height: 200) }

    @Test func pageFillsTheBox() {
        #expect(ComputerGeometry.cardFill(frame: page, in: box) == CGRect(x: 0, y: 0, width: 320, height: 200))
    }

    @Test func portraitWindowFitsTheBoxWidthTopAligned() {
        let rect = ComputerGeometry.cardFill(frame: window, in: box)
        #expect(near(rect.minX, 0))
        #expect(rect.minY == 0)
        #expect(near(rect.width, 320))
        #expect(near(rect.height, 320 * 1600 / 860))
        // the bottom is cropped by the box
        #expect(rect.height > box.height)
    }

    @Test func widerThanTheBoxIsCentredAcross() {
        let rect = ComputerGeometry.cardFill(frame: CGSize(width: 2000, height: 800), in: box)
        #expect(rect.minY == 0)
        #expect(near(rect.height, 200))
        #expect(near(rect.width, 500))
        #expect(near(rect.minX, -90))
    }

    @Test func emptyIsZero() {
        #expect(ComputerGeometry.cardFill(frame: .zero, in: box) == .zero)
        #expect(ComputerGeometry.cardFill(frame: window, in: .zero) == .zero)
    }
}
