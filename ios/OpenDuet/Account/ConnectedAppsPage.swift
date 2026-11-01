// Settings › Apps and connectors (M16; was Profile › Connected apps, prompt L127): everything
// the assistant can reach that you set up, in one list. Connected (the apps with their accounts' real
// addresses; a tap opens the connector detail sheet), Custom connectors (each one's status, Add
// connector) and More apps (the whole catalog with search: mail, calendar, team chat, payments
// and the rest are found there instead of each having a fixed row). Refreshes when it opens.
// M25: "Built in" between the app rows and Custom connectors (BuiltinConnectorsSection: the
// key-less tools every user of the server has, read-only).
import SwiftUI

struct AppsAndConnectorsPage: View {
    var assistant: AssistantAccessState
    var model: EverythingModel
    var actions: ConnectorActions
    var onOpenConnector: (String) -> Void
    var onAddConnector: () -> Void
    var onMoreApps: () -> Void
    var onBack: () -> Void

    @Environment(\.locale) private var locale
    @Environment(\.apiClient) private var api

    var body: some View {
        let apps = ConnectedApps.list(assistant)
        VStack(spacing: 0) {
            SheetHeader(title: Text("Apps and connectors"), leading: .back, onLeading: onBack)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    connected(apps)
                    BuiltinConnectorsSection(model: model)
                    CustomConnectorsSection(model: model, onOpen: onOpenConnector, onAdd: onAddConnector)
                    VStack(alignment: .leading, spacing: 0) {
                        CardSection(dividerInset: 16 + 32 + 12) {
                            SheetRow(title: Text("More apps"), subtitle: Text("Mail, calendar, team chat, payments and more"), action: onMoreApps) {
                                RowSymbol(systemImage: "square.grid.2x2")
                            } trailing: { RowChevron() }
                        }
                        if !assistant.configured {
                            NotSetUpLine().padding(.top, 10)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 40)
                .animation(.easeInOut(duration: 0.25), value: apps.map(\.toolkit))
            }
            .scrollIndicators(.hidden)
            .refreshable {
                actions.refresh()
                await model.loadConnectors()
                await model.loadBuiltins()
            }
        }
        .onAppear(perform: actions.refresh)
        // M25: each visit (reachability changes); the sheet may open right at this page.
        .task {
            model.attach(api)
            await model.loadBuiltins()
        }
    }

    /// The connected apps, under "Connected"; nothing at all while there are none (More apps is
    /// where one gets connected).
    @ViewBuilder private func connected(_ apps: [Connector]) -> some View {
        switch assistant.phase {
        case .loading where apps.isEmpty:
            AccessRowsSkeleton(rows: 2)
        case .failed(let reason) where apps.isEmpty:
            InlineRetryLine(reason: reason, onRetry: actions.refresh)
                .cardSurface()
        default:
            if !apps.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    SheetSectionTitle(text: Text("Connected"))
                    CardSection(dividerInset: 16 + 32 + 12) {
                        ForEach(apps) { app in
                            SheetRow(
                                title: Text(verbatim: app.name),
                                subtitle: Text(verbatim: app.accounts.map(\.label).formatted(.list(type: .and).locale(locale))),
                                action: { actions.openDetail(app.toolkit) }
                            ) {
                                ConnectorLogo(toolkit: app.toolkit, name: app.name, logoUrl: app.logoUrl, size: 32)
                            } trailing: { RowChevron() }
                        }
                    }
                }
            }
        }
    }
}
