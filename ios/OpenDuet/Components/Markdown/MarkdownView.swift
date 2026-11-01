// Renders parsed markdown (prompt L100, L183): paragraphs, headings, lists and checklists,
// quotes, code blocks, tables and rules. Text is selectable; 17 pt scales with Dynamic Type.
// M8 rhythm: each block's space above depends only on it and the block before it (more air
// before a heading, less after it), so while a reply streams in no earlier line moves.
import SwiftUI

struct MarkdownView: View {
    var blocks: [MarkdownBlock]
    var color: Color = Palette.assistantText
    /// A top-level paragraph that is one bare web link shows as a link chip. AssistantBubble turns
    /// it off while the reply streams (the last paragraph may still grow).
    var linkChips = false
    /// Blocks inside a list item or quote: a tighter rhythm.
    var nested = false

    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 17

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                MarkdownBlockView(block: block, bodySize: bodySize, color: color, linkChips: linkChips && !nested)
                    .padding(.top, index == 0 ? 0 : MarkdownRhythm.gap(above: block, after: blocks[index - 1], body: bodySize) * (nested ? 0.6 : 1))
            }
        }
    }
}

/// The space above a block, from it and the block before it.
enum MarkdownRhythm {
    static func gap(above block: MarkdownBlock, after previous: MarkdownBlock, body: CGFloat) -> CGFloat {
        let unit = body / 17
        switch (previous, block) {
        case (_, .heading(let level, _)): return (level <= 2 ? 20 : 16) * unit
        case (.heading, _): return 6 * unit
        case (_, .code), (.code, _), (_, .table), (.table, _), (_, .rule), (.rule, _): return 12 * unit
        default: return 10 * unit
        }
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    let bodySize: CGFloat
    let color: Color
    let linkChips: Bool

    /// M6: artifact link pills show their type icon.
    @Environment(\.artifactTypes) private var artifactTypes

    var body: some View {
        switch block {
        case .paragraph(let inlines):
            if linkChips, let url = MarkdownText.bareLink(inlines) {
                LinkChip(url: url)
            } else {
                paragraph(inlines, style: MarkdownTextStyle(size: bodySize, color: color, artifactTypes: artifactTypes))
            }
        case .heading(let level, let inlines):
            let scale: CGFloat = level == 1 ? 1.28 : level == 2 ? 1.14 : 1.0
            paragraph(inlines, style: MarkdownTextStyle(size: bodySize * scale, weight: .semibold, color: color, artifactTypes: artifactTypes))
                .accessibilityAddTraits(.isHeader)
        case .list(let list):
            MarkdownListView(list: list, bodySize: bodySize, color: color)
        case .quote(let blocks):
            HStack(alignment: .top, spacing: 12) {
                Capsule().fill(Palette.secondaryText.opacity(0.4)).frame(width: 3)
                MarkdownView(blocks: blocks, color: color.opacity(0.72), nested: true)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let code, _):
            MarkdownCodeBlock(language: language, code: code)
        case .table(let table):
            MarkdownTableView(table: table, bodySize: bodySize, color: color)
        case .rule:
            Rectangle().fill(Palette.primaryText.opacity(0.12)).frame(height: 1).padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func paragraph(_ inlines: [MarkdownInline], style: MarkdownTextStyle) -> some View {
        if MarkdownText.hasTaskLink(inlines) {
            // Only paragraphs with a task pill read the live task statuses.
            TaskLinkParagraph(inlines: inlines, style: style)
        } else {
            MarkdownParagraph(text: MarkdownText.text(inlines, style: style), size: style.size, renderer: MarkdownText.needsRenderer(inlines))
        }
    }
}

/// A paragraph with task / artifact pills: the pills' icons follow the tasks' live status.
private struct TaskLinkParagraph: View {
    let inlines: [MarkdownInline]
    let style: MarkdownTextStyle

    @Environment(\.cardContext) private var context

    var body: some View {
        var style = style
        style.taskStatuses = context.taskStatuses
        return MarkdownParagraph(text: MarkdownText.text(inlines, style: style), size: style.size, renderer: true)
    }
}

/// One paragraph or heading as a single selectable Text; the renderer draws pills and inline code.
struct MarkdownParagraph: View {
    let text: Text
    let size: CGFloat
    let renderer: Bool

    var body: some View {
        let base = text
            .lineSpacing(size * 0.15)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
        if renderer {
            base.textRenderer(TaskPillRenderer())
        } else {
            base
        }
    }
}

extension EnvironmentValues {
    /// How deep a markdown list sits (0 = top level): nested bullets are hollow.
    @Entry var markdownListDepth = 0
}

private struct MarkdownListView: View {
    let list: MarkdownList
    let bodySize: CGFloat
    let color: Color

    @Environment(\.markdownListDepth) private var depth

    var body: some View {
        VStack(alignment: .leading, spacing: bodySize * 0.36) {
            ForEach(Array(list.items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: bodySize * 0.45) {
                    marker(index: index, item: item)
                        .frame(minWidth: list.ordered ? bodySize * 0.95 : bodySize * 0.55, alignment: list.ordered ? .trailing : .center)
                    MarkdownView(blocks: item.blocks, color: color, nested: true)
                }
            }
        }
        .environment(\.markdownListDepth, depth + 1)
    }

    @ViewBuilder
    private func marker(index: Int, item: MarkdownListItem) -> some View {
        if let checked = item.checked {
            MarkdownCheckbox(checked: checked, size: bodySize * 0.92)
        } else if let start = list.start {
            Text(verbatim: "\((start + index).formatted()).")
                .font(.system(size: bodySize).monospacedDigit())
                .foregroundStyle(color)
        } else {
            // A solid dot at the top level, a ring below it.
            Text(verbatim: depth == 0 ? "•" : "◦")
                .font(.system(size: bodySize, weight: depth == 0 ? .bold : .medium))
                .foregroundStyle(depth == 0 ? color : Palette.secondaryText)
                .accessibilityHidden(true)
        }
    }
}

/// A checklist box: a rounded outline, filled with a ✓ when done; it sits on the text's line.
private struct MarkdownCheckbox: View {
    let checked: Bool
    let size: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(checked ? Palette.accent : Color.clear)
            .overlay {
                if checked {
                    Image(glyph: .check)
                        .font(.system(size: size * 0.58, weight: .bold))
                        .foregroundStyle(.white)
                } else {
                    RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                        .strokeBorder(Palette.secondaryText.opacity(0.7), lineWidth: 1.3)
                }
            }
            .frame(width: size, height: size)
            // Centred on the text's x-height: the box's "baseline" sits just above its bottom.
            .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.bottom] - size * 0.12 }
            .accessibilityElement()
            .accessibilityLabel(checked ? Text("Done") : Text("Not done"))
    }
}

