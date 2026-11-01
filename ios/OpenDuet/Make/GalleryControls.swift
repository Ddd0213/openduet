// M24 (prompt L147): the row under the hero card: type filter chips (All, then only the types that
// have items; picking one leaves just its items) and one button opening a menu: Show as list /
// Show as grid, and sort by Last opened / Last modified / Title (one setting for every section,
// remembered by MakeTabView's @AppStorage).
import SwiftUI

struct GalleryControls: View {
    var types: [ArtifactType]
    @Binding var filter: ArtifactType?
    @Binding var layout: GalleryLayout
    @Binding var sort: GallerySort

    var body: some View {
        HStack(spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    GalleryFilterChip(title: Text("All"), on: filter == nil) { filter = nil }
                    ForEach(types) { type in
                        GalleryFilterChip(title: Text(type.title), on: filter == type) { filter = type }
                    }
                }
                .padding(.leading, Metrics.threadInset)
                .padding(.vertical, 2)
            }
            .padding(.leading, -Metrics.threadInset)
            menu
        }
        .sensoryFeedback(.selection, trigger: filter)
        .sensoryFeedback(.selection, trigger: layout)
        .sensoryFeedback(.selection, trigger: sort)
    }

    private var menu: some View {
        Menu {
            Section {
                Picker(selection: $layout) {
                    Label { Text("Show as list") } icon: { Image(systemName: "list.bullet") }.tag(GalleryLayout.list)
                    Label { Text("Show as grid") } icon: { Image(systemName: "square.grid.2x2") }.tag(GalleryLayout.grid)
                } label: {
                    EmptyView()
                }
                .pickerStyle(.inline)
            }
            Section {
                Picker(selection: $sort) {
                    Text("Last opened").tag(GallerySort.lastOpened)
                    Text("Last modified").tag(GallerySort.lastModified)
                    Text("Title").tag(GallerySort.title)
                } label: {
                    EmptyView()
                }
                .pickerStyle(.inline)
            } header: {
                Text("Sort by")
            }
        } label: {
            DuetIcon(glyph: .sort, size: 20, tint: Palette.primaryText)
                .frame(width: 40, height: 36)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(Text("View options"))
    }
}

/// One filter chip: filled while picked.
private struct GalleryFilterChip: View {
    var title: Text
    var on: Bool
    var action: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 14

    var body: some View {
        Button(action: action) {
            title
                .font(.system(size: fontSize, weight: .semibold))
                .foregroundStyle(on ? Palette.filledButtonText : Palette.primaryText)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 14)
                .frame(minHeight: 34)
                .background(Capsule().fill(on ? Palette.filledButton : Palette.tile))
                .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.95))
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
        .animation(.easeInOut(duration: 0.2), value: on)
    }
}
