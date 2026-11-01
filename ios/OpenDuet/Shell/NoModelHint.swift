// M12 the quiet line above the composer while no model is set up (Me.features.models false):
// "No model set up yet · Set up". Set up opens Everything → Models; the line goes away by itself
// once a model is configured (the session refreshes Me after a change there).
import SwiftUI

struct NoModelHint: View {
    var onSetUp: () -> Void

    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13.5

    var body: some View {
        HStack(spacing: 6) {
            DuetIcon(glyph: .notSetUp, size: fontSize + 2, tint: Palette.secondaryText)
                .accessibilityHidden(true)
            Text("No model set up yet")
                .foregroundStyle(Palette.secondaryText)
            Text(verbatim: "·")
                .foregroundStyle(Palette.secondaryText)
                .accessibilityHidden(true)
            Button(action: onSetUp) {
                Text("Set up")
                    .fontWeight(.semibold)
                    .foregroundStyle(Palette.accent)
                    .frame(minHeight: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(Text("Opens Models"))
        }
        .font(.system(size: fontSize))
        .lineLimit(2)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .accessibilityElement(children: .contain)
    }
}