/// A bare web link on its own line (M8): a quiet chip with a globe tile, the domain and the
/// path, that opens like any link (openURL: the thread's Safari sheet).
struct LinkChip: View {
    var url: URL

    @Environment(\.openURL) private var openURL
    @ScaledMetric(relativeTo: .subheadline) private var titleSize: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var detailSize: CGFloat = 13
    @ScaledMetric(relativeTo: .subheadline) private var tileSize: CGFloat = 34

    private var domain: String {
        var host = url.host() ?? url.absoluteString
        if host.lowercased().hasPrefix("www.") { host.removeFirst(4) }
        return host
    }

    private var path: String? {
        let tidy = MarkdownText.tidy(url.absoluteString)
        guard let slash = tidy.firstIndex(of: "/") else { return nil }
        let rest = String(tidy[slash...])
        return rest.count > 1 ? rest : nil
    }

    var body: some View {
        Button { openURL(url) } label: {
            HStack(spacing: 10) {
                Image(glyph: .page)
                    .font(.system(size: tileSize * 0.46, weight: DuetGlyph.weight(for: tileSize * 0.46)))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(Palette.tileGlyph)
                    .frame(width: tileSize, height: tileSize)
                    .tileBackground(corner: tileSize * 0.26)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: domain)
                        .font(.system(size: titleSize, weight: .semibold))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(1)
                    Group {
                        if let path { Text(verbatim: path) } else { Text("Web page") }
                    }
                    .font(.system(size: detailSize))
                    .foregroundStyle(Palette.secondaryText)
                    .lineLimit(1)
                    .truncationMode(.middle)
                }
                Spacer(minLength: 4)
                Image(glyph: .forward)
                    .font(.system(size: detailSize, weight: .semibold))
                    .foregroundStyle(Palette.secondaryText)
            }
            .padding(.leading, 8)
            .padding(.trailing, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: 320, alignment: .leading)
            .cardSurface(corner: 14)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle(scale: 0.97))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Link, \(domain)"))
        .accessibilityHint(Text("Opens the page"))
        .accessibilityAddTraits(.isLink)
    }
}
