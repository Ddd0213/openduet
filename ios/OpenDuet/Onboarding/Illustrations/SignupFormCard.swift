// Page 3's mini browser card (prompt L25): an #EFEFEF top bar with three grey dots and a
// "cloud + OpenDuet's own computer" pill over a white body with "Conference sign-up" and the
// Name / Team / Dates fields (11pt grey labels over light-grey 30pt fields with 13pt text,
// 10pt between groups). The card and each field publish their bounds for the cursor.
import SwiftUI

enum SignupAnchor: Hashable {
    case card
    case field(Int)
}

struct SignupAnchorKey: PreferenceKey {
    static var defaultValue: [SignupAnchor: Anchor<CGRect>] { [:] }

    static func reduce(value: inout [SignupAnchor: Anchor<CGRect>], nextValue: () -> [SignupAnchor: Anchor<CGRect>]) {
        value.merge(nextValue()) { $1 }
    }
}

struct SignupFormCard: View {
    var script: SignupScript
    var t: Double

    var body: some View {
        VStack(spacing: 0) {
            SignupTopBar()
            VStack(alignment: .leading, spacing: 10) {
                Text("Conference sign-up")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(OnboardingTheme.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                field(0, label: "Full name")
                field(1, label: "Team")
                field(2, label: "Dates")
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onboardingCard(cornerRadius: 18)
        .transformAnchorPreference(key: SignupAnchorKey.self, value: .bounds) { $0[.card] = $1 }
    }

    private func field(_ i: Int, label: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(OnboardingTheme.grey)
                .lineLimit(1)
            Text(script.typed(i, at: t))
                .font(.system(size: 13))
                .foregroundStyle(OnboardingTheme.ink)
                .lineLimit(1)
                .padding(.horizontal, 10)
                .frame(maxWidth: .infinity, minHeight: 30, maxHeight: 30, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(OnboardingTheme.fieldFill))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(OnboardingTheme.accent.opacity(script.focus(i, at: t)), lineWidth: 1)
                )
                .anchorPreference(key: SignupAnchorKey.self, value: .bounds) { [.field(i): $0] }
        }
    }
}

/// Three grey window dots and the centred "OpenDuet's own computer" pill.
struct SignupTopBar: View {
    private static let dot: CGFloat = 7
    private static let dotGap: CGFloat = 5

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: Self.dotGap) {
                ForEach(0..<3, id: \.self) { _ in
                    Circle().fill(Color(hex: 0xC8C8C8)).frame(width: Self.dot, height: Self.dot)
                }
            }
            Spacer(minLength: 10)
            HStack(spacing: 5) {
                Image(systemName: "cloud.fill").font(.system(size: 10, weight: .semibold))
                Text("OpenDuet's own computer")
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .foregroundStyle(OnboardingTheme.body)
            .padding(.horizontal, 10)
            .frame(height: 22)
            .background(Capsule().fill(.white))
            Spacer(minLength: 10)
            // Balances the dots so the pill sits in the middle of the bar.
            Color.clear.frame(width: Self.dot * 3 + Self.dotGap * 2, height: Self.dot)
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
        .background(Color(hex: 0xEFEFEF))
    }
}
