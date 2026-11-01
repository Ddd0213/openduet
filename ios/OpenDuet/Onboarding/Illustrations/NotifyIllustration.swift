// Onboarding page 6 (prompt L31): a light-grey phone silhouette (rounded bottom corners, top
// fading out) with a dock of four white rounded squares; at 0.6s a notification banner springs
// down into it: a white rounded card with the mascot icon tile, "OpenDuet" bold 13pt, "now"
// grey on the right, and "Your prep for Launch review is ready.". Reduce Motion: it fades in.
import SwiftUI

struct NotifyIllustration: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var bannerShown = false

    private static let dockSquare: CGFloat = 50
    private static let dockBottom: CGFloat = 24
    /// The banner rests this far above the dock.
    private static let bannerGap: CGFloat = 40

    var body: some View {
        GeometryReader { geo in
            let phoneHeight = min(geo.size.height - 8, 320)
            ZStack(alignment: .bottom) {
                PhoneSilhouette(visible: .bottom)
                dock.padding(.bottom, Self.dockBottom)
                banner
                    .padding(.horizontal, 14)
                    .padding(.bottom, Self.dockBottom + Self.dockSquare + Self.bannerGap)
            }
            .padding(.horizontal, 18)
            .frame(width: geo.size.width, height: phoneHeight)
            .position(x: geo.size.width / 2, y: geo.size.height / 2)
        }
        .task {
            bannerShown = false
            try? await Task.sleep(for: .seconds(0.6))
            guard !Task.isCancelled else { return }
            withAnimation(reduceMotion ? .easeOut(duration: 0.35) : .spring(response: 0.5, dampingFraction: 0.72)) {
                bannerShown = true
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("An OpenDuet notification: Your prep for Launch review is ready."))
    }

    /// The dock: a row of four white rounded squares.
    private var dock: some View {
        HStack(spacing: 18) {
            ForEach(0..<4, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .fill(.white)
                    .frame(width: Self.dockSquare, height: Self.dockSquare)
            }
        }
    }

    private var banner: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(.white)
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(OnboardingTheme.hairline, lineWidth: 0.5))
                .overlay(MascotStill(size: 20))
                .frame(width: 34, height: 34)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    // A product name: never translated.
                    Text("OpenDuet")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(OnboardingTheme.ink)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text("now")
                        .font(.system(size: 12))
                        .foregroundStyle(OnboardingTheme.grey)
                        .lineLimit(1)
                }
                Text("Your prep for Launch review is ready.")
                    .font(.system(size: 13))
                    .foregroundStyle(OnboardingTheme.ink)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 11)
        .onboardingCard(cornerRadius: 20)
        .opacity(bannerShown ? 1 : 0)
        .offset(y: bannerShown || reduceMotion ? 0 : -70)
    }
}

#Preview {
    NotifyIllustration()
        .frame(height: 380)
        .padding(.horizontal, OnboardingTheme.sideMargin)
        .background(OnboardingTheme.background)
}
