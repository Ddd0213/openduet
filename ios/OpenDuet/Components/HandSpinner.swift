// M10: the hand-drawn spinner (prompt L84 Working blue, L121 "a blue spinning arc"): an open ring
// drawn with the icon set's pen (ArtPen.ring: a slightly uneven circle, ~3/4 of the way round)
// turning steadily. SpinnerArc (CardKit) draws with it, so every spinner in the app is this one.
// Like SpinnerArc before it, it keeps turning under Reduce Motion (a spinner that stops reads as
// stuck), only slower.
import SwiftUI

/// The open ring on the 24-unit grid.
struct HandSpinnerShape: Shape {
    func path(in rect: CGRect) -> Path {
        var pen = ArtPen(rect: rect)
        pen.ring((12, 12), 11.1, from: -90, sweep: 262, wobble: 0.03)
        return pen.path
    }
}

struct HandSpinner: View {
    var size: CGFloat = 16
    var color: Color = Palette.working
    var lineWidth: CGFloat = 2

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation) { context in
            let period = reduceMotion ? 2.4 : 0.95
            let turn = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
            HandSpinnerShape()
                .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                .rotationEffect(.degrees(turn * 360))
        }
        .frame(width: size, height: size)
        .padding(lineWidth / 2)
        .accessibilityHidden(true)
    }
}
