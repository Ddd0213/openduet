// The bubble side of the long-press menu (M9, ref-bubble-menu-form.png): a 0.35 s press on a user
// or the assistant text bubble gives a medium haptic and lifts it into the shell's overlay (BubbleMenuHost),
// which draws a copy of it over a blurred, dimmed screen with the emoji bar and the menu card. The
// bubble itself hides under its copy until the copy has settled back, and keeps the overlay told
// where it is (the thread may move meanwhile). VoiceOver gets the same actions on the bubble.
// Replaces M6's system .contextMenu (Make/MessageReactions.swift keeps the badges and failures).
import SwiftUI
import UIKit

extension View {
    /// The long-press menu of one text bubble. `reply`: the assistant's bubbles (quote it in this thread).
    func bubbleMenu(_ message: Message, tail: Bool = false, actions: ChatExtrasActions, reply: (() -> Void)? = nil) -> some View {
        modifier(BubbleMenuTrigger(message: message, tail: tail, actions: actions, reply: reply))
    }
}

/// The bubble's frame, kept outside SwiftUI state (it changes every scrolled frame).
@MainActor
private final class FrameBox {
    var frame: CGRect = .zero
}

private struct BubbleMenuTrigger: ViewModifier {
    var message: Message
    var tail: Bool
    var actions: ChatExtrasActions
    var reply: (() -> Void)?

    @Environment(\.bubbleMenu) private var center
    @State private var box = FrameBox()
    @State private var presses = 0

    func body(content: Content) -> some View {
        let lifted = center?.liftedId == message.id
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
                box.frame = frame
                if let center, center.liftedId == message.id { center.currentFrame = frame }
            }
            // The copy stands in for it while lifted; no fade, so the swap is invisible.
            .opacity(lifted ? 0 : 1)
            .animation(nil, value: lifted)
            .gesture(BubbleLongPressGesture(onPress: press))
            .sensoryFeedback(.impact(weight: .medium), trigger: presses)
            .modifier(BubbleMenuAccessibility(message: message, actions: actions, reply: reply, center: center))
    }

    private func press(_ safeArea: UIEdgeInsets) {
        guard let center, center.request == nil, center.sheet == nil, box.frame != .zero else { return }
        presses += 1
        // The keyboard goes, so the menu has the whole screen.
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        let id = message.id
        let actions = actions
        center.present(BubbleMenuRequest(
            message: message, origin: box.frame,
            safeArea: EdgeInsets(top: safeArea.top, leading: safeArea.left, bottom: safeArea.bottom, trailing: safeArea.right),
            tail: tail,
            react: { emoji, on in actions.react(id, emoji, on) },
            rate: { rating in actions.rate(id, rating) },
            reply: reply
        ))
    }
}

/// VoiceOver: the menu's actions straight on the bubble (no long press needed).
private struct BubbleMenuAccessibility: ViewModifier {
    var message: Message
    var actions: ChatExtrasActions
    var reply: (() -> Void)?
    var center: BubbleMenuCenter?

    @Environment(\.chatExtras) private var extras

    func body(content: Content) -> some View {
        content
            .accessibilityActions {
                if let reply {
                    Button { reply() } label: { Text("Reply") }
                }
                Button { copy() } label: { Text("Copy") }
                if center != nil {
                    Button { openSheet(.selectText) } label: { Text("Select text") }
                    Button { openSheet(.share) } label: { Text("Share") }
                }
                if message.role == .assistant {
                    if extras.ratings[message.id] != .good {
                        Button { actions.rate(message.id, .good) } label: { Text("Good response") }
                    }
                    if extras.ratings[message.id] != .bad {
                        Button { actions.rate(message.id, .bad) } label: { Text("Bad response") }
                    }
                }
                ForEach(["👍", "❤️"], id: \.self) { emoji in
                    let on = message.myReactions.contains(emoji)
                    Button { actions.react(message.id, emoji, !on) } label: { BubbleEmojiBar.label(emoji) }
                }
                if center != nil {
                    Button { openSheet(.picker) } label: { Text("Add a reaction") }
                }
            }
    }

    private func copy() {
        UIPasteboard.general.string = message.menuText
        AccessibilityNotification.Announcement(String(localized: "Copied")).post()
    }

    private func openSheet(_ kind: BubbleMenuSheet.Kind) {
        let id = message.id
        let actions = actions
        center?.sheet = BubbleMenuSheet(
            kind: kind, text: message.menuText, selected: message.myReactions,
            react: { emoji, on in actions.react(id, emoji, on) }
        )
    }
}

/// The lifted copy: the same bubble drawn again at the same width (static, not interactive).
struct BubbleMenuCopy: View {
    var message: Message
    var tail: Bool

    var body: some View {
        Group {
            if message.role == .user {
                UserBubble(text: message.text, tail: tail)
            } else if case .text(let payload) = message.content, let result = payload.taskResult {
                // M18: a task result lifts as itself (folded or expanded like the row, with its
                // footer), not as a plain bubble.
                TaskResultBubble(
                    messageId: message.id, text: message.text, result: result,
                    accessibilityLabel: Text(verbatim: ""), accessibilityText: "", onOpenTask: {}
                )
            } else {
                AssistantBubble(text: message.text)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
