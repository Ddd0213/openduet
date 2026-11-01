// Centred grey lines (prompt L112-L113): server phrases ("OpenDuet set a reminder for ...",
// "Thanks for the feedback") and the usage-limit line with its "Get more usage" button.
import SwiftUI

struct SystemLine: View {
    var phrase: Phrase

    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13

    var body: some View {
        PhraseText(phrase: phrase)
            .font(.system(size: fontSize))
            .foregroundStyle(Palette.secondaryText)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
    }
}

/// "⏱ Usage limit reached · resumes Thursday at 11:00 AM" and "Get more usage".
struct UsageLimitLine: View {
    var resumesAt: Date
    var onGetMore: () -> Void

    @Environment(\.locale) private var locale
    @Environment(\.calendar) private var calendar
    @Environment(\.timeZone) private var timeZone
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13

    var body: some View {
        let when = ChatDateFormat(locale: locale, calendar: calendar, timeZone: timeZone).relativeDayAndTime(resumesAt)
        VStack(spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                DuetIcon(glyph: .timer, size: fontSize + 3, tint: Palette.secondaryText)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                Text("Usage limit reached · resumes \(when)")
            }
            .font(.system(size: fontSize))
            .foregroundStyle(Palette.secondaryText)
            .multilineTextAlignment(.center)
            Button(action: onGetMore) {
                Text("Get more usage")
                    .font(.system(size: fontSize + 1, weight: .medium))
                    .foregroundStyle(Palette.primaryText)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(
                        Capsule()
                            .fill(Palette.floatingSurface)
                            .strokeBorder(Palette.hairline, lineWidth: Metrics.hairline)
                            .floatingShadow()
                    )
            }
            .buttonStyle(PressableButtonStyle())
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
    }
}
