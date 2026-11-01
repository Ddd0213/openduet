// Quote reply (M8 contract §2): the grey quoted block above the user's bubble and the composer's
// quote chip. M9: the swipe right that sets the quote is part of the bubble's one horizontal
// gesture (Chat/BubbleMenu/BubbleSwipe.swift), and Reply in the bubble menu does the same.
import SwiftUI

/// The quoted assistant text above a user bubble: a small grey rounded block with a leading bar.
struct QuotedBlock: View {
    var excerpt: String

    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 14

    var body: some View {
        HStack(spacing: 8) {
            Capsule()
                .fill(Palette.secondaryText.opacity(0.5))
                .frame(width: 3)
            Text(verbatim: excerpt)
                .font(.system(size: fontSize))
                .foregroundStyle(Palette.secondaryText)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 7)
        .padding(.leading, 8)
        .padding(.trailing, 12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.assistantBubble.opacity(0.7)))
        .padding(.trailing, UserBubbleShape.tailWidth)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Replying to OpenDuet: \(excerpt)"))
    }
}

/// "Replying to OpenDuet" + a one-line excerpt + ✕, above the composer while a quote is set.
struct QuoteChip: View {
    var quote: ReplyQuote
    var onRemove: () -> Void

    @ScaledMetric(relativeTo: .footnote) private var titleSize: CGFloat = 13
    @ScaledMetric(relativeTo: .subheadline) private var excerptSize: CGFloat = 14

    var body: some View {
        HStack(spacing: 10) {
            Capsule()
                .fill(Palette.accent)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 1) {
                Text("Replying to OpenDuet")
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                Text(verbatim: quote.excerpt)
                    .font(.system(size: excerptSize))
                    .foregroundStyle(Palette.secondaryText)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Palette.secondaryText)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(Palette.tile))
                    .contentShape(Circle())
            }
            .buttonStyle(PressableButtonStyle(scale: 0.88))
            .accessibilityLabel(Text("Remove quote"))
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.leading, 12)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Palette.floatingSurface)
                .strokeBorder(Palette.hairline, lineWidth: Metrics.hairline)
                .floatingShadow()
        )
    }
}
