// Ask / Always (L126, L167), the connector detail's and custom connectors' policy control. M16:
// the category rows of "What OpenDuet has access to" are gone (apps are in Settings › Apps and
// connectors), so only the picker lives here.
import SwiftUI

/// Ask / Always for one tool or for "All tools" (L126, L167): a small capsule segmented control;
/// `mode` nil (mixed tools) selects neither segment ("Custom"). M20: `alwaysDisabled` dims and
/// disables only the Always segment (safety-floor and per-recipient tools always ask here).
struct PolicyPicker: View {
    var mode: PolicyMode?
    var disabled = false
    var alwaysDisabled = false
    var onSelect: (PolicyMode) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var selection
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13

    var body: some View {
        HStack(spacing: 2) {
            segment(.ask, title: Text("Ask"))
            segment(.always, title: Text("Always"))
                .opacity(alwaysDisabled ? 0.5 : 1)
                .disabled(alwaysDisabled)
        }
        .padding(2)
        .background(Capsule().fill(Palette.tile))
        .opacity(disabled ? 0.5 : 1)
        .disabled(disabled)
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.3, dampingFraction: 0.8), value: mode)
        .sensoryFeedback(.selection, trigger: mode)
        .accessibilityElement(children: .contain)
    }

    private func segment(_ value: PolicyMode, title: Text) -> some View {
        Button { if mode != value { onSelect(value) } } label: {
            title
                .font(.system(size: fontSize, weight: .semibold))
                .foregroundStyle(mode == value ? Palette.primaryText : Palette.secondaryText)
                .lineLimit(1)
                .padding(.horizontal, 12)
                .frame(minHeight: 30)
                .background {
                    if mode == value {
                        Capsule()
                            .fill(Palette.floatingSurface)
                            .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
                            .matchedGeometryEffect(id: "selected", in: selection)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(mode == value ? .isSelected : [])
    }
}
