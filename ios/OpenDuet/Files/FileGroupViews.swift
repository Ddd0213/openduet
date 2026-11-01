// M26: the pieces of a grouped Files list (FileListSection, FileGroups). A task group's top row:
// the task's tile, its title (or "Deleted task") and how many files, then a chevron. Tapping the
// title opens the task (nothing for a deleted one); the chevron folds and unfolds the group. And
// the short note under a list when a delete found the original already gone.
import SwiftUI

struct FileTaskGroupHeader: View {
    /// nil: the task was deleted since
    var title: String?
    var count: Int
    var expanded: Bool
    /// nil: nothing to open (a task deleted since)
    var onOpenTask: (() -> Void)?
    var onToggle: () -> Void

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var countSize: CGFloat = 13.5

    var body: some View {
        HStack(spacing: 0) {
            if let onOpenTask {
                Button(action: onOpenTask) { label }
                    .buttonStyle(RowPressStyle())
                    .accessibilityHint(Text("Opens the task"))
            } else {
                label
            }
            Button(action: onToggle) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.secondaryText.opacity(0.7))
                    .rotationEffect(.degrees(expanded ? 180 : 0))
                    .frame(width: 44)
                    .frame(maxHeight: .infinity)
                    .padding(.trailing, 6)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle(scale: 0.9))
            .accessibilityLabel(expanded ? Text("Show less") : Text("Show more"))
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var label: some View {
        HStack(spacing: 12) {
            RowSymbol(systemImage: DuetGlyph.task.symbol, tint: title == nil ? Palette.secondaryText : Palette.tileGlyph)
            VStack(alignment: .leading, spacing: 2) {
                Group {
                    if let title { Text(verbatim: title) } else { Text("Deleted task") }
                }
                .font(.system(size: titleSize, weight: .medium))
                .foregroundStyle(title == nil ? Palette.secondaryText : Palette.primaryText)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                Group {
                    if count == 1 { Text("1 file") } else { Text("\(count) files") }
                }
                .font(.system(size: countSize))
                .foregroundStyle(Palette.secondaryText)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, 16)
        .padding(.trailing, 4)
        .padding(.vertical, 10)
        .frame(minHeight: Metrics.sheetRowMinHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// "It was already gone from OpenDuet's computer." in small grey under a list.
struct WorkspaceGoneNote: View {
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 13

    var body: some View {
        let lift = fontSize * 0.3
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            DuetIcon(glyph: .info, size: fontSize + 1, tint: Palette.secondaryText)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + lift }
                .accessibilityHidden(true)
            Text("It was already gone from OpenDuet's computer.")
                .font(.system(size: fontSize))
                .foregroundStyle(Palette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 6)
        .accessibilityElement(children: .combine)
        .onAppear {
            AccessibilityNotification.Announcement(String(localized: "It was already gone from OpenDuet's computer.")).post()
        }
    }
}
