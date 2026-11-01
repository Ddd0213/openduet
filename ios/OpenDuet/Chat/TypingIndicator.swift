// The assistant's typing dots (prompt L33): three grey dots bouncing in sequence inside a small
// assistant-style bubble. With Reduce Motion the dots stay put and pulse their opacity instead.
import SwiftUI

struct TypingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let dotSize: CGFloat = 8
    private static let lift: CGFloat = 4
    /// One full bounce cycle, and the delay between neighbouring dots.
    private static let period = 1.2
    private static let stagger = 0.16

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { index in
                    let wave = Self.wave(at: t - Double(index) * Self.stagger, reduceMotion: reduceMotion)
                    Circle()
                        .fill(Palette.secondaryText)
                        .frame(width: Self.dotSize, height: Self.dotSize)
                        .opacity(0.5 + 0.5 * wave)
                        .offset(y: reduceMotion ? 0 : -Self.lift * wave)
                }
            }
            // Dots rest on the bottom of this frame and hop up inside it.
            .frame(height: Self.dotSize + Self.lift, alignment: .bottom)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .assistantBubbleBackground()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("OpenDuet is typing"))
    }

    /// 0...1: a quick smooth hop in the first 40% of each cycle, at rest for the remainder.
    /// Reduce Motion stretches it into a slower, gentler full-cycle pulse.
    private static func wave(at time: Double, reduceMotion: Bool) -> Double {
        let length = reduceMotion ? period * 1.5 : period
        let phase = (time / length).truncatingRemainder(dividingBy: 1)
        let p = phase < 0 ? phase + 1 : phase
        if reduceMotion { return 0.5 - 0.5 * cos(p * 2 * .pi) }
        guard p < 0.4 else { return 0 }
        return sin(p / 0.4 * .pi)
    }
}
