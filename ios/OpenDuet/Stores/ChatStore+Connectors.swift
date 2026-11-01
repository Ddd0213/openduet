// The OpenDuet sheet and connectors (L126, L127, L167, L168): GET /api/connectors for "What OpenDuet
// has access to" and More apps (search debounced 300 ms), the connector detail with its tool
// policies, Composio's hosted OAuth (POST connect -> ShellState.oauth -> OAuthPresenter ->
// oauthFinished) and Disconnect. After OAuth the server is the source of truth: the lists are
// fetched again whether the callback said success or not.
import Foundation

extension ChatStore {
    /// ConnectorActions.refresh (the OpenDuet sheet or profile > Connected apps appeared).
    func refreshConnectors() {
        guard !tornDown else { return }
        // M6: the "OpenDuet's computer" row reads the computer's state.
        loadComputer()
        connectorsTask?.cancel()
        account.beginConnectorsLoad()
        let query = account.assistant.query.trimmingCharacters(in: .whitespacesAndNewlines)
        connectorsTask = Task { [client] in
            async let all = Self.result { try await client.connectors(query: nil) }
            async let searched: Result<ConnectorList?, any Error> = Self.result {
                if query.isEmpty { return nil }
                return try await client.connectors(query: query)
            }
            let (allResult, searchedResult) = await (all, searched)
            guard !Task.isCancelled, !tornDown else { return }
            switch allResult {
            case .success(let list):
                account.applyConnectors(list, query: nil)
                markOnline()
            case .failure(let error):
                noteFailure(error)
                account.failConnectors(reason: TaskBoard.reason(for: error))
            }
            if case .success(let list?) = searchedResult { account.applyConnectors(list, query: query) }
        }
    }

    /// ConnectorActions.search: More apps' search field, debounced 300 ms (?query=).
    func searchConnectors(_ query: String) {
        guard !tornDown else { return }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        account.setQuery(trimmed)
        searchTask?.cancel()
        searchTask = Task { [client] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            let result = await Self.result { try await client.connectors(query: trimmed.isEmpty ? nil : trimmed) }
            guard !Task.isCancelled, !tornDown else { return }
            switch result {
            case .success(let list):
                // An empty query restores the full catalog (and refreshes the rows with it).
                account.applyConnectors(list, query: trimmed.isEmpty ? nil : trimmed)
                markOnline()
            case .failure(let error):
                noteFailure(error)
            }
        }
    }

    /// ConnectorActions.openDetail (a row, More apps, an alert's open_connector).
    func openConnectorDetail(_ toolkit: String) {
        guard !tornDown, !toolkit.isEmpty else { return }
        account.openDetail(toolkit)
        loadConnectorDetail(toolkit)
    }

    func closeConnectorDetail() {
        connectorDetailTask?.cancel()
        connectorDetailTask = nil
        account.closeDetail()
    }

    /// GET /api/connectors/:toolkit; once loaded, a failed reload keeps what is shown.
    func loadConnectorDetail(_ toolkit: String) {
        connectorDetailTask?.cancel()
        connectorDetailTask = Task { [client] in
            let result = await Self.result { try await client.connector(toolkit: toolkit) }
            guard !Task.isCancelled, !tornDown else { return }
            switch result {
            case .success(let detail):
                account.applyDetail(detail)
                markOnline()
            case .failure(let error):
                noteFailure(error)
                if toolkit == ComputerToolkit.slug, [.notFound, .notConfigured].contains(error as? APIError) {
                    // M6: no computer for this account (another account than its owner, or an
                    // older server): the sheet shows no tools.
                    account.emptyDetail(toolkit)
                } else {
                    account.failDetail(toolkit, reason: TaskBoard.reason(for: error))
                }
            }
        }
    }

    /// The dashed "+" and "+ Add account" (cardRequests[RequestKey.connect(toolkit)], in flight
    /// until the OAuth page finishes).
    func connect(toolkit: String) {
        guard !tornDown, account.beginConnect(toolkit) else { return }
        runTap(ShellState.RequestKey.connect(toolkit), { [client] in try await client.connect(toolkit: toolkit) }) { store, result in
            store.account.connectAnswered(toolkit, result)
        }
    }

    /// ConnectorActions.oauthFinished: clears the page and its request, then refreshes the
    /// connections, the open detail and the user (a mail account brings the email address).
    func oauthFinished(_ id: UUID, callback: URL?) {
        guard let toolkit = account.finishOAuth(id) else { return }
        Self.log.info("OAuth for \(toolkit, privacy: .public) \(callback == nil ? "cancelled" : "returned", privacy: .public)")
        refreshConnectors()
        if let open = account.connectorDetail?.toolkit { loadConnectorDetail(open) }
        refreshProfile()
    }

    /// Ask / Always for one tool or "All tools" (cardRequests[RequestKey.policy(toolkit, tool:)]):
    /// shown at once; the answer replaces the detail, a failure puts the modes back.
    func setPolicy(toolkit: String, tool: String?, mode: PolicyMode) {
        guard !tornDown, account.beginPolicy(toolkit, tool: tool, mode: mode) else { return }
        let body = UpdatePolicyRequest(tool: tool, mode: mode)
        runTap(ShellState.RequestKey.policy(toolkit, tool: tool), { [client] in try await client.setPolicy(toolkit: toolkit, body) }) { store, result in
            store.account.answerPolicy(toolkit, tool: tool, result)
        }
    }

    /// Disconnect one account (cardRequests[RequestKey.disconnect(accountId)]), then refresh.
    func disconnect(toolkit: String, accountId: String) {
        let key = ShellState.RequestKey.disconnect(accountId)
        guard !tornDown, account.begin(key) else { return }
        runTap(key, { [client] in try await client.disconnect(toolkit: toolkit, accountId: accountId) }) { store, result in
            guard store.account.answer(key, result) != nil else { return }
            store.refreshConnectors()
            if let open = store.account.connectorDetail?.toolkit { store.loadConnectorDetail(open) }
            store.refreshProfile()
        }
    }
}
