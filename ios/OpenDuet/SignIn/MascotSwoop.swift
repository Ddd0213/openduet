// The sign-in mascot (L131, M29): the circle pops in with its eyes shut, then they open (a little
// wide at first, settling) and it blinks once. The finished frame is the still neutral face of
// LaunchView and the system launch screen (Tools/LaunchMascot), same size and canvas, so the
// launch mascot and this one line up. Reduce Motion (or `animated: false`): the still face.
import SwiftUI

struct MascotSwoop: View {
    var size: CGFloat = 64
    /// false = the still face (the launch screen).
    var animated = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var popped = false
    @State private var start: Date?
    @State private var settled = false

    /// The canvas: the circle with a little room around it (Tools/LaunchMascot renders 80 x 80 pt
    /// for 64 pt, centred like this, for a hand-over without a jump).
    static func canvas(_ size: CGFloat) -> CGSize { CGSize(width: size * 1.25, height: size * 1.25) }

    var body: some View {
        let still = !animated || reduceMotion
        let box = Self.canvas(size)
        TimelineView(.animation(paused: still || settled)) { context in
            let t = still || settled ? 10 : start.map { context.date.timeIntervalSince($0) } ?? 0
            MascotStill(face: Self.face(at: t), size: size, frame: box)
        }
        .frame(width: box.width, height: box.height)
        .scaleEffect(still || popped ? 1 : 0.6)
        .opacity(still || popped ? 1 : 0)
        .accessibilityHidden(true)
        .task {
            guard !still, !settled else { return }
            start = .now
            withAnimation(.spring(response: 0.5, dampingFraction: 0.62)) { popped = true }
            try? await Task.sleep(for: .seconds(1.3))
            settled = true
        }
    }

    /// Shut until 0.3 s, open (over-wide, then settling) by 0.6 s, a blink at 0.95 s.
    static func face(at t: Double) -> MascotFace {
        let c = MascotCurve.self
        var f = MascotFace.neutral
        let open = c.ramp(t, 0.3, 0.12)
        f.open = open * c.blinkOpen(t, 0.95)
        f.eyeHeight = 1 + 0.16 * c.bump(t, 0.32, rise: 0.08, fall: 0.3)
        f.pitch = -3 * c.bump(t, 0.3, rise: 0.1, fall: 0.4)
        return f
    }
}

#Preview {
    VStack(spacing: 40) {
        MascotSwoop()
        MascotSwoop(animated: false)
    }
    .padding()
    .background(Palette.background)
}
