// Onboarding page 1 (prompt L21): a 290pt clock dial whose hand sweeps clockwise at 40°/s
// from 20°, a peach wedge trailing it, and four rim dots that pulse as the hand passes them
// while their task chip fades and scales in. A TimelineView keyed to the moment the page
// appears drives it, so it is deterministic, starts from zero on every visit and loops forever.
import SwiftUI

struct ClockIllustration: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date.now

    /// The dial's top sits ~120pt below the body text when there is room (L21).
    private static let preferredTop: CGFloat = 120
    private static let bottomMargin: CGFloat = 16

    var body: some View {
        GeometryReader { geo in
            let d = ClockSweep.diameter
            // Fixed 290pt; only shrinks if the page leaves less room than the dial needs.
            let scale = max(min(1, (geo.size.height - 8) / d, (geo.size.width - 24) / d), 0.1)
            let dialHeight = d * scale
            let slack = max(geo.size.height - dialHeight, 0)
            let top = min(Self.preferredTop, max(slack - Self.bottomMargin, slack / 2))
            dial
                .scaleEffect(scale)
                .frame(width: ClockSweep.canvas, height: ClockSweep.canvas)
                .position(x: geo.size.width / 2, y: top + dialHeight / 2)
        }
        .onAppear { start = .now }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("A clock with tasks OpenDuet finished around the day"))
    }

    private var dial: some View {
        ZStack {
            Circle()
                .fill(OnboardingTheme.clockFill)
                .shadow(color: .black.opacity(0.06), radius: 14, y: 4)
                .frame(width: ClockSweep.diameter, height: ClockSweep.diameter)
            dialIcon("moon").offset(y: -(ClockSweep.radius - 38))
            dialIcon("sun.max").offset(y: ClockSweep.radius - 38)
            TimelineView(.animation) { context in
                let t = max(context.date.timeIntervalSince(start), 0)
                let still = reduceMotion
                ZStack {
                    Canvas { gc, size in
                        ClockSweep.draw(in: &gc, size: size, t: t, reduceMotion: still)
                    }
                    ForEach(0..<ClockSweep.dots.count, id: \.self) { i in
                        let state = ClockSweep.chip(i, at: t, reduceMotion: still)
                        chip(i)
                            .scaleEffect(state.scale)
                            .opacity(state.opacity)
                            .offset(ClockSweep.chipOffsets[i])
                    }
                }
            }
        }
        .frame(width: ClockSweep.canvas, height: ClockSweep.canvas)
        .accessibilityHidden(true)
    }

    /// The grey outline moon (just below 12) and sun (just above 6).
    private func dialIcon(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 15, weight: .regular))
            .foregroundStyle(OnboardingTheme.grey)
    }

    @ViewBuilder private func chip(_ i: Int) -> some View {
        switch i {
        case 0: IllustrationChip(text: Text("Finished your report"), fontSize: 13, height: 28, iconSize: 14) { DriveMark() }
        case 1: IllustrationChip(text: Text("Prepped your 2 PM"), fontSize: 13, height: 28, iconSize: 14) { CalendarMark() }
        case 2: IllustrationChip(text: Text("Drafted a reply"), fontSize: 13, height: 28, iconSize: 14) { GmailMark() }
        default: IllustrationChip(text: Text("Reviewed a PR"), fontSize: 13, height: 28, iconSize: 14) { GitHubMark() }
        }
    }
}

#Preview {
    ClockIllustration()
        .frame(height: 460)
        .background(OnboardingTheme.background)
}
