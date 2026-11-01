// M27 W6: the landscape full screen of "OpenDuet's computer" (the owner's reference, 2026-10-30
// 00:45): the tab strip, the address row and the live frame are one block, laid out as upright
// and scaled up to the phone's height inside the safe area, centred across; ✕ in the left margin,
// Keyboard and Take over / Hand back in the right one. The bar is laid out at the scaled size
// (fonts, heights and paddings × scale), never scaleEffect, so text stays sharp and the field's
// caret and hit areas stay right. Also the bar's row heights (Dynamic Type, capped) and when the
// interface may turn. Pure Foundation (CoreGraphics types), host-tested.
import Foundation

/// The bar's sizes at scale 1 (upright): two rows of about 34 + 40 pt at the default text size,
/// growing with Dynamic Type up to accessibility1 and then stopping.
struct BrowserBarMetrics: Hashable, Sendable {
    static let tabRow: CGFloat = 34
    static let addressRow: CGFloat = 40
    static let tabFont: CGFloat = 13
    static let addressFont: CGFloat = 15
    /// UIKit's body sizes per text size (xSmall … accessibility5) over Large's 17 pt; the bar stops
    /// at accessibility1 (index 7).
    static let textFactors: [CGFloat] = [14, 15, 16, 17, 19, 21, 23, 28, 28, 28, 28, 28].map { $0 / 17 }
    static let largestIndex = 7

    /// The text size's growth (1 at Large), capped at accessibility1.
    var text: CGFloat
    /// The landscape full screen's scale (1 upright).
    var scale: CGFloat = 1

    init(typeSizeIndex: Int, scale: CGFloat = 1) {
        let index = min(max(typeSizeIndex, 0), Self.largestIndex)
        text = Self.textFactors[index]
        self.scale = scale
    }

    /// The rows never shrink below their default height (touch targets), and grow with the text.
    private var grow: CGFloat { max(text, 1) }
    var tabRowHeight: CGFloat { Self.tabRow * grow * scale }
    var addressRowHeight: CGFloat { Self.addressRow * grow * scale }
    var tabFontSize: CGFloat { Self.tabFont * text * scale }
    var addressFontSize: CGFloat { Self.addressFont * text * scale }
    /// Any other length of the bar (paddings, buttons, glyphs): × the text growth and the scale.
    func length(_ base: CGFloat) -> CGFloat { base * grow * scale }

    /// The bar's height at this scale for a layout.
    func height(_ layout: BrowserBarRules.Layout) -> CGFloat {
        switch layout {
        case .tabs: tabRowHeight + addressRowHeight
        case .addressOnly: addressRowHeight
        }
    }

    /// A tab's width: about 1/2.5 of the strip, between 96 and 200 pt (× scale).
    func tabWidth(row: CGFloat) -> CGFloat {
        min(max(row / 2.5, 96 * scale), 200 * scale)
    }
}

/// The landscape full screen's block, margins and keyboard row, in the safe area's coordinates.
enum FullScreenRules {
    /// The upright content's side padding (ComputerScreen: 16 pt on each side).
    static let uprightPadding: CGFloat = 16
    /// The narrowest margin the ✕ and the right column need (a 52 pt circle and its caption).
    static let minMargin: CGFloat = 88
    /// The remote keyboard's one row above the system keyboard, and its gap.
    static let keyboardRow: CGFloat = 44
    static let keyboardGap: CGFloat = 6
    /// Below this height the right column drops its captions (the circles keep their labels).
    static let captionsMinHeight: CGFloat = 240

    struct Input: Hashable, Sendable {
        /// inside the safe area (the landscape container)
        var container: CGSize
        /// the upright content width: the window's short side − 2 × 16
        var uprightWidth: CGFloat
        /// the bar's upright height (0 = no bar: Chrome's own is in the frames, or none shows)
        var barHeight: CGFloat
        /// the frame (frame_meta), any unit; zero = 16:10 until it is known
        var frame: CGSize
        /// the height above the system keyboard inside the container (nil = no keyboard)
        var visibleHeight: CGFloat? = nil
        /// the remote keyboard (ComputerKeyboardBar) is up: the bar steps aside and the frame
        /// fits above the keyboard's row
        var remoteTyping = false
    }

