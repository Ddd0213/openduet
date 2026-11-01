// M25 (W2): Settings › Apps and connectors › "Built in": the key-less tools every user of the
// server has (GET /api/builtin-connectors), one read-only row per known id in the server's order:
// its own name and icon, the status line (off / unreachable), the grey line saying what it sends
// where, and Open-Meteo's credit on Weather. No switch: they are turned off only in the server's
// .env. A failed load is an inline retry line; an older server (404) shows no section.
import SwiftUI

struct BuiltinConnectorsSection: View {
    var model: EverythingModel

    var body: some View {
        switch model.builtins.display {
        case .loaded(let rows) where rows.isEmpty:
            EmptyView()
        case let display:
            VStack(alignment: .leading, spacing: 0) {
                SheetSectionTitle(text: Text("Built in"))
                switch display {
                case .loading:
                    SettingsRowsSkeleton(rows: 2)
                case .failed(let reason):
                    InlineRetryLine(reason: reason) { Task { await model.loadBuiltins() } }
                        .cardSurface()
                case .loaded(let rows):
                    CardSection(dividerInset: Metrics.settingsTileInset) {
                        ForEach(rows) { BuiltinConnectorRow(connector: $0) }
                    }
                    SettingsNote(text: Text("Nothing to set up. Only the server can turn these off."))
                        .padding(.top, 8)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: model.builtins.value)
        }
    }
}

struct BuiltinConnectorRow: View {
    var connector: BuiltinConnector

    var body: some View {
        SheetRow(title: Text(BuiltinConnectorCopy.title(connector.kind)), subtitle: subtitle) {
            RowSymbol(systemImage: BuiltinConnectorCopy.symbol(connector.kind))
                .opacity(connector.state == .off ? 0.5 : 1)
        } trailing: {
            EmptyView()
        }
        .accessibilityElement(children: .combine)
    }

    /// The status (when off or unreachable), what it sends where, then the credit; one per line.
    private var subtitle: Text? {
        var lines: [Text] = []
        if let status = BuiltinConnectorCopy.status(connector.state) {
            lines.append(Text(status).foregroundStyle(connector.state == .unreachable ? Palette.needsInput : Palette.secondaryText).fontWeight(.medium))
        }
        if let sends = BuiltinConnectorCopy.sends(connector) { lines.append(Text(sends)) }
        if let credit = BuiltinConnectorCopy.credit(connector.kind) { lines.append(Text(credit)) }
        guard let first = lines.first else { return nil }
        return lines.dropFirst().reduce(first) { $0 + Text(verbatim: "\n") + $1 }
    }
}
