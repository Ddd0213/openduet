// Why the waveform didn't start a call, above the composer (never an alert): no voice model
// ("Set up" opens Everything → Voice), the microphone is off ("Settings" opens the app's page in
// iOS Settings), another call is open, or the server's reason.
import SwiftUI

struct CallNoteLine: View {
    var note: CallNote
    var onSetUp: () -> Void

    @Environment(\.openURL) private var openURL
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            DuetIcon(glyph: icon, size: fontSize + 2, tint: Palette.secondaryText)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                .accessibilityHidden(true)
            Text(verbatim: note.text)
                .foregroundStyle(Palette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            if let action {
                Button(action: action.run) {
                    action.title
                        .fontWeight(.semibold)
                        .foregroundStyle(Palette.accent)
                        .frame(minHeight: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .font(.system(size: fontSize))
        .multilineTextAlignment(.trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.horizontal, 12)
        .accessibilityElement(children: .contain)
    }

    private var icon: DuetGlyph {
        switch note {
        case .setup: .notSetUp
        case .microphone, .busy, .channelOnly: .info
        case .failed: .warning
        }
    }

    private var action: (title: Text, run: () -> Void)? {
        switch note {
        case .setup:
            return (Text("Set up"), onSetUp)
        case .microphone:
            return (Text("Settings"), {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            })
        case .busy, .failed, .channelOnly:
            return nil
        }
    }
}
