// The connector detail sheet (prompt L126, L167, L168): stacked on the OpenDuet sheet (or opened
// from profile > Connected apps, an alert card or a link). Logo, display name and description;
// the accounts card with each account's real address and "+ Add account"; "All tools" (Custom
// when the tools differ) and every tool with Ask / Always, grouped Read (Always) then Write (Ask)
// with the common ones first; Disconnect at the bottom with an in-app confirmation.
import SwiftUI

struct ConnectorDetailSheet: View {
    var detail: ConnectorDetailState
    var requests: ShellState.CardRequests
    var actions: ConnectorActions

    /// The last mode tapped per policy key, shown while its request runs (optimistic).
    @State private var pending: [String: PolicyMode] = [:]
    @ScaledMetric(relativeTo: .title) private var nameSize: CGFloat = 26
    @ScaledMetric(relativeTo: .subheadline) private var descriptionSize: CGFloat = 15

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: nil, leading: .close, onLeading: actions.closeDetail)
            ScrollView {
                content
                    .padding(.horizontal, 16)
                    .padding(.bottom, 40)
                    .animation(.easeInOut(duration: 0.25), value: detail.phase)
                    .animation(.easeInOut(duration: 0.25), value: detail.connector?.accounts.map(\.id))
            }
            .scrollIndicators(.hidden)
        }
    }

    @ViewBuilder private var content: some View {
        if detail.toolkit == ComputerToolkit.slug {
            computer
        } else {
            connectorContent
        }
    }

    @ViewBuilder private var connectorContent: some View {
        switch detail.phase {
        case .failed(let reason) where detail.connector == nil:
            InlineRetryLine(reason: reason) { actions.openDetail(detail.toolkit) }
        default:
            if let connector = detail.connector {
                loaded(connector)
            } else {
                skeleton
            }
        }
    }

    private func loaded(_ connector: Connector) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(spacing: 10) {
                ConnectorLogo(toolkit: connector.toolkit, name: connector.name, logoUrl: connector.logoUrl, size: 64)
                Text(verbatim: connector.name)
                    .font(Typography.serifTitle(nameSize))
                    .foregroundStyle(Palette.primaryText)
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                if !connector.description.isEmpty {
                    Text(verbatim: connector.description)
                        .font(.system(size: descriptionSize))
                        .foregroundStyle(Palette.secondaryText)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity)
            accounts(connector)
            if !detail.tools.isEmpty {
                tools
            }
            if connector.isConnected {
                disconnect(connector)
            }
        }
    }

    // MARK: - Accounts

    private func accounts(_ connector: Connector) -> some View {
        let request = requests[ShellState.RequestKey.connect(connector.toolkit)]
        return VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Accounts"))
            CardSection(dividerInset: 16 + 32 + 12) {
                ForEach(connector.accounts) { account in
                    SheetRow(title: Text(verbatim: account.label), subtitle: accountStatus(account)) {
                        RowSymbol(systemImage: "person.crop.circle", tint: Palette.secondaryText)
                    } trailing: {
                        EmptyView()
                    }
                }
                SheetRow(
                    title: connector.isConnected ? Text("Add account") : Text("Connect"),
                    action: request == .inFlight ? nil : { actions.connect(connector.toolkit) }
                ) {
                    RowSymbol(systemImage: "plus")
                } trailing: {
                    if request == .inFlight { ProgressView().controlSize(.small) }
                }
            }
            if let reason = request?.failureReason {
                InlineFailure(reason: reason) { actions.connect(connector.toolkit) }
                    .padding(.top, 8)
                    .padding(.horizontal, 6)
            }
        }
        .sensoryFeedback(.warning, trigger: request) { _, new in new?.failureReason != nil }
    }

    private func accountStatus(_ account: ConnectedAccount) -> Text? {
        switch account.status {
        case .active: nil
        case .expired: Text("Needs reconnecting")
        case .failed: Text("Connection failed")
        }
    }

    // MARK: - Tools

    private var tools: some View {
        VStack(alignment: .leading, spacing: 0) {
            CardSection {
                SheetRow(title: Text("All tools"), subtitle: shownAll == nil ? Text("Custom") : nil) {
                    EmptyView()
                } trailing: {
                    PolicyPicker(mode: shownAll) { set(nil, $0) }
                        .accessibilityLabel(Text("All tools"))
                }
            }
            if let reason = requests[key(nil)]?.failureReason {
                InlineFailure(reason: reason) { retry(nil) }
                    .padding(.top, 8)
                    .padding(.horizontal, 6)
            }
            ForEach([ConnectorTool.Access.read, .write], id: \.self) { access in
                let group = detail.tools.filter { $0.access == access }
                if !group.isEmpty {
                    ToolGroupHeader(access: access)
                        .padding(.top, 20)
                    LazyVStack(spacing: 0) {
                        ForEach(Array(group.enumerated()), id: \.element.id) { index, tool in
                            if index > 0 {
                                Divider().overlay(Palette.cardBorder).padding(.leading, 16)
                            }
                            ConnectorToolRow(
                                tool: tool, mode: shown(tool), request: requests[key(tool.slug)],
                                onSelect: { set(tool.slug, $0) },
                                onRetry: { retry(tool.slug) }
                            )
                        }
                    }
                    .cardSurface()
                }
            }
        }
        .sensoryFeedback(.warning, trigger: requests[key(nil)]) { _, new in new?.failureReason != nil }
    }

    private func key(_ tool: String?) -> String {
        ShellState.RequestKey.policy(detail.toolkit, tool: tool)
    }

    /// A tool's pending choice while its own (or the "All tools") request runs, else its mode.
    private func shown(_ tool: ConnectorTool) -> PolicyMode {
        if requests[key(tool.slug)] == .inFlight, let mode = pending[key(tool.slug)] { return mode }
        if requests[key(nil)] == .inFlight, let mode = pending[key(nil)] { return mode }
        return tool.mode
    }

    /// "All tools": the mode every shown tool shares, nil = Custom (ConnectorDetailState.allMode).
    private var shownAll: PolicyMode? {
        if requests[key(nil)] == .inFlight, let mode = pending[key(nil)] { return mode }
        let modes = detail.tools.map(shown)
        guard let first = modes.first else { return nil }
        return modes.allSatisfy { $0 == first } ? first : nil
    }

    private func set(_ tool: String?, _ mode: PolicyMode) {
        pending[key(tool)] = mode
        actions.setPolicy(detail.toolkit, tool, mode)
    }

    private func retry(_ tool: String?) {
        guard let mode = pending[key(tool)] else { return }
        set(tool, mode)
    }

    // MARK: - Disconnect

    private func disconnect(_ connector: Connector) -> some View {
        VStack(spacing: 10) {
            ForEach(connector.accounts) { account in
                let request = requests[ShellState.RequestKey.disconnect(account.id)]
                InlineConfirm(
                    title: connector.accounts.count > 1 ? Text("Disconnect \(account.label)") : Text("Disconnect"),
                    question: Text("Disconnect \(account.label)? OpenDuet can't use it until you connect it again."),
                    confirmTitle: Text("Disconnect"),
                    busy: request == .inFlight,
                    failure: request?.failureReason,
                    onConfirm: { actions.disconnect(connector.toolkit, account.id) }
                )
                .cardSurface()
            }
        }
        .padding(.top, 8)
    }

    // MARK: - the assistant's computer

    /// The assistant's own browser (PART C §1): what it is, the live screen, then its tools if the
    /// server lists any. Nothing to connect or disconnect; the header and screen stay up even
    /// when the tools fail to load. M20 (L138): on a server without it, the deploy hint comes
    /// first and the preview card and the tool rows are greyed out and can't be tapped.
    private var computer: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(spacing: 10) {
                IconTile(app: nil, systemImage: DuetGlyph.computer.symbol, size: 64)
                    .accessibilityHidden(true)
                Text("OpenDuet's computer")
                    .font(Typography.serifTitle(nameSize))
                    .foregroundStyle(Palette.primaryText)
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text("OpenDuet's own browser in the cloud. It isn't signed in to your accounts. When a site needs you, it asks, or you can take over.")
                    .font(.system(size: descriptionSize))
                    .foregroundStyle(Palette.secondaryText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity)
            // Only on a server without the assistant's computer (it reads the computer's state itself).
            ComputerDeployHint()
            ComputerAccessCard()
            if !detail.tools.isEmpty {
                tools
                    .dimmedWithoutComputer()
            } else if case .failed(let reason) = detail.phase {
                InlineFailure(reason: reason) { actions.openDetail(detail.toolkit) }
                    .padding(.horizontal, 6)
            }
        }
    }

    // MARK: - Loading

    private var skeleton: some View {
        VStack(spacing: 14) {
            RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Palette.skeleton).frame(width: 64, height: 64)
            RoundedRectangle(cornerRadius: 5).fill(Palette.skeleton).frame(width: 140, height: 22)
            RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(width: 240, height: 12)
            AccessRowsSkeleton(rows: 2).padding(.top, 14)
            AccessRowsSkeleton(rows: 4)
        }
        .frame(maxWidth: .infinity)
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading"))
    }
}
