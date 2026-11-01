// M27 W6: the landscape full screen (Computer/FullScreenRules.swift): the bar and the frame as
// one block scaled to the phone's height, ✕ and the right column in the margins, with and without
// the keyboard; the bar's heights (Dynamic Type, capped); when the interface may turn; input as
// fractions of the shown frame at any scale; the 16:10 cards. The safe areas are estimates (an
// iPhone 15 turned: 852 × 393 pt, about 734 × 372 inside; a 16 Pro Max: 956 × 440, about
// 832 × 419); the owner measures them on the phones.
import CoreGraphics
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private func near(_ a: CGFloat, _ b: CGFloat, _ tolerance: CGFloat = 0.5) -> Bool { abs(a - b) < tolerance }

private struct Phone {
    var container: CGSize
    var upright: CGFloat
    /// the system keyboard's top inside the container, landscape (estimate)
    var keyboardVisible: CGFloat
}

private let iPhone15 = Phone(container: CGSize(width: 734, height: 372), upright: 393 - 32, keyboardVisible: 184)
private let iPhone16ProMax = Phone(container: CGSize(width: 832, height: 419), upright: 440 - 32, keyboardVisible: 200)
private let page = CGSize(width: 1280, height: 800)
private let uprightBar = BrowserBarMetrics.tabRow + BrowserBarMetrics.addressRow

private func layout(_ phone: Phone, bar: CGFloat = uprightBar, frame: CGSize = page, keyboard: Bool = false, remote: Bool = false) -> FullScreenRules.Layout {
    FullScreenRules.layout(FullScreenRules.Input(
        container: phone.container, uprightWidth: phone.upright, barHeight: bar, frame: frame,
        visibleHeight: keyboard ? phone.keyboardVisible : nil, remoteTyping: remote
    ))
}

@Suite("M27 W6 landscape full screen")
struct UIM27FullScreenLayoutTests {
    @Test("iPhone 15 turned: the 361 × 300 block scaled 1.24 to 448 × 372, ~143 pt each side")
    func iPhone15Turned() {
        let l = layout(iPhone15)
        #expect(near(l.scale, 372.0 / (74 + 361 * 0.625), 0.001))
        #expect(near(l.scale, 1.24, 0.01))
        // 361 × 1.2416 = 448.2
        #expect(near(l.block.width, 448.2) && near(l.block.height, 372))
        #expect(near(l.bar.height, 74 * l.scale) && near(l.bar.width, l.block.width))
        #expect(near(l.frame.minY, l.bar.maxY) && near(l.frame.width, l.block.width) && near(l.frame.height, l.frame.width * 0.625))
        #expect(near(l.block.minY, 0) && near(l.block.midX, 367))
        #expect(near(l.leftMargin.width, 142.9) && near(l.rightMargin.width, 142.9))
        #expect(l.leftMargin.width >= FullScreenRules.minMargin)
        #expect(near(l.controlsY, 186) && l.captions && l.keyboardRow == nil)
    }

    @Test("16 Pro Max turned: 408 × 329 scaled 1.27 to 520 × 419, ~156 pt each side")
    func iPhone16ProMaxTurned() {
        let l = layout(iPhone16ProMax)
        #expect(near(l.scale, 419.0 / (74 + 408 * 0.625), 0.001))
        #expect(near(l.block.width, 519.6) && near(l.block.height, 419))
        #expect(near(l.leftMargin.width, 156.2) && near(l.rightMargin.width, 156.2))
    }

    @Test("The address field's keyboard: the block stays; the controls centre above the keyboard")
    func addressKeyboard() {
        for phone in [iPhone15, iPhone16ProMax] {
            let plain = layout(phone)
            let typing = layout(phone, keyboard: true)
            #expect(typing.block == plain.block)
            #expect(typing.bar == plain.bar)
            #expect(typing.frame == plain.frame)
            #expect(typing.scale == plain.scale)
            #expect(typing.keyboardRow == nil)
            #expect(near(typing.controlsY, phone.keyboardVisible / 2))
            #expect(!typing.captions)
            #expect(typing.leftMargin == plain.leftMargin)
            #expect(typing.rightMargin == plain.rightMargin)
        }
    }

