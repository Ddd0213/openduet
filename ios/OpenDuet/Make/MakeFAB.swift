// The Make tab's orange #D65A45 "+" FAB and its fan-out (prompt L148, L161): 16 pt above the tab
// bar, right-aligned with it. Tapped, it turns into ✕ and right-aligned capsules fan out above it
// over a dimmed, blurred background, each with a tinted icon: Design System, Design, Dashboard,
// Slides, Docs, Web page.
// M9: one FAB with one identity. The shell draws it here, in one layer with the fan (BottomChrome
// only keeps its slot), so switching tabs never crossfades two FABs and the + itself morphs into ✕.
// Open and close are one spring driven by one state (`isOpen`): the + rotates 45° while the
// capsules fan out (nearest first) and the dim fades in; closing reverses all of it at once — ✕ back
// to +, the capsules retract into the FAB (farthest first, a slight stagger), the dim fades — and
// SwiftUI keeps each piece until its own removal has finished. Tapping the dim closes. Reduce
// Motion: everything crossfades.
// M10: the FAB fades out while the gallery scrolls and back ~0.4 s after it stops (MakeFABFade,
// FABFadeRule); Reduce Motion: a plain fade.
import SwiftUI

struct MakeFAB: View {
    var isOpen: Bool
    var action: () -> Void

    var body: some View {
        // Orange-tinted glass on iOS 26, the orange circle on iOS 18 (PlusFAB).
        PlusFAB(label: isOpen ? Text("Close") : Text("Make something"), open: isOpen, action: action)
    }
}

/// M10: the gallery's scrolling, for the FAB drawn by the shell's fan layer. MakeTabView reports
/// its scroll phases; MakeFanLayer reads `hidden`. One shared instance, since the gallery and the
/// fan layer are siblings in the shell (no state passes between them), and only the views touch
/// it (main actor). The rule itself is FABFadeRule.
@MainActor
@Observable
final class MakeFABFade {
    static let shared = MakeFABFade()

    /// The FAB is faded out (the gallery is scrolling, or stopped less than ~0.4 s ago).
    private(set) var hidden = false
    @ObservationIgnored private var reveal: Task<Void, Never>?

    func phaseChanged(_ phase: FABFadeRule.Phase) {
        switch FABFadeRule.step(for: phase, hidden: hidden) {
        case .hide:
            reveal?.cancel()
            reveal = nil
            if !hidden { hidden = true }
        case .showAfterDelay:
            reveal?.cancel()
            reveal = Task { [weak self] in
                try? await Task.sleep(for: FABFadeRule.delay)
                guard !Task.isCancelled else { return }
                self?.hidden = false
                self?.reveal = nil
            }
        case .keep:
            break
        }
    }

    /// The gallery went away (another tab, the viewer over it): the FAB is back at once.
    func reset() {
        reveal?.cancel()
        reveal = nil
        if hidden { hidden = false }
    }
}

/// The one spring of the FAB and its fan.
enum FanMotion {
    static let spring = Animation.spring(response: 0.38, dampingFraction: 0.84)
    /// Between two capsules.
    static let stagger: Double = 0.03

    static func animation(reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeInOut(duration: 0.22) : spring
    }
}

/// The FAB, the dim and the capsules, over the whole shell (the system tab bar too). The FAB sits in
/// BottomChrome's slot on the Make page. M19: that page lives inside the system TabView, so the
/// slot is measured in the page's own space (`pageSpace`, declared on the tab page's root), which
/// starts where the shell's (`space`) does: top of the safe area, full width. Both move together
/// with the side menu's slide, so the slot doesn't change while the menu moves.
struct MakeFanLayer: View {
    nonisolated static let space = "duet.shell"
    nonisolated static let pageSpace = "duet.tabpage"

    var isOpen: Bool
    /// Make is showing (no Build view, task detail or viewer over it, no keyboard).
    var showsFAB: Bool
    /// BottomChrome's FAB slot (in `pageSpace`, which lines up with `space`).
    var slot: CGRect
    var onToggle: () -> Void
    var onPick: (ArtifactType) -> Void
    var onClose: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var picks = 0
    private let fade = MakeFABFade.shared

    private static let capsuleHeight: CGFloat = 42

    /// M10: faded while the gallery scrolls; never while the fan is open.
    private var scrollFaded: Bool { fade.hidden && !isOpen }

