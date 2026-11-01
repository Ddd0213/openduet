// M12 pieces the Models pages share: the pages a Models screen pushes (ModelsRoute), a
// provider's tile, a model's badges, and the choice row of the Defaults card and the channel
// sheet (tapping it opens its options in place, each with a check; never a menu or an alert).
import SwiftUI

/// The pages under Everything → Models (one push deep each, Back goes to `parent`).
enum ModelsRoute: Hashable, Sendable {
    case addProvider
    case providerForm(ProviderKind)
    case provider(String)
    case remoteModels(String)
    case model(String)

    /// nil = the Models page itself
    @MainActor func parent(_ models: ModelsModel) -> ModelsRoute? {
        switch self {
        case .addProvider, .provider: nil
        case .providerForm: .addProvider
        case .remoteModels(let providerId): .provider(providerId)
        case .model(let id): models.model(id).map { .provider($0.providerId) }
        }
    }
}

/// A provider's square tile: its name's letter on the app's tile.
struct ProviderTile: View {
    var name: String
    var size: CGFloat = 32

    var body: some View {
        IconTile(app: name, systemImage: "server.rack", size: size, tint: Palette.secondaryText)
    }
}

/// A model's small capsules (context, thinking, tools, images, voice).
struct ModelBadgesRow: View {
    var badges: [ModelBadge]

    @ScaledMetric(relativeTo: .caption) private var fontSize: CGFloat = 11.5

    var body: some View {
        LeadingFlowLayout(spacing: 5, lineSpacing: 5) {
            ForEach(badges, id: \.self) { badge in
                Text(badge.label)
                    .font(.system(size: fontSize, weight: .semibold))
                    .foregroundStyle(Palette.secondaryText)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2.5)
                    .background(Capsule().fill(Palette.tile))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// "Default" (or "Edited") as a quiet capsule at the end of a row.
struct ModelsTag: View {
    var text: Text
    var accent = false

    @ScaledMetric(relativeTo: .caption) private var fontSize: CGFloat = 12

    var body: some View {
        text
            .font(.system(size: fontSize, weight: .semibold))
            .foregroundStyle(accent ? Palette.accent : Palette.secondaryText)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(Palette.tile))
            .lineLimit(1)
    }
}

/// One option of a choice row.
struct ChoiceOption<Value: Hashable>: Identifiable {
    var value: Value
    var title: Text
    var subtitle: Text?
    var id: Value { value }
}

/// A row with its title and the current choice; tapping opens the options under it in place.
/// Picking one closes it. A request in flight shows a spinner, a refusal its reason under it.
struct InlineChoiceRow<Value: Hashable>: View {
    var title: Text
    var current: Text
    var options: [ChoiceOption<Value>]
    var selection: Value
    var busy = false
    var failure: String?
    var leading: String?
    var onSelect: (Value) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var open = false
    @ScaledMetric(relativeTo: .body) private var valueSize: CGFloat = 15
    @ScaledMetric(relativeTo: .body) private var optionSize: CGFloat = 15.5
    @ScaledMetric(relativeTo: .footnote) private var noteSize: CGFloat = 13

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if open {
                VStack(spacing: 0) {
                    ForEach(options) { option in
                        optionRow(option)
                    }
                }
                .padding(.bottom, 6)
                .transition(.opacity)
            }
            if let failure {
                SettingsReasonLine(reason: failure)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 10)
                    .transition(.opacity)
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.32, dampingFraction: 0.86), value: open)
        .animation(.easeInOut(duration: 0.2), value: failure)
        .sensoryFeedback(.warning, trigger: failure) { _, new in new != nil }
    }

    private var header: some View {
        SheetRow(
            title: title,
            subtitle: nil,
            action: options.isEmpty ? nil : { open.toggle() },
            leading: {
                if let leading { RowSymbol(systemImage: leading, tint: Palette.secondaryText) }
            },
            trailing: {
                HStack(spacing: 8) {
                    current
                        .font(.system(size: valueSize))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(2)
                        .multilineTextAlignment(.trailing)
                    if busy {
                        BusySpinner(busy: true)
                    } else if !options.isEmpty {
                        RowChevron()
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                }
            }
        )
        .accessibilityElement(children: .combine)
        .accessibilityValue(current)
        .accessibilityHint(open ? Text("Hides the choices") : Text("Shows the choices"))
    }

    private func optionRow(_ option: ChoiceOption<Value>) -> some View {
        let picked = option.value == selection
        return Button {
            open = false
            if !picked { onSelect(option.value) }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    option.title
                        .font(.system(size: optionSize, weight: picked ? .semibold : .regular))
                        .foregroundStyle(Palette.primaryText)
                    if let subtitle = option.subtitle {
                        subtitle
                            .font(.system(size: noteSize))
                            .foregroundStyle(Palette.secondaryText)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if picked {
                    DuetIcon(glyph: .check, size: 17, tint: Palette.accent)
                }
            }
            .padding(.leading, leading == nil ? 28 : Metrics.settingsTileInset)
            .padding(.trailing, 16)
            .padding(.vertical, 9)
            .frame(minHeight: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .disabled(busy)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(picked ? [.isButton, .isSelected] : .isButton)
    }
}

extension ModelsRoute {
    /// The thinking options of a picker: the level's names, in ladder order.
    static func thinkingOptions(_ levels: [ThinkingLevel], none: Text) -> [ChoiceOption<ThinkingLevel?>] {
        [ChoiceOption(value: nil, title: none)] + levels.map { ChoiceOption(value: $0, title: Text($0.label)) }
    }
}
