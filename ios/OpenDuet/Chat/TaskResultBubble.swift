// M18 (.pi/mocks/m18-quick-replies.html, "做完后的聊天"): a done task's final result in the chat.
// A small grey "Done · title" line (TaskResultHeader) sits above an assistant bubble with the result's
// markdown. A long result folds to its first 12 lines with "Show more" / "Show less"
// (TaskResultFold). A footer under a hairline reads "title · N sources" with "See how ›" on
// the right; tapping it opens the task's conversation.
import SwiftUI

/// Which result messages the user expanded, by message id: shared by the row and its long-press
/// copy (BubbleMenuCopy), and kept while a row scrolls out of the lazy stack and back (in memory
/// only, so a relaunch starts folded). M19: one observable flag per id, so a toggle re-renders
/// only that bubble (one shared set made every result bubble in the thread depend on it).
@MainActor
final class TaskResultExpansion {
    static let shared = TaskResultExpansion()

    @MainActor @Observable
    final class Flag {
        fileprivate(set) var expanded = false
    }

    /// Not observed itself: a bubble observes only its own flag.
    private var flags: [ID: Flag] = [:]

    /// The id's flag (made on first use); read `expanded` on it to depend on that id only.
    func flag(_ id: ID) -> Flag {
        if let flag = flags[id] { return flag }
        let flag = Flag()
        flags[id] = flag
        return flag
    }

    func isExpanded(_ id: ID) -> Bool { flags[id]?.expanded ?? false }

    func toggle(_ id: ID) {
        flag(id).expanded.toggle()
    }
}

struct TaskResultBubble: View {
    /// The message's id (its expanded state lives in TaskResultExpansion).
    var messageId: ID
    var text: String
    var result: TaskResultInfo
    var streaming = false
    /// What VoiceOver reads for the text (no markdown markers) and its "OpenDuet, 8:47 AM" label.
    var accessibilityLabel: Text
    var accessibilityText: String
    var onOpenTask: () -> Void

    /// M19: this bubble's own flag only (reading it is the dependency).
    private var expanded: Bool { TaskResultExpansion.shared.flag(messageId).expanded }
    /// The laid-out text's full height; 0 until measured.
    @State private var measuredHeight: CGFloat = 0
    /// One 17 pt markdown line (MarkdownParagraph: 17 pt plus 15% line spacing).
    @ScaledMetric(relativeTo: .body) private var lineHeight: CGFloat = 23
    @ScaledMetric(relativeTo: .subheadline) private var footerSize: CGFloat = 13.5
    @ScaledMetric(relativeTo: .subheadline) private var toggleSize: CGFloat = 15

    /// Folds while measuring by the text's length, then by its measured height.
    private var long: Bool {
        measuredHeight > 0
            ? TaskResultFold.folds(height: measuredHeight, lineHeight: lineHeight)
            : TaskResultFold.isLong(text)
    }

    private var folded: Bool { long && !expanded }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !text.isEmpty {
                content
                    .bubbleAccessibility(label: accessibilityLabel, value: Text(verbatim: accessibilityText))
                if long { toggle }
            }
            footer
        }
        .padding(.horizontal, 16)
        .padding(.top, text.isEmpty ? 0 : 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .assistantBubbleBackground()
    }

    private var content: some View {
        MarkdownView(blocks: MarkdownCache.blocks(text, streaming: streaming), linkChips: !streaming)
            .fixedSize(horizontal: false, vertical: true)
            // M19: the first height is kept (from then on the fold follows the measurement, not the
            // length estimate, which can flip without the height changing), later ones only when
            // they change the fold: every other write re-rendered the bubble (and moved the
            // thread's measured bottom) for nothing.
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                if measuredHeight == 0 || TaskResultFold.folds(height: height, lineHeight: lineHeight) != long {
                    measuredHeight = height
                }
            }
            .frame(height: folded ? TaskResultFold.collapsedHeight(lineHeight: lineHeight) : nil, alignment: .top)
            .clipped()
            .mask(fade)
    }

    /// The folded text's last line fades into the bubble.
    private var fade: some View {
        LinearGradient(
            stops: [
                .init(color: .black, location: 0),
                .init(color: .black, location: folded ? 0.82 : 1),
                .init(color: .black.opacity(folded ? 0 : 1), location: 1),
            ],
            startPoint: .top, endPoint: .bottom
        )
    }

    private var toggle: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.3)) { TaskResultExpansion.shared.toggle(messageId) }
        } label: {
            Group {
                if expanded { Text("Show less") } else { Text("Show more") }
            }
            .font(.system(size: toggleSize, weight: .medium))
            .foregroundStyle(Palette.secondaryText)
            // A comfortable tap target without much visible height.
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.96))
    }

    private var footer: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(Palette.primaryText.opacity(0.10))
                .frame(height: 1)
                .accessibilityHidden(true)
            Button(action: onOpenTask) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    summary
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("See how ›")
                        .fixedSize()
                }
                .font(.system(size: footerSize))
                .foregroundStyle(Palette.secondaryText)
                // The whole row up to the bubble's bottom edge takes the tap.
                .padding(.top, 9)
                .padding(.bottom, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle(scale: 0.98))
            .accessibilityLabel(Text("Open task \(result.title)"))
        }
        .padding(.top, text.isEmpty ? 0 : 10)
    }

    /// "title · 2 sources": the title medium weight, the count grey; no count when 0.
    private var summary: Text {
        let title = Text(verbatim: result.title)
            .fontWeight(.medium)
            .foregroundStyle(Palette.primaryText.opacity(0.8))
        switch result.sourceCount {
        case 0: return title
        case 1: return Text("\(title) · 1 source")
        default: return Text("\(title) · \(result.sourceCount) sources")
        }
    }
}

/// "Done · title" (or "Ready for review · title") in small grey above the result's bubble.
struct TaskResultHeader: View {
    var result: TaskResultInfo

    @ScaledMetric(relativeTo: .caption) private var fontSize: CGFloat = 12.5

    var body: some View {
        Group {
            switch result.status {
            case .resolved: Text("Done · \(result.title)")
            case .readyForReview: Text("Ready for review · \(result.title)")
            }
        }
        .font(.system(size: fontSize))
        .foregroundStyle(Palette.secondaryText)
        .lineLimit(1)
        .padding(.leading, 4)
    }
}
