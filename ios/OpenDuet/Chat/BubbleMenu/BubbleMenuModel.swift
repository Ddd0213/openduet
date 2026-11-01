// The bubble long-press menu's model (M9, ref-bubble-menu-form.png): what a pressed bubble hands to
// the shell's overlay (BubbleMenuHost), the shell-wide center that carries it, and the pure
// geometry of the lifted bubble, the emoji bar above it and the menu card below or above it.
import SwiftUI

/// One long-pressed bubble: the message, where it sits on screen, and what its menu can do.
struct BubbleMenuRequest: Identifiable {
    let id = UUID()
    var message: Message
    /// The bubble's frame in the window when it was pressed (the lift starts and ends there).
    var origin: CGRect
    /// The window's safe area (status bar, home indicator) when it was pressed.
    var safeArea: EdgeInsets
    /// A user bubble's tail (the lifted copy draws the same shape).
    var tail: Bool
    var react: (_ emoji: String, _ on: Bool) -> Void
    var rate: (FeedbackRequest.Rating) -> Void
    /// Reply in the thread the bubble is in (main, channel or task); nil for the user's bubbles.
    var reply: (() -> Void)?

    var isAssistant: Bool { message.role == .assistant }
}

/// The shell's one menu at a time. Bubbles find it in the environment (nil outside the shell:
/// previews, sheets), present a request on long press and, while lifted, keep its frame current
/// so the copy settles back where the bubble is now. The lifted bubble hides under its copy.
@MainActor
@Observable
final class BubbleMenuCenter {
    private(set) var request: BubbleMenuRequest?
    /// The message whose bubble is lifted right now (it hides while its copy is up).
    private(set) var liftedId: String?
    /// The lifted bubble's current frame (it can move if the thread scrolls meanwhile).
    @ObservationIgnored var currentFrame: CGRect = .zero
    /// The sheet a menu row (or a VoiceOver action) opened: the emoji picker, Select text, Share.
    var sheet: BubbleMenuSheet?

    /// False when another menu or one of its sheets is still up (M10: the press then gives no
    /// haptic, so it never feels like a menu that didn't open).
    @discardableResult
    func present(_ request: BubbleMenuRequest) -> Bool {
        guard self.request == nil, sheet == nil else { return false }
        currentFrame = request.origin
        liftedId = request.message.id
        self.request = request
        return true
    }

    /// M10: a sheet that went away without its binding being told (UIKit dismissed the share
    /// sheet itself) no longer counts as open.
    func sheetDisappeared(_ id: UUID) {
        if sheet?.id == id { sheet = nil }
    }

    /// The overlay has finished its way out: the bubble shows again.
    func finish(_ id: UUID) {
        guard request?.id == id else { return }
        request = nil
        liftedId = nil
    }
}

/// A sheet opened from a bubble's menu.
struct BubbleMenuSheet: Identifiable {
    enum Kind { case picker, selectText, share }

    let id = UUID()
    var kind: Kind
    /// The bubble's plain text (Select text, Share).
    var text: String = ""
    /// The emojis the user has on the bubble (the picker highlights them).
    var selected: Set<String> = []
    var react: (_ emoji: String, _ on: Bool) -> Void = { _, _ in }
}

extension Message {
    /// What Copy, Select text and Share use: the assistant's markdown without its markers, the user's
    /// text as typed.
    @MainActor
    var menuText: String {
        role == .assistant ? MarkdownCache.blocks(text).map(\.plainText).joined(separator: "\n\n") : text
    }

    /// The emojis the user put on this message.
    var myReactions: Set<String> {
        Set(reactions.filter { $0.by == .user }.map(\.emoji))
    }
}

extension EnvironmentValues {
    @Entry var bubbleMenu: BubbleMenuCenter? = nil
}

/// Where everything goes once lifted, in the window's coordinates.
struct BubbleMenuLayout: Equatable {
    /// The lifted copy (its height capped; taller bubbles are clipped with a fade).
    var bubble: CGRect
    var clipped: Bool
    var bar: CGRect
    var card: CGRect
    /// The card hangs below the bubble (else above the bar).
    var cardBelow: Bool

    static let margin: CGFloat = 16
    static let gap: CGFloat = 10
    static let barHeight: CGFloat = 52

    /// - `bounds`: the window's size; `insets`: its safe area plus a little air.
    static func make(origin: CGRect, bounds: CGSize, insets: EdgeInsets, cardSize: CGSize, isAssistant: Bool) -> BubbleMenuLayout {
        let top = insets.top + 8
        let bottom = bounds.height - insets.bottom - 8
        let room = max(bottom - top, 0)
        // The bubble shows at most what fits with the bar and the card (and at least a few lines).
        let maxBubble = max(room - barHeight - cardSize.height - gap * 2, 96)
        let height = min(origin.height, maxBubble)
        let clipped = height < origin.height - 0.5

        // Card below: bar, bubble, card from top to bottom. Card above: card, bar, bubble.
        let belowY = clamp(origin.minY, low: top + barHeight + gap, high: bottom - cardSize.height - gap - height)
        let aboveY = clamp(origin.minY, low: top + cardSize.height + gap + barHeight + gap, high: bottom - height)
        let fitsBelow = belowY + height + gap + cardSize.height <= bottom + 0.5
        let fitsAbove = aboveY - gap - barHeight - gap - cardSize.height >= top - 0.5
        let cardBelow: Bool
        switch (fitsBelow, fitsAbove) {
        case (true, false): cardBelow = true
        case (false, true): cardBelow = false
        default: cardBelow = abs(belowY - origin.minY) <= abs(aboveY - origin.minY)
        }
        let y = cardBelow ? belowY : aboveY
        let bubble = CGRect(x: origin.minX, y: y, width: origin.width, height: height)

        let bar = CGRect(x: margin, y: y - gap - barHeight, width: max(bounds.width - margin * 2, 0), height: barHeight)

        // The card lines up with the bubble's leading edge (the assistant) or trailing edge (the user's,
        // inside the tail), and stays on screen.
        let width = min(cardSize.width, bounds.width - margin * 2)
        let preferredX = isAssistant ? origin.minX : origin.maxX - UserBubbleShape.tailWidth - width
        let cardX = clamp(preferredX, low: margin, high: bounds.width - margin - width)
        let cardY = cardBelow ? bubble.maxY + gap : bar.minY - gap - cardSize.height
        let card = CGRect(x: cardX, y: cardY, width: width, height: cardSize.height)
        return BubbleMenuLayout(bubble: bubble, clipped: clipped, bar: bar, card: card, cardBelow: cardBelow)
    }

    private static func clamp(_ value: CGFloat, low: CGFloat, high: CGFloat) -> CGFloat {
        guard high >= low else { return low }
        return min(max(value, low), high)
    }
}