    var body: some View {
        GeometryReader { proxy in
            let origin = proxy.frame(in: .named(Self.space)).origin
            let fab = slot.offsetBy(dx: -origin.x, dy: -origin.y)
            ZStack(alignment: .topLeading) {
                if isOpen {
                    backdrop.transition(.opacity.animation(FanMotion.animation(reduceMotion: reduceMotion)))
                }
                if slot != .zero {
                    ForEach(Array(ArtifactType.fanOrder.enumerated()), id: \.element) { index, type in
                        let order = ArtifactType.fanOrder.count - 1 - index
                        let centerY = Self.centerY(order: order, fab: fab)
                        // The slot stays; the capsule inside comes and goes with its own transition.
                        ZStack {
                            if isOpen {
                                capsule(type)
                                    .transition(transition(order: order, travel: fab.midY - centerY))
                            }
                        }
                        // Right-aligned with the FAB.
                        .frame(width: max(fab.maxX, 0), height: Self.capsuleHeight, alignment: .trailing)
                        .position(x: max(fab.maxX, 0) / 2, y: centerY)
                    }
                }
                if showsFAB && slot != .zero {
                    MakeFAB(isOpen: isOpen, action: onToggle)
                        // M10: faded (and out of the finger's way) while the gallery scrolls; back
                        // ~0.4 s after it stops.
                        .opacity(scrollFaded ? 0 : 1)
                        .scaleEffect(scrollFaded && !reduceMotion ? 0.86 : 1)
                        .allowsHitTesting(!scrollFaded)
                        .position(x: fab.midX, y: fab.midY)
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.6)))
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
        }
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 0.22), value: showsFAB)
        // Reduce Motion: a plain fade; otherwise the fade with a slight shrink.
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .easeInOut(duration: 0.24), value: scrollFaded)
        .sensoryFeedback(.selection, trigger: picks)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(isOpen ? .isModal : [])
        .accessibilityAction(.escape) { if isOpen { onClose() } }
    }

    /// The lowest capsule 10 pt above the FAB, then upward.
    private static func centerY(order: Int, fab: CGRect) -> CGFloat {
        fab.minY - 10 - capsuleHeight / 2 - CGFloat(order) * (capsuleHeight + Metrics.fanCapsuleSpacing)
    }

    private var backdrop: some View {
        Rectangle()
            .fill(.ultraThinMaterial)
            .overlay(Palette.fanDim)
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture(perform: onClose)
            .accessibilityHidden(true)
    }

    /// Out of the FAB and back into it: down toward it, shrinking toward its right edge, fading.
    /// Opening staggers nearest first, closing farthest first.
    private func transition(order: Int, travel: CGFloat) -> AnyTransition {
        guard !reduceMotion else { return .opacity.animation(FanMotion.animation(reduceMotion: true)) }
        let retracted = AnyTransition.offset(y: travel * 0.8)
            .combined(with: .scale(scale: 0.3, anchor: .trailing))
            .combined(with: .opacity)
        let last = ArtifactType.fanOrder.count - 1
        return .asymmetric(
            insertion: retracted.animation(FanMotion.spring.delay(Double(order) * FanMotion.stagger)),
            removal: retracted.animation(FanMotion.spring.delay(Double(last - order) * FanMotion.stagger * 0.6))
        )
    }

    private func capsule(_ type: ArtifactType) -> some View {
        Button {
            picks += 1
            onPick(type)
        } label: {
            HStack(spacing: 10) {
                // The type's line icon in its tint.
                DuetIcon(type.fanIcon, size: 22, tint: type.fanTint)
                Text(type.title)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Palette.primaryText)
                    .lineLimit(1)
                    .fixedSize()
            }
            .padding(.horizontal, 18)
            .frame(height: Self.capsuleHeight)
            .chromeSurface(Capsule(), interactive: true, hairline: false)
            .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.95))
        .accessibilityLabel(Text("Make \(Text(type.title))"))
    }
}

extension ArtifactType {
    /// The type's icon in the app's line set (the fan's capsules, the 4th tab). M9 (vis): the set
    /// has no "design system" key, so it borrows Design's.
    var fanIcon: CardIcon {
        switch self {
        case .webPage: .webpage
        case .docs: .doc
        case .slides: .slides
        case .dashboard: .dashboard
        case .design, .designSystem: .design
        }
    }
}
