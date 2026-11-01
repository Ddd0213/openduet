// M10 stop responding (plan 2.8): while the assistant replies in the thread and nothing is typed, the
// composer's filled waveform circle shows ■ inside a hand-drawn ring that keeps turning (the
// set's pen: ArtPen's wobbly ring with a soft gap, and a square whose sides bow a hair). Reduce
// Motion: the ring holds still. The circle and its colours stay the composer's (black in light,
// white in dark); ComposerBar morphs waveform ↔ ■ ↔ ↑ with a crossfade and a small scale.
// Which of the three the circle shows is ComposerAction (ComposerRules.swift, host-tested).
import SwiftUI

/// ■ in its turning hand-drawn ring, drawn in `tint` at `size` points.
struct StopGlyph: View {
    var size: CGFloat
    var tint: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            StopSquare().fill(tint)
            if reduceMotion {
                StopRing(phase: 0).stroke(tint, style: style)
            } else {
                // Only on screen while the assistant replies; the timeline pauses with the view.
                TimelineView(.animation) { context in
                    StopRing(phase: context.date.timeIntervalSinceReferenceDate)
                        .stroke(tint, style: style)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var style: StrokeStyle {
        StrokeStyle(lineWidth: max(1.5, size * 0.06), lineCap: .round, lineJoin: .round)
    }
}

/// The ring: about three quarters of a wobbly hand-drawn circle whose gap travels round (one
/// turn every ~1.1 s) while the arc breathes a little longer and shorter, like a pen going round.
/// The wobble is tied to the paper, not to the arc, so the line itself never shimmers.
struct StopRing: Shape {
    /// Seconds (any origin); 0 = the still ring of Reduce Motion.
    var phase: TimeInterval

    func path(in rect: CGRect) -> Path {
        var pen = ArtPen(rect: rect)
        let turn = phase.truncatingRemainder(dividingBy: Self.period) / Self.period * 360
        let sweep = 270 + 30 * sin(phase * 2 * .pi / Self.breath)
        pen.ring((12, 12), 10, from: CGFloat(turn) - 90, sweep: CGFloat(sweep), wobble: 0.03)
        return pen.path
    }

    private static let period: TimeInterval = 1.1
    private static let breath: TimeInterval = 1.7
}

/// The ■: a small square with softly rounded corners and sides that bow a hair (filled).
struct StopSquare: Shape {
    func path(in rect: CGRect) -> Path {
        var pen = ArtPen(rect: rect)
        pen.box(8.1, 8.1, 15.9, 15.9, r: 1.6, bows: (0.08, -0.06, 0.07, -0.08))
        return pen.path
    }
}

#if DEBUG
#Preview("Stop glyph") {
    HStack(spacing: 24) {
        StopGlyph(size: 30, tint: Palette.background)
            .frame(width: 36, height: 36)
            .background(Circle().fill(Palette.composerAction))
        StopGlyph(size: 60, tint: Palette.primaryText)
    }
    .padding()
}
#endif
