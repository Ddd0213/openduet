// User bubbles (prompt L82): right-aligned peach #F4D0BE (dark #461A16, text #F3E3DD) with an
// iMessage-style tail on the last bubble of a run. Every user bubble reserves the tail's width
// so a run's right edges line up. Attachments sit above the text as image bubbles / file cards.
import SwiftUI

struct UserBubble: View {
    var text: String
    var tail: Bool

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 17

    var body: some View {
        // The user's own words (data, not UI copy).
        Text(verbatim: text)
            .font(.system(size: fontSize))
            .foregroundStyle(Palette.userText)
            .multilineTextAlignment(.leading)
            .textSelection(.enabled)
            .padding(.leading, 16)
            .padding(.trailing, 16 + UserBubbleShape.tailWidth)
            .padding(.vertical, 10)
            // M21: the 0.5 pt top-edge light and the soft card shadow (none in dark), on the shape.
            .background(
                UserBubbleShape(tail: tail)
                    .fill(Palette.userBubble)
                    .glassEdge(UserBubbleShape(tail: tail))
                    .surfaceShadow(.card)
            )
    }
}

/// A user message of kind "text": its attachments, then the text bubble. M26: a deleted
/// attachment shows as the deleted image placeholder / file card (ImageBubble, FileCard), which
/// never load or open it.
struct UserMessageView: View {
    var text: String
    var attachments: [ChannelFile]
    var tail: Bool
    var accessibilityLabel: Text
    var onOpenFile: (ChannelFile) -> Void
    /// M9: the text bubble's long-press menu (the message and its reactions / ratings actions).
    var menu: (message: Message, actions: ChatExtrasActions)? = nil

    var body: some View {
        VStack(alignment: .trailing, spacing: Metrics.bubbleSpacing) {
            ForEach(attachments) { file in
                Group {
                    if file.isImage {
                        ImageBubble(file: file)
                    } else {
                        FileCard(file: file) { onOpenFile(file) }
                    }
                }
                .padding(.trailing, UserBubbleShape.tailWidth)
            }
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                bubble
            }
        }
    }

    @ViewBuilder
    private var bubble: some View {
        let base = UserBubble(text: text, tail: tail)
            .bubbleAccessibility(label: accessibilityLabel, value: Text(verbatim: text))
        if let menu {
            base.bubbleMenu(menu.message, tail: tail, actions: menu.actions)
        } else {
            base
        }
    }
}

/// A rounded bubble whose bottom-right corner becomes an iMessage-style tail when `tail` is set.
/// One continuous outline: the right side runs straight down into one curve that flares out to
/// the tip at the bottom-right, and the bottom edge stays straight from the tip to the
/// bottom-left corner (no notch, so no wave along the bottom; the tip is slightly rounded, not a
/// needle). Corners are circular arcs, r = min(20, h/2, w/2), so bubbles with and without a tail
/// line up in a run. Every bubble reserves `tailWidth`; nothing is drawn outside the frame.
struct UserBubbleShape: Shape {
    var tail: Bool
    static let tailWidth: CGFloat = 6

    func path(in rect: CGRect) -> Path {
        let right = rect.maxX - Self.tailWidth
        let width = right - rect.minX
        guard width > 0, rect.height > 0 else { return Path() }
        let radius = min(Metrics.bubbleCorner, rect.height / 2, width / 2)
        let topLeft = CGPoint(x: rect.minX, y: rect.minY)
        let topRight = CGPoint(x: right, y: rect.minY)
        let bottomRight = CGPoint(x: right, y: rect.maxY)
        let bottomLeft = CGPoint(x: rect.minX, y: rect.maxY)

        var path = Path()
        path.move(to: CGPoint(x: rect.minX + radius, y: rect.minY))
        path.addArc(tangent1End: topRight, tangent2End: bottomRight, radius: radius)
        if tail {
            addTail(to: &path, in: rect, right: right, radius: radius)
        } else {
            path.addArc(tangent1End: bottomRight, tangent2End: bottomLeft, radius: radius)
        }
        path.addArc(tangent1End: bottomLeft, tangent2End: topLeft, radius: radius)
        path.addArc(tangent1End: topLeft, tangent2End: topRight, radius: radius)
        path.closeSubpath()
        return path
    }

    /// From the right side down and out to the tip at the bottom-right, then onto the bottom
    /// edge. Ends on the bottom edge, ready for the straight run to the bottom-left corner.
    private func addTail(to path: inout Path, in rect: CGRect, right: CGFloat, radius: CGFloat) {
        let bottom = rect.maxY
        // How far up the right side the tail starts (never above the top-right corner).
        let rise = max(min(14, rect.height - radius), 0)
        // Just short of the tip; a small round there takes the outline onto the bottom edge.
        let nearTip = CGPoint(x: rect.maxX - 0.6, y: bottom - 0.35)

        path.addLine(to: CGPoint(x: right, y: bottom - rise))
        // Leaves the right side vertically and flares out and down toward the tip.
        path.addCurve(
            to: nearTip,
            control1: CGPoint(x: right, y: bottom - rise * 0.4),
            control2: CGPoint(x: nearTip.x - 2.2, y: nearTip.y - 1.6)
        )
        path.addQuadCurve(to: CGPoint(x: rect.maxX - 1.6, y: bottom), control: CGPoint(x: rect.maxX + 0.2, y: bottom))
    }
}
