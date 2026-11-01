// The floating app-shell header (prompt L94, L33): no navigation bar, a 44 pt ≡ circle on the
// left (red count badge for unread channels), the animating mascot in a 64 pt circle with the
// status pill overlapping its bottom edge, and the 44 pt initials circle on the right. Chat
// scrolls under it (L95): behind the opaque fade on iOS 18, under the glass with the system's
// scroll-edge effect on iOS 26 (the shell pins it with `duetBar`, which draws either).
import SwiftUI

struct ChatHeader: View {
    var status: StatusKey?
    /// The selected channel (M4): the idle pill names it; nil in Everything.
    var channel: Channel? = nil
    var userName: String?
    var unreadChannels = 0
    var onMenu: () -> Void = {}
    var onAssistant: () -> Void = {}
    var onProfile: () -> Void = {}
    /// M6: tapping a channel's header pill opens the channel sheet (iOS 1 makes the pill tappable)
    var onPill: () -> Void = {}
    var onRestart: () -> Void

    /// Room under the mascot circle for the pill's overhang plus a little air. On iOS 26 the pill
    /// sits just under the circle instead of overlapping it (two glass shapes would melt into
    /// one), so the header keeps a little more room.
    static var bottomPadding: CGFloat { LiquidGlass.isAvailable ? 40 : 32 }
    /// Height of the gradient below the header's opaque area (iOS 18).
    static let fadeHeight: CGFloat = ChromeBar.fadeHeight

    var body: some View {
        // One glass layer for the row: the circles and the pill sample and light together.
        // Spacing 0: shapes only blend when they touch, so the pill stays apart from the circle.
        ChromeGlassGroup(spacing: 0) {
            HStack(alignment: .top) {
                MenuCircle(unread: unreadChannels, action: onMenu)
                Spacer(minLength: 12)
                MascotAvatar(status: status, channel: channel, action: onAssistant, onPill: onPill)
                Spacer(minLength: 12)
                InitialsCircle(userName: userName, onTap: onProfile, onRestart: onRestart)
            }
        }
        // The unread badge sits over the ≡ circle's top-right, outside the glass group: inside
        // it, iOS 26 draws the merged glass over the badge and the circle hides half of it.
        .overlay(alignment: .topLeading) {
            UnreadBadge(count: unreadChannels)
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, Self.bottomPadding)
    }
}

/// The 64 pt mascot circle; its pose follows the live status (nil = idle). Tap opens the assistant
/// (and the mascot blinks and wobbles); M29: it reacts to live cues (MascotCues: a background task
/// done, a new error card, a new card that needs the user).
private struct MascotAvatar: View {
    var status: StatusKey?
    var channel: Channel?
    var action: () -> Void
    /// M6: in a channel (not Main or Everything) the pill opens the channel sheet.
    var onPill: () -> Void = {}

    /// The reaction playing: a live cue or a tap, whichever came last.
    @State private var event: MascotEvent?

    /// How far the pill reaches up into the circle (iOS 18); on glass it hangs 4 pt below it.
    private static var pillOverlap: CGFloat { LiquidGlass.isAvailable ? -4 : 8 }
    /// M29 (plan 6.2): while the pill covers the circle's lower edge (iOS 18) the mascot sits this
    /// much higher, in the middle of the circle's uncovered part, so no hop, squash or lean of
    /// its body comes near the pill. Glass: the pill is under the circle, nothing to clear.
    private static var pillLift: CGFloat { LiquidGlass.isAvailable ? 0 : 4 }

    /// StatusPill draws something: a live status, or the selected channel when idle.
    private var showsPill: Bool { status != nil || channel != nil }

    private var pillChannel: Channel? {
        guard let channel, !channel.isMain else { return nil }
        return channel
    }

