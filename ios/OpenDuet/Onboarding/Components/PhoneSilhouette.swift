// The light-grey phone silhouette behind onboarding pages 4 and 6 (prompt L27, L31): the
// top half with rounded top corners and a pill (page 4, fading out downward), or the bottom
// part with rounded bottom corners (page 6, fading out upward).
import SwiftUI

struct PhoneSilhouette: View {
    enum Visible { case top, bottom }

    var visible: Visible
    var cornerRadius: CGFloat = 44

    var body: some View {
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: visible == .top ? cornerRadius : 0,
            bottomLeadingRadius: visible == .bottom ? cornerRadius : 0,
            bottomTrailingRadius: visible == .bottom ? cornerRadius : 0,
            topTrailingRadius: visible == .top ? cornerRadius : 0,
            style: .continuous
        )
        shape
            .fill(OnboardingTheme.silhouette)
            .overlay(alignment: .top) {
                if visible == .top {
                    Capsule().fill(Color(hex: 0xCFCFCF)).frame(width: 84, height: 24).padding(.top, 14)
                }
            }
            .mask(
                LinearGradient(
                    stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.45), .init(color: .clear, location: 1)],
                    startPoint: visible == .top ? .top : .bottom,
                    endPoint: visible == .top ? .bottom : .top
                )
            )
            .accessibilityHidden(true)
    }
}

#Preview {
    VStack {
        PhoneSilhouette(visible: .top).frame(width: 300, height: 260)
        PhoneSilhouette(visible: .bottom).frame(width: 300, height: 260)
    }
}
