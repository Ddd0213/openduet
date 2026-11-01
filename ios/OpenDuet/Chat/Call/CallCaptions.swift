// The call bar's live captions: the newest voice line and the user's, two lines at most, the
// older one faded. VoiceOver hears them as an updating region; its action cuts the voice short.
import SwiftUI

struct CallCaptions: View {
    /// Oldest first (CallTranscript.captions).
    var lines: [CallLine]
    var onInterrupt: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 14

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(lines.suffix(2).enumerated()), id: \.element.id) { index, line in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    speaker(line.from)
                        .font(.system(size: fontSize - 1, weight: .semibold))
                        .foregroundStyle(Palette.secondaryText)
                    // The newest words matter: a long line keeps its end.
                    Text(verbatim: line.text)
                        .font(.system(size: fontSize))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(1)
                        .truncationMode(.head)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .opacity(index == 0 && lines.count > 1 ? 0.5 : 1)
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .easeOut(duration: 0.2), value: lines.map(\.id))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
        .accessibilityLabel(Text("Live captions"))
        .accessibilityAction(named: Text("Interrupt"), onInterrupt)
    }

    private func speaker(_ from: CallLine.From) -> Text {
        switch from {
        case .user: Text("You")
        case .voice: Text(verbatim: "OpenDuet")
        }
    }
}