    @Test("The remote keyboard: the bar steps aside, the frame fits above the keyboard's row")
    func remoteKeyboard() {
        let plain = layout(iPhone15)
        let l = layout(iPhone15, keyboard: true, remote: true)
        let row = l.keyboardRow ?? .zero
        #expect(near(row.minY, 184 - 6 - 44) && near(row.height, 44))
        #expect(near(row.minX, plain.block.minX) && near(row.width, plain.block.width))
        #expect(l.bar.height == 0)
        #expect(near(l.frame.minY, 0) && near(l.frame.height, 134 - 6) && near(l.frame.width, 128 / 0.625))
        #expect(l.frame.maxY <= row.minY)
        #expect(near(l.frame.midX, plain.block.midX))
        // ✕ and the column keep their places
        #expect(l.leftMargin == plain.leftMargin)
        #expect(l.rightMargin == plain.rightMargin)
        let big = layout(iPhone16ProMax, keyboard: true, remote: true)
        #expect(near(big.frame.height, 200 - 6 - 44 - 6) && near(big.frame.width, 144 / 0.625))
    }
}

@Suite("M27 W6 landscape full screen: other frames")
struct UIM27FullScreenFrameTests {
    @Test("An older computer: the address-only row and the frame, scaled the same way")
    func olderComputer() {
        let l = layout(iPhone15, bar: BrowserBarMetrics.addressRow)
        let scale = 372.0 / (40 + 361 * 0.625)
        #expect(near(l.scale, scale, 0.001))
        #expect(near(l.bar.height, 40 * scale) && near(l.block.width, 361 * scale) && near(l.block.height, 372))
        #expect(near(l.leftMargin.width, (734 - 361 * scale) / 2))
    }

    @Test("Headed (Chrome's own bar in the frames): the frame alone, as large as the margins allow")
    func headed() {
        let l = layout(iPhone15, bar: 0)
        #expect(l.bar.height == 0)
        #expect(near(l.frame.width, 734 - 2 * 88) && near(l.frame.height, (734 - 176) * 0.625))
        #expect(near(l.frame.midY, 186) && near(l.leftMargin.width, 88))
        // a headed portrait window (860 × 1600): fitted to the height, narrower
        let window = layout(iPhone15, bar: 0, frame: CGSize(width: 860, height: 1600))
        #expect(near(window.frame.height, 372) && near(window.frame.width, 372 * 860 / 1600))
    }

    @Test("A portrait page (430 × 660): the bar stays at its upright size, the frame fits under it")
    func portraitPage() {
        let l = layout(iPhone15, frame: CGSize(width: 430, height: 660))
        #expect(l.scale == 1)
        #expect(near(l.bar.width, 361) && near(l.bar.height, 74))
        #expect(near(l.frame.height, 372 - 74) && near(l.frame.width, 298 * 430 / 660))
        #expect(near(l.frame.midX, l.bar.midX) && near(l.frame.minY, 74))
    }

    @Test("Before frame_meta the frame is 16:10; nothing for an empty container")
    func edges() {
        #expect(FullScreenRules.aspect(.zero) == 0.625)
        let none = FullScreenRules.layout(FullScreenRules.Input(container: .zero, uprightWidth: 361, barHeight: 74, frame: page))
        #expect(none.block == .zero && none.frame == .zero)
    }
}

@Suite("M27 W6 bar sizes and rotation")
struct UIM27BarSizeRotationTests {
    @Test("The bar: 34 + 40 pt at Large, growing to accessibility1 and stopping there")
    func dynamicType() {
        let large = BrowserBarMetrics(typeSizeIndex: 3)
        #expect(large.height(.tabs) == 74 && large.height(.addressOnly) == 40)
        let ax1 = BrowserBarMetrics(typeSizeIndex: 7)
        #expect(near(ax1.height(.tabs), 74 * 28 / 17))
        #expect(BrowserBarMetrics(typeSizeIndex: 11) == ax1)
        // smaller text: smaller fonts, the rows keep their touch height
        let small = BrowserBarMetrics(typeSizeIndex: 0)
        #expect(small.height(.tabs) == 74 && small.tabFontSize < large.tabFontSize)
        // landscape: everything × the scale
        let scaled = BrowserBarMetrics(typeSizeIndex: 3, scale: 1.24)
        #expect(near(scaled.height(.tabs), 74 * 1.24, 0.01) && near(scaled.addressFontSize, 15 * 1.24, 0.01))
        #expect(near(large.tabWidth(row: 361 - 44), 126.8, 0.01) && large.tabWidth(row: 200) == 96 && large.tabWidth(row: 900) == 200)
    }

