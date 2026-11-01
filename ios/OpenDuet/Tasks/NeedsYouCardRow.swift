// M22 (review-ux §3): a card waiting on the user outside any task (an approval, a form, a
// sign-in or a connection request in the chat or a channel), at the top of "Waiting on you".
// Laid out like a task row: the needs-input mark where the checkbox is, the card's title,
// "Needs input · <detail>" and the channel when it's outside the tab's scope. A tap opens the
// card in its thread (duet://channels/<id>?message=<id>: the Chat tab scrolls to it).
import SwiftUI

struct NeedsYouCardRow: View {
    var card: NeedsYouItem.Card
    /// "#name" when the card's channel is outside the tab's scope (as a task row's tag line)
    var channelTag: String?
    var channelColor: ChannelColor?
    var onOpen: () -> Void

    @Environment(\.locale) private var locale
    @Environment(\.colorScheme) private var colorScheme
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = Metrics.taskRowTitle
    @ScaledMetric(relativeTo: .subheadline) private var lineSize: CGFloat = Metrics.taskStatusLine
    @ScaledMetric(relativeTo: .body) private var box: CGFloat = Metrics.taskCheckbox

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 12) {
                TaskStatusGlyph(status: .needsInput, size: box - 4)
                    .frame(width: box, height: box)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: card.title)
                        .font(.system(size: titleSize, weight: .medium))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        Text(TaskStatus.needsInput.word)
                            .foregroundStyle(TaskStatus.needsInput.color)
                            .fixedSize()
                            .layoutPriority(1)
                        Text(verbatim: " · ")
                            .foregroundStyle(Palette.secondaryText)
                            .accessibilityHidden(true)
                        Text(verbatim: PhraseText.string(card.detail, locale: locale))
                            .foregroundStyle(Palette.secondaryText)
                            .lineLimit(1)
                    }
                    .font(.system(size: lineSize))
                    if let channelTag {
                        HStack(alignment: .center, spacing: 5) {
                            if let channelColor {
                                Circle()
                                    .fill(channelColor.glyph(in: colorScheme))
                                    .frame(width: Metrics.taskChannelDot, height: Metrics.taskChannelDot)
                                    .accessibilityHidden(true)
                            }
                            Text(verbatim: "#\(channelTag)")
                        }
                        .font(.system(size: lineSize - 2))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.99))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(Text("Opens it in the chat"))
    }
}
