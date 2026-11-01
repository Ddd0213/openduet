// The side menu's slide (prompt L123, L186): ≡ slides the menu in from the left at ~80% of the
// width while the chat moves right with rounded corners and a dimmed edge; a tap on the dimmed
// chat or a swipe to the left closes it, following the finger. M19: on the Chat tab a pull from
// the screen's left edge opens it, following the finger (`canOpen`, MenuEdgePan): past a third
// of the menu's width or on a flick it opens (`onOpen`), otherwise it springs back. During the
// slide only the offset and the dim change: the chat's corner radius is fixed while it is away
// from rest (no clip re-drawn every frame), and the header mascot holds still (`mascotPaused`).
// With Reduce Motion nothing slides: the menu crossfades in over the dimmed chat.
import SwiftUI

enum SideMenuMotion {
    /// The open / close slide; selecting a channel waits for it (MainShellView.selectChannel).
    static func animation(reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.4, dampingFraction: 0.88)
    }
}

struct SideMenuContainer<Content: View, Menu: View>: View {
    var isOpen: Bool
    var onClose: () -> Void
    /// The edge pull may open the menu (Chat tab, nothing covering the chat).
    var canOpen = false
    var onOpen: () -> Void = {}
    @ViewBuilder var content: Content
    @ViewBuilder var menu: Menu

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var width: CGFloat = 390
    /// The finger's pull to the left while open (negative).
    @State private var drag: CGFloat = 0
    /// M19: the edge pull to the right while closed (positive).
    @State private var pull: CGFloat = 0
    /// M19: closed and settled (no slide, no pull): the chat is drawn without the clip's radius
    /// and the mascot moves.
    @State private var resting = true
    /// Top and bottom safe-area insets, so the chat's rounded corners sit at the screen corners.
    @State private var insets = EdgeInsets()

    private var menuWidth: CGFloat { (width * Metrics.menuWidthFraction).rounded() }

    /// 0 closed ... 1 open, following the finger.
    private var progress: CGFloat {
        guard isOpen else { return min(max(pull / menuWidth, 0), 1) }
        return min(max(1 + drag / menuWidth, 0), 1)
    }

    /// Nothing moves and the menu is shut.
    private var atRest: Bool { resting && !isOpen && pull == 0 }

    var body: some View {
        ZStack(alignment: .leading) {
            if reduceMotion {
                content
                    .overlay { dim }
                    .accessibilityHidden(isOpen)
                if isOpen {
                    menu
                        .frame(width: menuWidth)
                        .transition(.opacity)
                }
            } else {
                menu
                    .frame(width: menuWidth)
                    .offset(x: -menuWidth * 0.3 * (1 - progress))
                    .opacity(progress > 0 ? 1 : 0)
                    .accessibilityHidden(!isOpen)
                content
                    .environment(\.mascotPaused, !atRest)
                    .overlay { dim }
                    .clipShape(chatShape)
                    .overlay {
                        chatShape
                            .stroke(Palette.hairline, lineWidth: Metrics.hairline)
                            .opacity(atRest ? 0 : 1)
                            .allowsHitTesting(false)
                    }
                    .offset(x: menuWidth * progress)
                    .accessibilityHidden(isOpen)
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = max($0, 1) }
        .onGeometryChange(for: EdgeInsets.self) { $0.safeAreaInsets } action: { insets = $0 }
        .simultaneousGesture(closeSwipe, including: isOpen ? .all : .subviews)
        .gesture(MenuEdgePan(isEnabled: canOpen && !isOpen, onChange: pullChanged, onEnd: pullEnded))
        .animation(SideMenuMotion.animation(reduceMotion: reduceMotion), value: isOpen)
        .onChange(of: isOpen) { _, _ in
            drag = 0
            pull = 0
            resting = false
        }
        .task(id: isOpen) {
            // Settled once the close slide is over (a little longer than the spring's response).
            guard !isOpen, !resting else { return }
            try? await Task.sleep(for: .milliseconds(450))
            if !Task.isCancelled, !isOpen { resting = true }
        }
    }

    /// The chat's outline while it is away from rest: the corners reach the physical screen
    /// corners, past the safe area the shell lays out in. The radius doesn't animate: it is set
    /// when the slide starts (the chat is still at the screen's own rounded corners then).
    private var chatShape: ScreenRoundedRect {
        ScreenRoundedRect(cornerRadius: atRest ? 0 : Metrics.menuContentCorner, top: insets.top, bottom: insets.bottom)
    }

    private var dim: some View {
        Palette.menuDim
            .opacity(progress)
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture(perform: onClose)
            .allowsHitTesting(isOpen)
            .accessibilityHidden(true)
    }

    private var closeSwipe: some Gesture {
        DragGesture(minimumDistance: 14)
            .onChanged { value in
                guard isOpen, !reduceMotion, abs(value.translation.width) > abs(value.translation.height) else { return }
                drag = min(value.translation.width, 0)
            }
            .onEnded { value in
                guard isOpen else { return }
                let closes = PushStackRules.swipeCommits(
                    translation: -value.translation.width, projected: -value.predictedEndTranslation.width, length: menuWidth
                )
                if closes {
                    onClose()
                } else {
                    withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) { drag = 0 }
                }
            }
    }

    // MARK: - Edge pull (M19)

    private func pullChanged(_ dx: CGFloat) {
        guard !isOpen else { return }
        resting = false
        // With Reduce Motion the menu doesn't follow the finger; the release still decides.
        if !reduceMotion { pull = min(dx, menuWidth) }
    }

    private func pullEnded(_ dx: CGFloat, _ projected: CGFloat) {
        guard !isOpen else { return }
        if PushStackRules.swipeCommits(translation: dx, projected: projected, length: menuWidth) {
            // isOpen and the pull change in one update: the spring takes the chat on from where
            // the finger left it.
            onOpen()
            pull = 0
        } else if pull > 0 {
            withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) { pull = 0 } completion: {
                if !isOpen && pull == 0 { resting = true }
            }
        } else {
            resting = true
        }
    }
}

/// A rounded rectangle grown past the top and bottom safe areas, so the clip's corners are the
/// screen's corners while the shell itself lays out inside the safe area. M19: not animatable, so
/// a radius change never re-draws the clip on every frame of a slide.
struct ScreenRoundedRect: Shape {
    var cornerRadius: CGFloat
    var top: CGFloat
    var bottom: CGFloat

    func path(in rect: CGRect) -> Path {
        let grown = CGRect(x: rect.minX, y: rect.minY - top, width: rect.width, height: rect.height + top + bottom)
        return Path(roundedRect: grown, cornerRadius: cornerRadius, style: .continuous)
    }
}
