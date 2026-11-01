// "More apps ›" (prompt L125): pushed from Settings › Apps and connectors (M16), the server's whole catalog
// (connected first) with a search field; the store debounces `connectors.search`. Connected apps
// open their detail, the rest show the dashed "+" (spinner while connecting).
import SwiftUI

struct MoreAppsView: View {
    var assistant: AssistantAccessState
    var requests: ShellState.CardRequests
    var actions: ConnectorActions
    var onBack: () -> Void

    @State private var query = ""
    @FocusState private var searchFocused: Bool
    @ScaledMetric(relativeTo: .body) private var fieldSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var noMatchSize: CGFloat = 15

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("More apps"), leading: .back, onLeading: onBack)
            searchField
                .padding(.horizontal, 16)
                .padding(.bottom, 10)
            ScrollView {
                content
                    .padding(.horizontal, 16)
                    .padding(.bottom, 32)
                    .animation(.easeInOut(duration: 0.2), value: assistant.catalog.map(\.toolkit))
            }
            .scrollDismissesKeyboard(.immediately)
            .scrollIndicators(.hidden)
        }
        .onAppear { query = assistant.query }
        .onChange(of: query) { _, new in actions.search(new) }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            DuetIcon(glyph: .search, size: fieldSize + 2, tint: Palette.secondaryText)
            TextField(text: $query) { Text("Search apps") }
                .font(.system(size: fieldSize))
                .focused($searchFocused)
                .submitLabel(.search)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.secondaryText)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Clear search"))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Capsule().fill(Palette.cardSurface).strokeBorder(Palette.cardBorder, lineWidth: Metrics.hairline))
    }

    @ViewBuilder private var content: some View {
        switch assistant.phase {
        case .loading where assistant.catalog.isEmpty:
            AccessRowsSkeleton(rows: 6)
        case .failed(let reason) where assistant.catalog.isEmpty:
            InlineRetryLine(reason: reason, onRetry: actions.refresh)
        default:
            if !assistant.configured {
                NotSetUpLine().padding(.top, 8)
            } else if assistant.catalog.isEmpty {
                Text("No apps match \u{201C}\(query.trimmingCharacters(in: .whitespacesAndNewlines))\u{201D}")
                    .font(.system(size: noMatchSize))
                    .foregroundStyle(Palette.secondaryText)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(Array(assistant.catalog.enumerated()), id: \.element.id) { index, connector in
                        if index > 0 {
                            Divider().overlay(Palette.cardBorder).padding(.leading, 16 + 32 + 12)
                        }
                        CatalogRow(connector: connector, request: requests[ShellState.RequestKey.connect(connector.toolkit)],
                                   onConnect: { actions.connect(connector.toolkit) },
                                   onOpen: { actions.openDetail(connector.toolkit) })
                    }
                }
                .cardSurface()
            }
        }
    }
}

/// A catalog app: logo, display name, its accounts (connected) or its description, and › or "+".
private struct CatalogRow: View {
    var connector: Connector
    var request: CardRequest?
    var onConnect: () -> Void
    var onOpen: () -> Void

    @Environment(\.locale) private var locale

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetRow(title: Text(verbatim: connector.name), subtitle: subtitle, action: onOpen) {
                ConnectorLogo(toolkit: connector.toolkit, name: connector.name, logoUrl: connector.logoUrl, size: 32)
            } trailing: {
                if connector.isConnected {
                    RowChevron()
                } else {
                    DashedPlusButton(busy: request == .inFlight, label: Text("Connect \(connector.name)"), action: onConnect)
                }
            }
            if case .failed(let reason) = request {
                InlineFailure(reason: reason, onRetry: onConnect)
                    .padding(.leading, 16 + 32 + 12)
                    .padding(.trailing, 16)
                    .padding(.bottom, 10)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: request)
        .sensoryFeedback(.warning, trigger: request) { _, new in new?.failureReason != nil }
    }

    private var subtitle: Text? {
        if connector.isConnected {
            return Text(verbatim: connector.accounts.map(\.label).formatted(.list(type: .and).locale(locale)))
        }
        return connector.description.isEmpty ? nil : Text(verbatim: connector.description)
    }
}
