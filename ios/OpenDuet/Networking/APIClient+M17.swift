// M17 routes (docs/API.md "M17"): connector templates from the MCP Registry, one-tap installs,
// remote MCP sign-in (start / finish / sign out) and pasted configs. A non-2xx answer throws
// ServerFailure, which keeps the server's message and field (the pages show its own words for a
// 404 / 409 / 502 too); a 401 still signs the app out like every other call.
import Foundation

extension APIClient {
    /// GET /api/connector-templates: featured first (no query, no cursor), then the registry's page.
    nonisolated func connectorTemplates(query: String, cursor: String?) async throws -> ConnectorTemplateList {
        var items: [URLQueryItem] = []
        let query = TemplateGallery.cleanQuery(query)
        if !query.isEmpty { items.append(URLQueryItem(name: "query", value: query)) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        let request = try makeRequest("GET", "/api/connector-templates", query: items, timeout: 45)
        return try decode(ConnectorTemplateList.self, from: try await sendKeepingReason(request))
    }

    /// POST /api/connector-templates/install: the server probes (and verifies) the remote first.
    nonisolated func installTemplate(_ body: InstallTemplateRequest) async throws -> InstallTemplateResponse {
        var request = try makeRequest("POST", "/api/connector-templates/install", json: body)
        request.timeoutInterval = 90
        return try decode(InstallTemplateResponse.self, from: try await sendKeepingReason(request))
    }

    /// POST /api/custom-connectors (mcp) with `allowSignIn: true`: a server that asks for sign-in is
    /// saved waiting for it instead of the 400 "refused the credentials".
    nonisolated func createCustomConnectorAllowingSignIn(_ body: CreateCustomConnectorRequest) async throws -> CustomConnector {
        var request = try makeRequest("POST", "/api/custom-connectors", json: AllowSignIn(base: body))
        request.timeoutInterval = 60
        return try decode(CustomConnectorResponse.self, from: try await sendKeepingReason(request)).connector
    }

    /// POST /api/custom-connectors/:id/oauth/start (no body): discovery, registration, PKCE.
    nonisolated func startConnectorSignIn(id: String) async throws -> OAuthStartResponse {
        let request = try makeRequest("POST", "/api/custom-connectors/\(id.pathSegment)/oauth/start", timeout: 60)
        return try decode(OAuthStartResponse.self, from: try await sendKeepingReason(request))
    }

    /// POST /api/custom-connectors/:id/oauth/finish: the code is traded, then the connector is checked.
    nonisolated func finishConnectorSignIn(id: String, _ body: OAuthFinishRequest) async throws -> CustomConnector {
        var request = try makeRequest("POST", "/api/custom-connectors/\(id.pathSegment)/oauth/finish", json: body)
        request.timeoutInterval = 90
        return try decode(CustomConnectorResponse.self, from: try await sendKeepingReason(request)).connector
    }

    /// DELETE /api/custom-connectors/:id/oauth: the stored sign-in goes; it waits for sign-in again.
    nonisolated func signOutConnector(id: String) async throws -> CustomConnector {
        let request = try makeRequest("DELETE", "/api/custom-connectors/\(id.pathSegment)/oauth")
        return try decode(CustomConnectorResponse.self, from: try await sendKeepingReason(request)).connector
    }

    /// POST /api/custom-connectors/import: each remote entry is checked in turn (up to 20).
    nonisolated func importConnectors(_ body: ImportConnectorsRequest) async throws -> ImportConnectorsResponse {
        var request = try makeRequest("POST", "/api/custom-connectors/import", json: body)
        request.timeoutInterval = 360
        return try decode(ImportConnectorsResponse.self, from: try await sendKeepingReason(request))
    }

    // MARK: - Helpers

    /// `send` with the server's ApiError message kept: a non-2xx answer is a ServerFailure.
    nonisolated func sendKeepingReason(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await HTTPSessions.api.data(for: request)
        } catch {
            throw APIError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401, token != nil { onUnauthorized() }
            throw ServerFailure(status: http.statusCode, body: data)
        }
        return data
    }
}

/// An mcp CreateCustomConnectorRequest plus `allowSignIn: true` (the M11 enum stays as it is).
private struct AllowSignIn: Encodable {
    var base: CreateCustomConnectorRequest

    private enum CodingKeys: String, CodingKey { case allowSignIn }

    func encode(to encoder: Encoder) throws {
        try base.encode(to: encoder)
        if case .mcp = base {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(true, forKey: .allowSignIn)
        }
    }
}
