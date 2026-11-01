// Centred flow rows (onboarding page 2's chip list, prompt L23; later chip rows in chat).
// `.flowLineBreak()` starts a new row before a subview.
import SwiftUI

private struct FlowLineBreakKey: LayoutValueKey {
    static let defaultValue = false
}

extension View {
    /// Starts a new row of a CenteredFlowLayout before this view.
    func flowLineBreak(_ enabled: Bool = true) -> some View {
        layoutValue(key: FlowLineBreakKey.self, value: enabled)
    }
}

struct CenteredFlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func rows(for subviews: Subviews, maxWidth: CGFloat) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for (i, view) in subviews.enumerated() {
            let size = view.sizeThatFits(.unspecified)
            let width = min(size.width, maxWidth)
            let added = current.indices.isEmpty ? width : current.width + spacing + width
            if !current.indices.isEmpty && (view[FlowLineBreakKey.self] || added > maxWidth) {
                rows.append(current)
                current = Row()
            }
            current.width = current.indices.isEmpty ? width : current.width + spacing + width
            current.height = max(current.height, size.height)
            current.indices.append(i)
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        let rows = rows(for: subviews, maxWidth: maxWidth)
        let height = rows.reduce(0) { $0 + $1.height } + lineSpacing * CGFloat(max(rows.count - 1, 0))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(for: subviews, maxWidth: bounds.width) {
            var x = bounds.midX - row.width / 2
            for i in row.indices {
                let size = subviews[i].sizeThatFits(.unspecified)
                let width = min(size.width, bounds.width)
                subviews[i].place(
                    at: CGPoint(x: x, y: y + (row.height - size.height) / 2),
                    proposal: ProposedViewSize(width: width, height: size.height)
                )
                x += width + spacing
            }
            y += row.height + lineSpacing
        }
    }
}
