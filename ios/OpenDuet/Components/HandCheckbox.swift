// M10: the task row's hand-drawn checkbox (prompt L117: a rounded square, tap = Mark complete): a
// rounded square whose sides bow a touch, drawn with the icon set's pen (ArtPen.box), and the
// set's check (ArtCheck, CheckMarks.swift) that draws itself on when the task resolves. Reduce
// Motion: the check fades in, nothing draws.
import SwiftUI

/// The box on the 24-unit grid: rounded corners, gently bowed sides (one fixed pattern).
struct HandBoxShape: Shape {
    func path(in rect: CGRect) -> Path {
        var pen = ArtPen(rect: rect)
        pen.box(1.5, 1.5, 22.5, 22.5, r: 6.8, bows: (0.06, 0.1, -0.08, -0.1))
        return pen.path
    }
}

struct HandCheckbox: View {
    var checked: Bool
    var size: CGFloat
    /// The box's line while open.
    var ink: Color = Palette.primaryText.opacity(0.35)
    /// The box and the check once resolved.
    var doneInk: Color = Palette.secondaryText

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            HandBoxShape()
                .fill(checked ? doneInk.opacity(0.15) : .clear)
            HandBoxShape()
                .stroke(checked ? doneInk.opacity(0.5) : ink, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            CheckStroke(progress: reduceMotion || checked ? 1 : 0, lineWidth: max(1.7, size * 0.09), color: doneInk)
                .padding(size * 0.25)
                .opacity(checked ? 1 : 0)
        }
        .frame(width: size, height: size)
        // Checking draws the tick on (~0.3 s); the colours crossfade.
        .animation(checked ? .easeOut(duration: 0.32) : .easeIn(duration: 0.16), value: checked)
        .accessibilityHidden(true)
    }
}
