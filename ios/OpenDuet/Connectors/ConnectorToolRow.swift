// One tool of a connector (prompt L126, L167): its name and what it does, with an Ask / Always
// picker saved to ToolPolicy. The picker shows the tapped mode right away (optimistic) while
// the request runs; a failure puts the reason under the row with Retry, and the store's mode
// (unchanged) shows again.
import SwiftUI

struct ConnectorToolRow: View {
    var tool: ConnectorTool
    /// The mode to show: the pending choice while its request runs, else the tool's own.
    var mode: PolicyMode?
    var request: CardRequest?
    var onSelect: (PolicyMode) -> Void
    var onRetry: () -> Void

    @ScaledMetric(relativeTo: .body) private var nameSize: CGFloat = 15.5
    @ScaledMetric(relativeTo: .footnote) private var descriptionSize: CGFloat = 13

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: tool.name)
                        .font(.system(size: nameSize, weight: .medium))
                        .foregroundStyle(Palette.primaryText)
                        .fixedSize(horizontal: false, vertical: true)
                    if !tool.description.isEmpty {
                        Text(verbatim: tool.description)
                            .font(.system(size: descriptionSize))
                            .foregroundStyle(Palette.secondaryText)
                            .lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                PolicyPicker(mode: mode, alwaysDisabled: !tool.alwaysAllowed, onSelect: onSelect)
                    .accessibilityLabel(Text(verbatim: tool.name))
            }
            // M20: why Always is off for this tool (safety floor, or it sends to other people).
            if let line = ApprovalAlwaysRules.blockedLine(alwaysAllowed: tool.alwaysAllowed, reason: tool.alwaysBlocked) {
                Text(verbatim: line)
                    .font(.system(size: descriptionSize))
                    .foregroundStyle(Palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if case .failed(let reason) = request {
                InlineFailure(reason: reason, onRetry: onRetry)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .animation(.easeInOut(duration: 0.2), value: request)
        .sensoryFeedback(.warning, trigger: request) { _, new in new?.failureReason != nil }
    }
}

/// "Read" / "Write" above a group of tools, with what its default means.
struct ToolGroupHeader: View {
    var access: ConnectorTool.Access

    @ScaledMetric(relativeTo: .caption) private var noteSize: CGFloat = 12.5

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            SheetSectionTitle(text: access == .read ? Text("Read") : Text("Write"))
                .padding(.bottom, -6)
            (access == .read
                ? Text("Looking things up. OpenDuet does these without asking by default.")
                : Text("Sending, changing or deleting. OpenDuet asks you first by default."))
                .font(.system(size: noteSize))
                .foregroundStyle(Palette.secondaryText)
                .padding(.horizontal, 6)
                .padding(.bottom, 6)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
