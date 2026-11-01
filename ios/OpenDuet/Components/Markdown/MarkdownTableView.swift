// A GFM table (prompt L183): a grid with a tinted header row and hairlines, scrolling sideways
// when it is wider than the bubble. Cells keep to one line; the scroll shows the rest. M8: the
// same surface and rim as a code block, the header bar tinted like a code block's.
import SwiftUI

struct MarkdownTableView: View {
    var table: MarkdownTable
    var bodySize: CGFloat
    var color: Color

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(table.header.indices, id: \.self) { column in
                        cell(table.header[column], column: column, header: true)
                    }
                }
                .background(Palette.codeHeader)
                ForEach(table.rows.indices, id: \.self) { row in
                    Rectangle().fill(Palette.codeRim).frame(height: Metrics.hairline)
                    GridRow {
                        ForEach(table.rows[row].indices, id: \.self) { column in
                            cell(table.rows[row][column], column: column, header: false)
                        }
                    }
                }
            }
            .background(Palette.codeSurface)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Palette.codeRim, lineWidth: Metrics.hairline)
            )
        }
    }

    private func cell(_ inlines: [MarkdownInline], column: Int, header: Bool) -> some View {
        let style = MarkdownTextStyle(size: bodySize * 0.88, weight: header ? .semibold : .regular, color: color)
        return MarkdownParagraph(text: MarkdownText.text(inlines, style: style), size: style.size, renderer: MarkdownText.needsRenderer(inlines))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .gridColumnAlignment(alignment(column))
    }

    private func alignment(_ column: Int) -> HorizontalAlignment {
        guard column < table.alignments.count else { return .leading }
        switch table.alignments[column] {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}
