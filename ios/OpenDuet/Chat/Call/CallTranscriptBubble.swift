// One line of a call's transcript: the user's on the right in their bubble colour, the voice's on
// the left in the assistant's, with the time under it.
import SwiftUI

struct CallTranscriptBubble: View {
    var line: CallLine

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 16
    @ScaledMetric(relativeTo: .caption) private var timeSize: CGFloat = 11.5

    private var mine: Bool { line.from == .user }

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
            Text(verbatim: line.text)
                .font(.system(size: fontSize))
                .foregroundStyle(mine ? Palette.userText : Palette.assistantText)
                .textSelection(.enabled)
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(mine ? Palette.userBubble : Palette.assistantBubble)
                )
            Text(verbatim: ChatDateFormat(locale: locale).time(line.at))
                .font(.system(size: timeSize))
                .foregroundStyle(Palette.secondaryText)
                .padding(.horizontal, 6)
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        .padding(mine ? .leading : .trailing, 48)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(mine ? Text("You") : Text(verbatim: "OpenDuet"))
        .accessibilityValue(Text(verbatim: "\(line.text), \(ChatDateFormat(locale: locale).time(line.at))"))
    }
}