    var body: some View {
        // Copied out because alignment-guide closures are Sendable and nonisolated.
        let overlap = Self.pillOverlap
        Button {
            event = MascotEvent(.tap)
            action()
        } label: {
            DuetMascot(pose: MascotPose(status: status), size: 34, animated: true, event: event)
                .offset(y: showsPill ? -Self.pillLift : 0)
                // The pill's own fade (StatusPill): the mascot rises as the pill comes in.
                .animation(.easeInOut(duration: 0.3), value: showsPill)
                .floatingCircle(Metrics.headerMascot)
        }
        .buttonStyle(PressableButtonStyle(scale: 0.94))
        .onChange(of: MascotCues.shared.latest) { _, cue in
            if let cue { event = cue }
        }
        .accessibilityLabel(Text(verbatim: "OpenDuet"))
        .accessibilityValue(status.map { Text($0.title) } ?? channel.map { Text(verbatim: "#\($0.name)") } ?? Text(verbatim: ""))
        .overlay(alignment: .bottom) {
            // As wide as the room between the ≡ and initials circles; a long name truncates.
            if let pillChannel {
                Button(action: onPill) {
                    StatusPill(status: status, channel: channel)
                        .contentShape(Capsule())
                }
                .buttonStyle(PressableButtonStyle(scale: 0.96))
                .frame(width: 236)
                .fixedSize(horizontal: false, vertical: true)
                .alignmentGuide(.bottom) { _ in overlap }
                .accessibilityLabel(Text(verbatim: "#\(pillChannel.name)"))
                .accessibilityHint(Text("Shows the channel's details and files"))
            } else {
                StatusPill(status: status, channel: channel)
                    .frame(width: 236)
                    .fixedSize(horizontal: false, vertical: true)
                    .alignmentGuide(.bottom) { _ in overlap }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }
}

/// The red unread-channels count over the ≡ circle's top-right corner (the header's top-leading
/// 44 pt box). It doesn't take taps: they reach the ≡ button under it.
private struct UnreadBadge: View {
    var count: Int

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if count > 0 {
                CountBadge(count: count)
                    .offset(x: 4, y: -2)
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .frame(width: Metrics.headerCircle, height: Metrics.headerCircle, alignment: .topTrailing)
        .animation(.spring(response: 0.3, dampingFraction: 0.75), value: count > 0)
        .allowsHitTesting(false)
    }
}

/// The ≡ menu circle; it opens the side menu (its unread badge is `UnreadBadge`, drawn above the
/// header's glass group).
private struct MenuCircle: View {
    var unread: Int
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            // Three left-aligned lines of unequal length, like the original (orig-tasks.jpeg).
            HeroGlyphView(glyph: .menu, size: 22, lineWidth: 1.7)
                .foregroundStyle(Palette.primaryText)
                .floatingCircle(Metrics.headerCircle)
        }
        .buttonStyle(PressableButtonStyle(scale: 0.92))
        .accessibilityLabel(Text("Menu"))
        .accessibilityValue(unread > 0 ? Text("\(unread) unread") : Text(verbatim: ""))
    }
}

// MARK: - Shared floating surface styling

extension View {
    /// The soft drop shadow of floating chrome: visible in light, none in dark, where the
    /// #333333 surface already stands off the near-black background.
    func floatingShadow() -> some View {
        modifier(FloatingShadow())
    }

    /// A floating circle of the given diameter: Liquid Glass on iOS 26 (interactive when it is a
    /// control), white in light / #333333 in dark with the soft shadow on iOS 18. The ↓ circle,
    /// back / close / ⋯ circles and header circles all use it. M21: with the 0.5 pt top-edge
    /// light, and on iOS 18 the reference's float shadow (Theme/Glass.swift).
    func floatingCircle(_ diameter: CGFloat, interactive: Bool = true) -> some View {
        frame(width: diameter, height: diameter)
            .chromeSurface(Circle(), interactive: interactive, hairline: false, edge: true)
            .contentShape(Circle())
    }
}

private struct FloatingShadow: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content.shadow(color: .black.opacity(colorScheme == .dark ? 0 : 0.07), radius: 6, y: 2)
    }
}