    @Test("Turning: the phone turns the view; the button forces landscape until ✕; ✕ holds portrait until upright")
    func rotation() {
        var rules = RotationRules()
        #expect(rules.mask == .portrait)
        rules.enterFullScreen()
        #expect(rules.mask == .portrait)
        rules.open()
        #expect(rules.mask == .any)
        rules.enterFullScreen()
        #expect(rules.mask == .landscape)
        rules.phoneTurned(upright: true)
        #expect(rules.mask == .landscape)
        rules.exitFullScreen(phoneUpright: true)
        #expect(rules.mask == .any)
        // ✕ while the phone is held sideways: portrait at once, landscape again after upright
        rules.enterFullScreen()
        rules.exitFullScreen(phoneUpright: false)
        #expect(rules.mask == .portrait)
        rules.phoneTurned(upright: false)
        #expect(rules.mask == .portrait)
        // the button while the phone is held sideways
        rules.enterFullScreen()
        #expect(rules.mask == .landscape)
        rules.exitFullScreen(phoneUpright: false)
        rules.phoneTurned(upright: true)
        #expect(rules.mask == .any)
        // closing "OpenDuet's computer": portrait-only, and it opens upright next time
        rules.enterFullScreen()
        rules.close()
        #expect(rules.mask == .portrait)
        rules.open()
        #expect(rules.mask == .any)
    }
}

@Suite("M27 W6 input and cards")
struct UIM27FullScreenInputTests {
    @Test("Upright the 1280 × 800 page fits the width right under the bar, at the top")
    func uprightUnderTheBar() {
        #expect(FullScreenRules.uprightFrame(page, width: 361, barHeight: 74) == CGRect(x: 0, y: 74, width: 361, height: 225.625))
        let fit = ComputerGeometry.screenFit(frame: page, in: CGSize(width: 361, height: 492))
        #expect(fit.size == CGSize(width: 361, height: 225.625) && fit.topAligned && fit.startZoom == 1)
    }

    @Test("A tap is a fraction of the shown frame, upright and in landscape at its scale")
    func tapFractions() throws {
        let upright = CGSize(width: 361, height: 225.625)
        let landscape = layout(iPhone15).frame.size
        #expect(near(landscape.width / upright.width, layout(iPhone15).scale, 0.001))
        for shown in [upright, landscape] {
            let point = try #require(ComputerGeometry.fraction(of: CGPoint(x: shown.width * 0.25, y: shown.height * 0.5), in: shown))
            #expect(abs(point.x - 0.25) < 0.0001 && abs(point.y - 0.5) < 0.0001)
            // a swipe over the whole shown height scrolls 800 page pixels at any scale
            let step = ComputerGeometry.scroll(translation: CGSize(width: 0, height: -shown.height), shown: shown, page: page)
            #expect(abs(step.dy - 800) < 0.01)
        }
    }

    @Test("Cards stay 16:10: 1280 × 800 fills the box exactly; 430 × 660 fits the width, bottom cropped")
    func cards() {
        let box = CGSize(width: 320, height: 200)
        #expect(ComputerGeometry.cardFill(frame: page, in: box) == CGRect(x: 0, y: 0, width: 320, height: 200))
        let portrait = ComputerGeometry.cardFill(frame: CGSize(width: 430, height: 660), in: box)
        #expect(portrait.minX == 0 && portrait.minY == 0 && near(portrait.width, 320))
        #expect(near(portrait.height, 320 * 660 / 430) && portrait.height > box.height)
    }
}
