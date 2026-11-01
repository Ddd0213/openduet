// Empty states (prompt L184): a small outline illustration, one line and at most one action,
// in the app's visual language. M9: the symbol draws as the hand-drawn set (secondary ink with
// its clay accent) on the dashed rounded tile, then a capsule button.
import SwiftUI

struct EmptyStateView: View {
    var systemImage: String
    var message: LocalizedStringKey
    var actionTitle: LocalizedStringKey?
    var action: (() -> Void)?

    @ScaledMetric(relativeTo: .body) private var textSize: CGFloat = 15

    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(Palette.hairline, style: StrokeStyle(lineWidth: 1.5, dash: [5, 5]))
                    .frame(width: 84, height: 84)
                let symbol = IconTile.refined(systemImage)
                if let art = DuetArt(symbol: symbol) {
                    DuetArtView(art: art, size: 44, ink: Palette.secondaryText, accent: Palette.artAccent)
                } else {
                    Image(systemName: symbol)
                        .font(.system(size: 32, weight: .light))
                        .foregroundStyle(Palette.secondaryText)
                }
            }
            .accessibilityHidden(true)
            Text(message)
                .font(.system(size: textSize))
                .foregroundStyle(Palette.secondaryText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if let actionTitle, let action {
                Button(action: action) {
                    Text(actionTitle)
                        .font(.system(size: textSize, weight: .medium))
                        .foregroundStyle(Palette.primaryText)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 10)
                        .background(
                            Capsule()
                                .fill(Palette.floatingSurface)
                                .strokeBorder(Palette.hairline, lineWidth: Metrics.hairline)
                                .floatingShadow()
                        )
                }
                .buttonStyle(PressableButtonStyle())
            }
        }
        .padding(.horizontal, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
