// The check celebration (prompt L17, L31; M29: the mascot instead of the orange circle and drawn
// check): the 96 pt mascot pops in at the centre (spring from 0.3), squints happily and hops once
// while page 2's green check badge pops onto its shoulder; hold 0.9 s, then the flow crossfades
// to Chat. A success haptic marks the user's finished onboarding. Reduce Motion: it fades in
// already smiling, the badge fades in, no hop.
import SwiftUI

struct CelebrationView: View {
    let onFinished: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var scale: CGFloat = 0.3
    @State private var opacity: Double = 0
    @State private var start: Date?
    @State private var badgeShown = false
    @State private var checked = false

    private static let size: CGFloat = 96
    private static let badge: CGFloat = 34

    var body: some View {
        // Runs until the flow crossfades away (the hop has landed by then); Reduce Motion: still.
        TimelineView(.animation(paused: start == nil || reduceMotion)) { context in
            let t = start.map { context.date.timeIntervalSince($0) } ?? 0
            MascotStill(face: face(at: t), size: Self.size)
                .overlay {
                    CheckBadge(size: Self.badge)
                        .scaleEffect(badgeShown || reduceMotion ? 1 : 0.3)
                        .opacity(badgeShown ? 1 : 0)
                        .offset(x: Self.size / 2 * 0.74, y: -Self.size / 2 * 0.74)
                }
        }
        .scaleEffect(scale)
        .opacity(opacity)
        .accessibilityElement()
        .accessibilityLabel(Text("All set"))
        .sensoryFeedback(.success, trigger: checked)
        .task {
            start = .now
            if reduceMotion {
                scale = 1
                withAnimation(.easeOut(duration: 0.25)) { opacity = 1 }
            } else {
                withAnimation(.spring(response: 0.45, dampingFraction: 0.62)) {
                    scale = 1
                    opacity = 1
                }
            }
            // The check pops as the mascot leaves the floor (its hop starts at 0.18 s).
            try? await Task.sleep(for: .seconds(0.35))
            withAnimation(reduceMotion ? .easeOut(duration: 0.3) : .spring(response: 0.4, dampingFraction: 0.6)) { badgeShown = true }
            try? await Task.sleep(for: .seconds(0.2))
            checked = true
            try? await Task.sleep(for: .seconds(0.9))
            if !Task.isCancelled { onFinished() }
        }
    }

    /// Neutral, then the happy squint from 0.15 s, and one hop (squat at 0.18 s, landing ~0.7 s).
    private func face(at t: Double) -> MascotFace {
        guard !reduceMotion else { return .happy }
        var f = MascotFace.lerp(.neutral, .happy, MascotCurve.ramp(t, 0.15, 0.12))
        let hop = MascotMotion.happyHop(t - 0.18, height: 0.24, energy: 1)
        f.hop = hop.hop
        f.squash = hop.squash
        f.tilt = hop.tilt
        return f
    }
}

#Preview {
    ZStack {
        OnboardingTheme.background.ignoresSafeArea()
        CelebrationView {}
    }
}
