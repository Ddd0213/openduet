// M11: Everything's custom connectors (MCP servers and domain-bound API keys). Every write answers
// the connector as the server now has it; a failed check is a 400 whose message the form shows.
import Foundation

extension EverythingModel {
    private func setConnector(_ connector: CustomConnector) {
        var list = connectors.value ?? []
        if let index = list.firstIndex(where: { $0.id == connector.id }) {
            list[index] = connector
        } else {
            list.append(connector)
        }
        connectors.finish(list.sorted { $0.name < $1.name })
    }

    func connector(_ id: String) -> CustomConnector? {
        connectors.value?.first { $0.id == id }
    }

    /// "Add connector": checked by the server before it's saved.
    func createConnector(_ body: CreateCustomConnectorRequest) async throws -> CustomConnector {
        let connector = try await client().createCustomConnector(body)
        setConnector(connector)
        return connector
    }

    func updateConnector(_ id: String, _ body: UpdateCustomConnectorRequest) async throws {
        setConnector(try await client().updateCustomConnector(id: id, body))
    }

    /// "Check again": status, error and tools refreshed.
    func testConnector(_ id: String) async throws {
        setConnector(try await client().testCustomConnector(id: id))
    }

    /// Ask / Always for one tool, or every tool when `tool` is nil.
    func setConnectorPolicy(_ id: String, tool: String?, mode: PolicyMode) async throws {
        setConnector(try await client().setCustomConnectorPolicy(id: id, UpdatePolicyRequest(tool: tool, mode: mode)))
    }

    /// "All channels" / "Only some channels"; the list reloads for the channels it's on in.
    func setConnectorScope(_ id: String, scope: AccessScope) async throws {
        try await client().updateAccessScope(UpdateAccessScopeRequest(ref: AccessRef(kind: .connector, id: id), scope: scope))
        if var connector = connector(id) {
            connector.scope = scope
            setConnector(connector)
        }
        await loadConnectors()
    }

    func deleteConnector(_ id: String) async throws {
        try await client().deleteCustomConnector(id: id)
        connectors.finish((connectors.value ?? []).filter { $0.id != id })
    }

    // MARK: - M17: templates, sign-in, pasted configs

    /// Several connectors at once (an import): each replaces its id or joins the list.
    private func setConnectors(_ incoming: [CustomConnector]) {
        guard !incoming.isEmpty else { return }
        let ids = Set(incoming.map(\.id))
        let kept = (connectors.value ?? []).filter { !ids.contains($0.id) }
        connectors.finish((kept + incoming).sorted { $0.name < $1.name })
    }

    /// "Add manually" (M17): a server that asks for sign-in is saved waiting for it.
    func createConnectorAllowingSignIn(_ body: CreateCustomConnectorRequest) async throws -> CustomConnector {
        let connector: CustomConnector
        if case .mcp = body {
            connector = try await client().createCustomConnectorAllowingSignIn(body)
        } else {
            connector = try await client().createCustomConnector(body)
        }
        setConnector(connector)
        return connector
    }

    /// GET /api/connector-templates (the gallery keeps its own pages).
    func connectorTemplates(query: String, cursor: String?) async throws -> ConnectorTemplateList {
        try await client().connectorTemplates(query: query, cursor: cursor)
    }

    /// One tap (or the sheet's values): the connector joins the list; `needsSignIn` = sign in next.
    func installTemplate(_ body: InstallTemplateRequest) async throws -> InstallTemplateResponse {
        let response = try await client().installTemplate(body)
        setConnector(response.connector)
        return response
    }

    func startConnectorSignIn(_ id: String) async throws -> OAuthStartResponse {
        try await client().startConnectorSignIn(id: id)
    }

    /// The callback's query: the server trades the code and checks the connector again.
    func finishConnectorSignIn(_ id: String, _ body: OAuthFinishRequest) async throws -> CustomConnector {
        let connector = try await client().finishConnectorSignIn(id: id, body)
        setConnector(connector)
        return connector
    }

    /// Sign out: the stored sign-in goes; the connector keeps its tools and waits for sign-in.
    func signOutConnector(_ id: String) async throws {
        setConnector(try await client().signOutConnector(id: id))
    }

    /// "Paste a config": the added connectors join the list.
    func importConnectors(_ body: ImportConnectorsRequest) async throws -> ImportConnectorsResponse {
        let response = try await client().importConnectors(body)
        setConnectors(response.connectors)
        return response
    }
}
