// The orange #D65A45 "+" FAB (prompt L148, L161): orange-tinted interactive Liquid Glass on iOS 26,
// the solid orange circle with its warm shadow on iOS 18. M9: only Make has one (the Tasks FAB is
// gone). `open` turns the + into ✕ by rotating it 45° on the fan's spring (FanMotion); with Reduce
// Motion the two crossfade instead.
import SwiftUI

struct PlusFAB: View {
    var label: Text
    var open = false
    var action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var taps = 0

    var body: some View {
        Button {
            taps += 1
            action()
        } label: {
            glyph
                .frame(width: Metrics.fab, height: Metrics.fab)
                .fabSurface()
                .contentShape(Circle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.92))
        .animation(FanMotion.animation(reduceMotion: reduceMotion), value: open)
        .accessibilityLabel(label)
        .sensoryFeedback(.impact(weight: .light), trigger: taps)
    }

    @ViewBuilder
    private var glyph: some View {
        let plus = DuetIcon(glyph: .add, size: 28, tint: .white)
        if reduceMotion {
            ZStack {
                plus.opacity(open ? 0 : 1)
                plus.rotationEffect(.degrees(45)).opacity(open ? 1 : 0)
            }
        } else {
            plus.rotationEffect(.degrees(open ? 45 : 0))
        }
    }
}
