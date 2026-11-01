// The call's waveform fed by the session's loudness. Its own view so only it redraws as the
// level moves (about 25 times a second), not the composer or the bar around it.
import SwiftUI

struct LiveCallWaveform: View {
    var call: CallSession
    var tint: Color
    var size: CGFloat = 22

    var body: some View {
        CallWaveform(level: call.level, tint: tint, size: size, active: active)
    }

    /// Bars move while someone can be heard: listening (not muted) or speaking.
    private var active: Bool {
        switch call.phase {
        case .listening?: !call.muted
        case .speaking?: true
        default: false
        }
    }
}
