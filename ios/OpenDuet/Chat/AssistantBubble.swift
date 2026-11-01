// An assistant bubble (prompt L82, L99-L100): left-aligned, #E7E7E7 / #1E1E1E fill, 17 pt text that
// scales with Dynamic Type, 20 pt continuous corners, markdown, selectable. The row caps its
// width at 80% of the thread (ThreadRowView).
import SwiftUI

struct AssistantBubble: View {
    var text: String
    /// The reply is still streaming in: a half-typed marker on its last line is hidden.
    var streaming = false

    var body: some View {
        // A bare link on its own line becomes a link chip once the reply is complete.
        // M19: parsed once per text (MarkdownCache), not on every pass of the thread.
        MarkdownView(blocks: MarkdownCache.blocks(text, streaming: streaming), linkChips: !streaming)
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .assistantBubbleBackground()
    }
}

extension View {
    /// The assistant bubble surface, shared with the typing indicator and the status bubble. M21: the
    /// 0.5 pt top-edge light and the soft card shadow (none in dark), on the shape behind the text.
    func assistantBubbleBackground() -> some View {
        let shape = RoundedRectangle(cornerRadius: Metrics.bubbleCorner, style: .continuous)
        return background(
            shape
                .fill(Palette.assistantBubble)
                .glassEdge(shape)
                .surfaceShadow(.card)
        )
    }

    /// One VoiceOver element per bubble: "OpenDuet, 8:47 AM" then the text.
    func bubbleAccessibility(label: Text, value: Text) -> some View {
        accessibilityElement(children: .combine)
            .accessibilityLabel(label)
            .accessibilityValue(value)
    }
}
