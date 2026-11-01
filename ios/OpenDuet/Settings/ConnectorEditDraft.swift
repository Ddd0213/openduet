// M11 custom connector detail, without SwiftUI for the host tests: the "Edit connection" form
// (a new URL, headers, domain or key; a stored secret left blank keeps its vault value) and its
// PATCH body, the tools as the app's ConnectorTool rows, and the rows' quiet copy.
import Foundation

/// The connector detail's "Edit connection" form.
struct ConnectorEditDraft: Hashable, Sendable {
    let kind: CustomConnector.Kind
    var name: String
    // MCP server
    var url: String
    var headers: [HeaderDraft]
    // API key
    var domain: String
    var headerName: String
    var valuePrefix: String
    /// A new key; blank keeps the one in the vault.
    var key = ""

    private let original: CustomConnector

    init(_ connector: CustomConnector) {
        original = connector
        kind = connector.kind
        name = connector.name
        url = connector.url ?? ""
        headers = connector.headers.map {
            HeaderDraft(name: $0.name, value: $0.secret ? "" : ($0.value ?? ""), secret: $0.secret, stored: true)
        }
        domain = connector.domain ?? ""
        headerName = connector.headerName ?? "Authorization"
        valuePrefix = connector.valuePrefix ?? ""
    }

    private static func clean(_ text: String) -> String { ConnectorFormRules.clean(text) }

    var problems: Set<ConnectorDraft.Problem> {
        var problems = Set<ConnectorDraft.Problem>()
        if Self.clean(name).count > ConnectorFormRules.nameLimit { problems.insert(.name) }
        switch kind {
        case .mcp:
            if !ConnectorFormRules.isHTTPSURL(url) { problems.insert(.url) }
            let named = headers.map { Self.clean($0.name) }.filter { !$0.isEmpty }
            if named.contains(where: { !ConnectorFormRules.isHeaderName($0) }) { problems.insert(.headerName) }
            if Set(named.map { $0.lowercased() }).count != named.count { problems.insert(.duplicateHeader) }
        case .apiKey:
            if !ConnectorFormRules.isDomain(domain) { problems.insert(.domain) }
            if !ConnectorFormRules.isHeaderName(headerName) { problems.insert(.headerName) }
            if valuePrefix.count > ConnectorFormRules.prefixLimit { problems.insert(.prefix) }
        }
        return problems
    }

    /// A header's value may stay blank only when it's a stored secret (its vault value stays).
    private func keepsStored(_ header: HeaderDraft) -> Bool {
        header.stored && header.secret && Self.clean(header.value).isEmpty
            && original.headers.contains { $0.secret && $0.name.caseInsensitiveCompare(Self.clean(header.name)) == .orderedSame }
    }

    var isComplete: Bool {
        guard !Self.clean(name).isEmpty else { return false }
        switch kind {
        case .mcp:
            return headers.count <= ConnectorFormRules.maxHeaders && headers.allSatisfy {
                !Self.clean($0.name).isEmpty && (!Self.clean($0.value).isEmpty || keepsStored($0))
            }
        case .apiKey:
            return true
        }
    }

    private var headersChanged: Bool {
        guard headers.count == original.headers.count else { return true }
        return zip(headers, original.headers).contains { draft, old in
            Self.clean(draft.name) != old.name || draft.secret != old.secret
                || (draft.secret ? !Self.clean(draft.value).isEmpty : Self.clean(draft.value) != (old.value ?? ""))
        }
    }

    /// PATCH /api/custom-connectors/:id with what changed; nil when nothing did. Anything but the
    /// name makes the server check the connection again.
    var request: UpdateCustomConnectorRequest? {
        guard isComplete, problems.isEmpty else { return nil }
        var body = UpdateCustomConnectorRequest()
        if Self.clean(name) != original.name { body.name = Self.clean(name) }
        switch kind {
        case .mcp:
            if Self.clean(url) != (original.url ?? "") { body.url = Self.clean(url) }
            if headersChanged {
                body.headers = headers.map {
                    UpdateCustomConnectorRequest.Header(name: Self.clean($0.name), value: keepsStored($0) ? nil : Self.clean($0.value), secret: $0.secret)
                }
            }
        case .apiKey:
            let domain = ConnectorFormRules.normalizedDomain(domain)
            if domain != (original.domain ?? "") { body.domain = domain }
            if Self.clean(headerName) != (original.headerName ?? "Authorization") { body.headerName = Self.clean(headerName) }
            if valuePrefix != (original.valuePrefix ?? "") { body.valuePrefix = valuePrefix }
            if !Self.clean(key).isEmpty { body.key = Self.clean(key) }
        }
        return body == UpdateCustomConnectorRequest() ? nil : body
    }

    /// After Save was tapped: typed secrets are gone; stored ones stay stored.
    mutating func dropSecrets() {
        key = ""
        for index in headers.indices where headers[index].secret {
            headers[index].value = ""
        }
    }
}

enum ConnectorCopy {
    static func kindLabel(_ kind: CustomConnector.Kind) -> LocalizedStringResource {
        switch kind {
        case .mcp: "MCP server"
        case .apiKey: "API key"
        }
    }

    /// The URL without https:// (MCP) or the bound domain (API key), for a quiet line.
    static func address(_ connector: CustomConnector) -> String? {
        switch connector.kind {
        case .mcp:
            guard var text = connector.url, !text.isEmpty else { return nil }
            for scheme in ["https://", "http://"] where text.lowercased().hasPrefix(scheme) {
                text.removeFirst(scheme.count)
            }
            if text.hasSuffix("/") { text.removeLast() }
            return text
        case .apiKey:
            return connector.domain.flatMap { $0.isEmpty ? nil : $0 }
        }
    }

    static func toolCount(_ count: Int) -> LocalizedStringResource {
        switch count {
        case 0: "No tools"
        case 1: "1 tool"
        default: "\(count) tools"
        }
    }

    /// The row's grey line: "MCP server · 12 tools · All channels" (the failure shows instead when it failed).
    static func line(_ connector: CustomConnector) -> String {
        var parts = [kindLabel(connector.kind)]
        if connector.kind == .mcp { parts.append(toolCount(connector.tools.count)) }
        parts.append(ScopeLabel.text(scope: connector.scope, channelCount: connector.channelIds.count))
        return parts.map { String(localized: $0) }.joined(separator: " · ")
    }

    /// The tools as the shared ConnectorTool rows (Read first, then Write; the server's order inside).
    static func tools(_ connector: CustomConnector) -> [ConnectorTool] {
        let mapped = connector.tools.map {
            ConnectorTool(slug: $0.name, name: $0.name, description: $0.description,
                          access: $0.access == .read ? .read : .write, mode: $0.mode, common: false)
        }
        return mapped.filter { $0.access == .read } + mapped.filter { $0.access == .write }
    }

    /// "Saved · ends in 3f9a" for a secret the vault holds.
    static func secretLine(_ info: SecretInfo?) -> LocalizedStringResource {
        guard let info, info.set else { return "Not set" }
        if let last4 = info.last4, !last4.isEmpty { return "Saved · ends in \(last4)" }
        return "Saved"
    }
}
