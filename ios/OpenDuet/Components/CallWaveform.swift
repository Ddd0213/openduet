// The call's live waveform: five rounded bars whose heights follow the loudness (the user's
// voice while listening, the voice's while it speaks). The composer's circle shows it during a
// call, the call bar next to its phase. Reduce Motion: still bars, only the tint follows.
import SwiftUI

struct CallWaveform: View {
    /// 0…1
    var level: Float
    var tint: Color
    var size: CGFloat = 22
    /// A call that isn't live (connecting, reconnecting, muted): flat bars.
    var active = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// How much of the full height each bar reaches at full loudness (the middle one highest).
    private static let shape: [CGFloat] = [0.45, 0.75, 1, 0.75, 0.45]

    var body: some View {
        let loud = active ? CGFloat(min(max(level, 0), 1)) : 0
        HStack(alignment: .center, spacing: size * 0.09) {
            ForEach(Self.shape.indices, id: \.self) { index in
                Capsule()
                    .fill(tint.opacity(active ? 0.55 + 0.45 * Double(loud) : 0.55))
                    .frame(width: size * 0.11, height: height(index, loud: loud))
            }
        }
        .frame(width: size, height: size)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: loud)
        .accessibilityHidden(true)
    }

    private func height(_ index: Int, loud: CGFloat) -> CGFloat {
        let resting = size * 0.18
        guard !reduceMotion else { return resting + (size - resting) * Self.shape[index] * 0.5 }
        return resting + (size - resting) * Self.shape[index] * loud
    }
}
