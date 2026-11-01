// M11: custom connectors in Everything: the list under the app rows (status, the failure, how
// many tools), a capsule segmented picker in the PolicyPicker style (MCP server / API key,
// All channels / Only some), and the MCP request headers editor (name, value, secret).
import SwiftUI

/// "Custom connectors": each one with its status line, then "Add connector".
struct CustomConnectorsSection: View {
    var model: EverythingModel
    var onOpen: (String) -> Void
    var onAdd: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Custom connectors"))
            switch model.connectors.display {
            case .loading:
                SettingsRowsSkeleton(rows: 1)
            case .failed(let reason):
                InlineRetryLine(reason: reason) { Task { await model.loadConnectors() } }
                    .cardSurface()
            case .loaded(let connectors):
                CardSection(dividerInset: Metrics.settingsTileInset) {
                    ForEach(connectors) { connector in
                        CustomConnectorRow(connector: connector) { onOpen(connector.id) }
                    }
                    SheetRow(
                        title: Text("Add connector"),
                        subtitle: connectors.isEmpty ? Text("An MCP server, or an API key for one domain") : nil,
                        action: onAdd,
                        leading: { RowSymbol(systemImage: "plus", tint: Palette.secondaryText) },
                        trailing: { RowChevron() }
                    )
                }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.connectors.value?.map(\.id))
    }
}

struct CustomConnectorRow: View {
    var connector: CustomConnector
    var onOpen: () -> Void

    var body: some View {
        SheetRow(
            title: Text(verbatim: connector.name),
            subtitle: subtitle,
            action: onOpen,
            leading: { RowSymbol(systemImage: CustomConnectorRow.symbol(connector.kind), tint: Palette.secondaryText) },
            trailing: {
                HStack(spacing: 8) {
                    if connector.status == .failed {
                        DuetIcon(glyph: .warning, size: 17, tint: Palette.failure)
                            .accessibilityLabel(Text("Connection failed"))
                    }
                    RowChevron()
                }
            }
        )
    }

    static func symbol(_ kind: CustomConnector.Kind) -> String {
        kind == .mcp ? "cylinder.split.1x2" : "checkmark.shield"
    }

    private var subtitle: Text {
        if connector.status == .failed {
            let reason = connector.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return reason.isEmpty ? Text("Connection failed") : Text(verbatim: reason)
        }
        return Text(verbatim: ConnectorCopy.line(connector))
    }
}

/// Two or three choices in a capsule, like the Ask / Always picker.
struct SettingsSegmented<Value: Hashable>: View {
    var options: [(value: Value, title: Text)]
    var selection: Value
    var disabled = false
    var onSelect: (Value) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var marker
    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 14

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options.indices, id: \.self) { index in
                segment(options[index].value, title: options[index].title)
            }
        }
        .padding(2)
        .background(Capsule().fill(Palette.tile))
        .opacity(disabled ? 0.5 : 1)
        .disabled(disabled)
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.3, dampingFraction: 0.8), value: selection)
        .sensoryFeedback(.selection, trigger: selection)
        .accessibilityElement(children: .contain)
    }

    private func segment(_ value: Value, title: Text) -> some View {
        Button { if selection != value { onSelect(value) } } label: {
            title
                .font(.system(size: fontSize, weight: .semibold))
                .foregroundStyle(selection == value ? Palette.primaryText : Palette.secondaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .padding(.horizontal, 14)
                .frame(maxWidth: .infinity, minHeight: 34)
                .background {
                    if selection == value {
                        Capsule()
                            .fill(Palette.floatingSurface)
                            .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
                            .matchedGeometryEffect(id: "selected", in: marker)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selection == value ? .isSelected : [])
    }
}
