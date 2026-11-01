// Onboarding page 4 (prompt L27): the top half of a light-grey phone silhouette with a white
// card over it (16pt from the screen edges) whose three rows slide up and fade in 0.2s apart.
// Titles 15pt and subtitles 12.5pt grey, each on one line (Chinese scales instead of clipping),
// 26pt icon squares, 12pt vertical padding per row, dividers. Reduce Motion: fades only.
import SwiftUI

struct SafetyIllustration: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var cardShown = false
    @State private var rowsShown = 0

    private struct Row {
        var symbol: String
        var tint: UInt32
        var glyph: UInt32
        var title: LocalizedStringKey
        var subtitle: LocalizedStringKey
    }

    private let rows = [
        Row(symbol: "pause.fill", tint: 0xFBEFC5, glyph: 0xB98900,
            title: "Pauses when something looks unsafe", subtitle: "OpenDuet stops and checks with you first."),
        Row(symbol: "switch.2", tint: 0xECE5FB, glyph: 0x7A55D6,
            title: "You set the permissions", subtitle: "Choose what OpenDuet can and can't do."),
        Row(symbol: "lock.fill", tint: 0xDFF3DA, glyph: 0x2E8B3E,
            title: "Private and secure", subtitle: "Your messages and data stay protected."),
    ]

    var body: some View {
        // The card spans the width it is given (the page places this view 16pt from the
        // screen edges); the phone is narrower, so the card overhangs it a little.
        GeometryReader { geo in
            let phoneHeight = min(geo.size.height - 8, 330)
            ZStack(alignment: .top) {
                PhoneSilhouette(visible: .top)
                    .padding(.horizontal, 20)
                    .frame(height: phoneHeight)
                card.padding(.top, 54)
            }
            .frame(width: geo.size.width, height: phoneHeight, alignment: .top)
            .position(x: geo.size.width / 2, y: geo.size.height / 2)
        }
        .task { await reveal() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("OpenDuet pauses when something looks unsafe, lets you set the permissions, and keeps your messages and data private."))
    }

    private var card: some View {
        VStack(spacing: 0) {
            ForEach(rows.indices, id: \.self) { i in
                row(rows[i], divider: i > 0)
                    .opacity(rowsShown > i ? 1 : 0)
                    .offset(y: rowsShown > i || reduceMotion ? 0 : 10)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 2)
        .onboardingCard(cornerRadius: 18)
        .opacity(cardShown ? 1 : 0)
        .offset(y: cardShown || reduceMotion ? 0 : 16)
    }

    private func row(_ row: Row, divider: Bool) -> some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(Color(hex: row.tint))
                .overlay(
                    Image(systemName: row.symbol)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color(hex: row.glyph))
                )
                .frame(width: 26, height: 26)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(OnboardingTheme.ink)
                Text(row.subtitle)
                    .font(.system(size: 12.5))
                    .foregroundStyle(OnboardingTheme.grey)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 12)
        .overlay(alignment: .top) {
            if divider {
                Rectangle().fill(OnboardingTheme.hairline).frame(height: 0.5).padding(.leading, 38)
            }
        }
    }

    /// The card rises first, then its rows follow 0.2s apart; restarts on every appearance.
    private func reveal() async {
        cardShown = false
        rowsShown = 0
        let motion: Animation = reduceMotion ? .easeOut(duration: 0.3) : .spring(duration: 0.5, bounce: 0.12)
        try? await Task.sleep(for: .seconds(0.15))
        guard !Task.isCancelled else { return }
        withAnimation(motion) { cardShown = true }
        for i in 1...rows.count {
            try? await Task.sleep(for: .seconds(0.2))
            guard !Task.isCancelled else { return }
            withAnimation(motion) { rowsShown = i }
        }
    }
}

#Preview {
    SafetyIllustration()
        .frame(height: 380)
        .padding(.horizontal, 16)
        .background(OnboardingTheme.background)
}
