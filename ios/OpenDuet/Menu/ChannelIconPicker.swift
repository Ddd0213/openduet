// The New channel sheet's "Change icon" panel (prompt L124): the 3×8 icon grid in the spec's
// order and the 9 colour swatches; every icon is drawn in the chosen colour, so a swatch tap
// re-tints the grid and the preview live. M10: the selected icon is outlined, not washed.
import SwiftUI

struct ChannelIconPicker: View {
    @Binding var icon: ChannelIcon
    @Binding var color: ChannelColor

    @Environment(\.colorScheme) private var colorScheme

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 8)

    var body: some View {
        VStack(spacing: 16) {
            LazyVGrid(columns: columns, spacing: 6) {
                ForEach(ChannelIcon.allCases, id: \.self) { item in
                    Button { icon = item } label: {
                        DuetArtView(art: item.art, size: 22, ink: color.glyph(in: colorScheme))
                            .frame(maxWidth: .infinity, minHeight: 38)
                            .background {
                                // M10: the chosen icon gets a rounded outline (no colour wash).
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .strokeBorder(Palette.primaryText.opacity(item == icon ? 0.55 : 0), lineWidth: 1.5)
                                    .frame(maxWidth: 40)
                            }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressableButtonStyle(scale: 0.9))
                    .accessibilityLabel(Text(item.label))
                    .accessibilityAddTraits(item == icon ? .isSelected : [])
                }
            }
            HStack(spacing: 0) {
                ForEach(ChannelColor.allCases, id: \.self) { swatch in
                    Button { color = swatch } label: {
                        Circle()
                            .fill(swatch.color)
                            .frame(width: 26, height: 26)
                            .padding(3)
                            .overlay {
                                Circle().strokeBorder(Palette.primaryText.opacity(swatch == color ? 0.8 : 0), lineWidth: 2)
                            }
                            .frame(maxWidth: .infinity, minHeight: 40)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressableButtonStyle(scale: 0.88))
                    .accessibilityLabel(Text(swatch.label))
                    .accessibilityAddTraits(swatch == color ? .isSelected : [])
                }
            }
        }
        .padding(14)
        .cardSurface()
        .animation(.easeInOut(duration: 0.2), value: color)
        .animation(.spring(response: 0.28, dampingFraction: 0.75), value: icon)
        .sensoryFeedback(.selection, trigger: icon)
        .sensoryFeedback(.selection, trigger: color)
    }
}