    struct Layout: Hashable, Sendable {
        /// the bar's scale (its fonts, heights and paddings)
        var scale: CGFloat
        /// the bar and the frame together
        var block: CGRect
        /// zero height when the bar doesn't show
        var bar: CGRect
        var frame: CGRect
        /// the remote keyboard's row (nil = not shown)
        var keyboardRow: CGRect?
        var leftMargin: CGRect
        var rightMargin: CGRect
        /// the ✕ and the right column are centred on this y (the middle of what the keyboard leaves)
        var controlsY: CGFloat
        /// the right column shows its captions
        var captions: Bool
    }

    /// height / width; 16:10 until the frame size is known.
    static func aspect(_ frame: CGSize) -> CGFloat {
        frame.width > 0 && frame.height > 0 ? frame.height / frame.width : 10.0 / 16.0
    }

    /// No keyboard: the upright block (uprightWidth × (bar + frame)) scaled to the height, centred.
    /// A narrower frame (portrait) keeps the bar at least at its upright size and fits the frame
    /// under it; the block never passes the margins. With the keyboard up:
    /// - the address field (or anything but the remote keyboard): the block stays as it is, top-
    ///   aligned, and the keyboard covers the page's lower part; the controls centre in what's left
    ///   (fitting the whole block above the keyboard would shrink the bar to ~0.6 of upright);
    /// - the remote keyboard: the bar steps aside and the frame alone fits above the keyboard's
    ///   row, which spans the block's width; ✕ and the column keep their places.
    static func layout(_ input: Input) -> Layout {
        let regular = block(input)
        let container = input.container
        guard let rawVisible = input.visibleHeight else {
            return Layout(
                scale: regular.scale, block: regular.block, bar: regular.bar, frame: regular.frame, keyboardRow: nil,
                leftMargin: margins(regular.block, container).left, rightMargin: margins(regular.block, container).right,
                controlsY: container.height / 2, captions: container.height >= captionsMinHeight
            )
        }
        let visible = min(max(rawVisible, 0), container.height)
        let side = margins(regular.block, container)
        guard input.remoteTyping else {
            return Layout(
                scale: regular.scale, block: regular.block, bar: regular.bar, frame: regular.frame, keyboardRow: nil,
                leftMargin: side.left, rightMargin: side.right,
                controlsY: visible / 2, captions: visible >= captionsMinHeight
            )
        }
        let rowTop = max(visible - keyboardGap - keyboardRow, 0)
        let row = CGRect(x: regular.block.minX, y: rowTop, width: regular.block.width, height: keyboardRow)
        let room = max(rowTop - keyboardGap, 0)
        let aspect = aspect(input.frame)
        let width = min(regular.block.width, room / aspect)
        let frame = CGRect(x: regular.block.midX - width / 2, y: 0, width: width, height: width * aspect)
        return Layout(
            scale: regular.scale, block: frame, bar: CGRect(x: frame.minX, y: 0, width: frame.width, height: 0), frame: frame,
            keyboardRow: row, leftMargin: side.left, rightMargin: side.right,
            controlsY: visible / 2, captions: visible >= captionsMinHeight
        )
    }

    private struct Block {
        var scale: CGFloat
        var block: CGRect
        var bar: CGRect
        var frame: CGRect
    }

