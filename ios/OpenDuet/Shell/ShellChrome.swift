// The shell's fixed chrome around the content (prompt L94-L96, L161, L184): the slim offline bar
// under the header, and the bottom stack (composer, or Make's FAB slot) over the soft fade, above
// the system tab bar (M19).
import SwiftUI

/// "Can't reach your server · Retrying": a slim grey capsule under the header while offline.
struct OfflineBar: View {
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13

    var body: some View {
        HStack(spacing: 6) {
            DuetIcon(glyph: .offline, size: fontSize + 2, tint: Palette.secondaryText)
            Text("Can't reach your server · Retrying")
                .font(.system(size: fontSize, weight: .medium))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .foregroundStyle(Palette.secondaryText)
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .chromeSurface(Capsule(), shadow: false)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// What sits above the system tab bar on a tab page (M19): the composer 8 pt above the bar
/// (Chat), the assistant's working pill while it builds, or nothing; on Make the FAB's slot, 16 pt above
/// the bar at its trailing end (MakeFanLayer draws the FAB in it, so it keeps one identity while it
/// morphs into ✕). Each tab page pins it with `duetBar(.bottom, masked: false)`, which keeps the
/// room above it; the progressive mask is drawn here, behind the composer and down past the tab
/// bar to the screen edge, so the FAB's slot doesn't widen the blurred band. The system bar stays
/// put when the keyboard comes up (it is under the keyboard); the keyboard's safe area lifts the
/// composer, on the keyboard's own curve.
struct BottomChrome<Composer: View>: View {
    /// M9: the Make FAB's slot (L148, L161).
    var makeSlot = false
    /// The slot's frame in the tab page's coordinate space (`MakeFanLayer.pageSpace`).
    var onMakeFrame: (CGRect) -> Void = { _ in }
    /// False on the 4th tab: the viewer's page shows under the tab bar with nothing over it.
    var masked = true
    @ViewBuilder var composer: Composer

    var body: some View {
        VStack(spacing: 0) {
            if makeSlot {
                Color.clear
                    .frame(width: Metrics.fab, height: Metrics.fab)
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(MakeFanLayer.pageSpace)) } action: { onMakeFrame($0) }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.trailing, Metrics.fabTrailing)
                    .padding(.bottom, Metrics.fabAboveTabBar)
                    .accessibilityHidden(true)
            }
            // Full width whatever is showing, so the mask behind it never stops short. The long
            // soft fade: solid only behind the home indicator (EdgeFade).
            VStack(spacing: 0) {
                composer
            }
            .frame(maxWidth: .infinity)
            .chromeMask(.bottom, visible: masked, long: .shellBottom)
        }
        .frame(maxWidth: .infinity)
    }
}

/// Hides the status bar while `hidden`. One view structure either way: an `if hidden` here would
/// give the whole shell a new identity on every flip, rebuild the open viewer, reset its page
/// colour and flip again (the Build view flickered without end). The image viewer is its own full
/// screen cover, so it still hides the status bar itself.
struct HideStatusBar: ViewModifier {
    var hidden: Bool

    func body(content: Content) -> some View {
        content.statusBarHidden(hidden)
    }
}

/// Tasks and Make before their milestones (M3, M5): the empty state, one line and one action.
struct TabPlaceholder: View {
    var tab: AppTab
    var onMessageAssistant: () -> Void

    var body: some View {
        switch tab {
        case .tasks:
            EmptyStateView(
                systemImage: DuetGlyph.tasks.symbol,
                message: "Tasks you give OpenDuet show up here.",
                actionTitle: "Message OpenDuet",
                action: onMessageAssistant
            )
        case .make:
            EmptyStateView(
                systemImage: DuetGlyph.make.symbol,
                message: "Everything OpenDuet makes shows up here",
                actionTitle: "Message OpenDuet",
                action: onMessageAssistant
            )
        case .chat, .pinned:
            EmptyView()
        }
    }
}
