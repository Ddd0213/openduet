// Small pieces of the thread (prompt L82, L101, L112): date separators, the wavy "New"
// divider, Seen / Delivered and the grey status bubble.
import SwiftUI

/// "Today 8:47 AM", centred in small grey, formatted by the app (locale and 12/24-hour).
struct DateSeparator: View {
    var date: Date

    @Environment(\.locale) private var locale
    @Environment(\.calendar) private var calendar
    @Environment(\.timeZone) private var timeZone
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13

    var body: some View {
        Text(verbatim: ChatDateFormat(locale: locale, calendar: calendar, timeZone: timeZone).separator(date))
            .font(.system(size: fontSize, weight: .medium))
            .foregroundStyle(Palette.secondaryText)
            .frame(maxWidth: .infinity)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A wavy grey squiggle across the thread with an orange "New" in the middle (L112).
struct NewDivider: View {
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13

    var body: some View {
        HStack(spacing: 10) {
            WavyLine().stroke(Palette.secondaryText.opacity(0.45), style: StrokeStyle(lineWidth: 1.2, lineCap: .round))
                .frame(height: 6)
            Text("New")
                .font(.system(size: fontSize, weight: .semibold))
                .foregroundStyle(Palette.accent)
            WavyLine().stroke(Palette.secondaryText.opacity(0.45), style: StrokeStyle(lineWidth: 1.2, lineCap: .round))
                .frame(height: 6)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("New messages"))
    }
}

struct WavyLine: Shape {
    var wavelength: CGFloat = 12

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let amplitude = rect.height / 2
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        var x = rect.minX
        var up = true
        while x < rect.maxX {
            let end = min(x + wavelength / 2, rect.maxX)
            let control = CGPoint(x: (x + end) / 2, y: rect.midY + (up ? -amplitude : amplitude) * 2)
            path.addQuadCurve(to: CGPoint(x: end, y: rect.midY), control: control)
            x = end
            up.toggle()
        }
        return path
    }
}

/// "Delivered" / "Seen" in small grey under the newest user message.
struct ReceiptLine: View {
    var status: Message.Status

    var body: some View {
        Group {
            switch status {
            case .sent: Text("Delivered")
            case .seen: Text("Seen")
            }
        }
        .font(Typography.caption)
        .foregroundStyle(Palette.secondaryText)
        .contentTransition(.opacity)
        .animation(.easeInOut(duration: 0.25), value: status)
        .padding(.trailing, UserBubbleShape.tailWidth + 4)
    }
}

/// The small grey status bubble while a run works ("Checking", "Reading now").
struct StatusBubble: View {
    var status: StatusKey

    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 14

    var body: some View {
        Text(status.title)
            .font(.system(size: fontSize, weight: .medium))
            .foregroundStyle(Palette.secondaryText)
            .contentTransition(.opacity)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .assistantBubbleBackground()
            .animation(.easeInOut(duration: 0.3), value: status)
            .accessibilityAddTraits(.updatesFrequently)
    }
}