    private static func block(_ input: Input) -> Block {
        let container = input.container
        let w0 = input.uprightWidth
        let b0 = max(input.barHeight, 0)
        let aspect = aspect(input.frame)
        guard container.width > 0, container.height > 0, w0 > 0 else {
            return Block(scale: 1, block: .zero, bar: .zero, frame: .zero)
        }
        let maxWidth = max(container.width - 2 * minMargin, 1)
        // the upright block (w0 × (b0 + w0 · aspect)) scaled to the height
        var scale = container.height / (b0 + w0 * aspect)
        var barHeight = b0 * scale
        var frameWidth = w0 * scale
        var barWidth = b0 > 0 ? w0 * scale : 0
        if b0 > 0, scale < 1 {
            // a portrait frame: the bar stays at its upright size, the frame fits under it
            scale = 1
            barHeight = b0
            barWidth = w0
            frameWidth = max(container.height - b0, 0) / aspect
        }
        let widest = max(barWidth, frameWidth)
        if widest > maxWidth {
            let shrink = maxWidth / widest
            scale *= shrink
            barHeight *= shrink
            barWidth *= shrink
            frameWidth *= shrink
        }
        let frameHeight = frameWidth * aspect
        let width = max(barWidth, frameWidth)
        let height = barHeight + frameHeight
        let block = CGRect(x: (container.width - width) / 2, y: max((container.height - height) / 2, 0), width: width, height: height)
        let bar = CGRect(x: block.midX - barWidth / 2, y: block.minY, width: barWidth, height: barHeight)
        let frame = CGRect(x: block.midX - frameWidth / 2, y: block.minY + barHeight, width: frameWidth, height: frameHeight)
        return Block(scale: scale, block: block, bar: bar, frame: frame)
    }

    private static func margins(_ block: CGRect, _ container: CGSize) -> (left: CGRect, right: CGRect) {
        (CGRect(x: 0, y: 0, width: max(block.minX, 0), height: container.height),
         CGRect(x: block.maxX, y: 0, width: max(container.width - block.maxX, 0), height: container.height))
    }

    /// Upright: the frame fitted to the content width right under the bar, top-aligned (the
    /// 1280 × 800 page is 361 × 225.6 pt on a 6.1" phone).
    static func uprightFrame(_ frame: CGSize, width: CGFloat, barHeight: CGFloat) -> CGRect {
        CGRect(x: 0, y: barHeight, width: width, height: width * aspect(frame))
    }
}

/// Which ways the interface may turn (App/Notifications.swift's OrientationLock reads this).
/// Portrait everywhere; "OpenDuet's computer" lets the phone turn it (spec L143: turning it sideways
/// is the landscape full screen); the full-screen button forces landscape until ✕, which goes back
/// to portrait at once and holds it there until the phone has been upright.
struct RotationRules: Hashable, Sendable {
    enum Mask: Hashable, Sendable {
        case portrait
        case landscape
        /// portrait and both landscapes (never upside down)
        case any
    }

    /// "OpenDuet's computer" is on screen
    private(set) var allowsLandscape = false
    /// the full-screen button: landscape whatever the phone does, until ✕
    private(set) var forced = false
    /// ✕ while the phone was sideways: portrait until the phone has been upright once
    private(set) var holdingPortrait = false

    var mask: Mask {
        guard allowsLandscape, !holdingPortrait else { return .portrait }
        return forced ? .landscape : .any
    }

    /// The view opened: always upright first (full screen isn't remembered); turning the phone may
    /// turn it.
    mutating func open() {
        allowsLandscape = true
        forced = false
        holdingPortrait = false
    }

    /// The view closed: portrait-only for the rest of the app.
    mutating func close() { self = RotationRules() }

    /// The full-screen button (also while the phone is held sideways).
    mutating func enterFullScreen() {
        guard allowsLandscape else { return }
        forced = true
        holdingPortrait = false
    }

    /// ✕ (or the escape gesture): portrait now; if the phone is sideways, it stays portrait until
    /// the phone has been upright.
    mutating func exitFullScreen(phoneUpright: Bool) {
        forced = false
        holdingPortrait = allowsLandscape && !phoneUpright
    }

    /// The phone moved: once it is upright the hold ends and turning it works again.
    mutating func phoneTurned(upright: Bool) {
        if upright { holdingPortrait = false }
    }
}
