// M11 "Add connector" (Everything > Connectors), without SwiftUI for the host tests: the field
// rules the server also checks (an https URL, a domain shape, a header name), the form's draft
// and its POST body, and dropping the secrets once they were sent. The edit form and the
// connector rows' copy: ConnectorEditDraft.swift.
import Foundation

enum ConnectorFormRules {
    /// backend custom-connectors/service.ts NAME_MAX, contract/m11.ts limits
    static let nameLimit = 80
    static let prefixLimit = 20
    static let maxHeaders = 10

    static func clean(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// An MCP server address: https with a host, no spaces (the server also refuses private addresses).
    static func isHTTPSURL(_ text: String) -> Bool {
        let text = clean(text)
        guard !text.contains(where: \.isWhitespace), let url = URLComponents(string: text),
              url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty else { return false }
        return true
    }

    /// What the server keeps of a typed domain: no scheme, no path, lowercase, no trailing dot.
    static func normalizedDomain(_ text: String) -> String {
        var text = clean(text).lowercased()
        for scheme in ["https://", "http://"] where text.hasPrefix(scheme) {
            text.removeFirst(scheme.count)
        }
        text = String(text.prefix { $0 != "/" && $0 != "?" && $0 != "#" })
        if text.hasSuffix(".") { text.removeLast() }
        return text
    }

    /// A public host name like api.example.com: labels of letters, digits and inner dashes, at
    /// least two of them, a letter TLD (or an IDN xn-- one), at most 253 characters. No IPs, no ports.
    static func isDomain(_ text: String) -> Bool {
        let domain = normalizedDomain(text)
        guard !domain.isEmpty, domain.count <= 253 else { return false }
        let labels = domain.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2 else { return false }
        for label in labels where label.wholeMatch(of: /[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?/) == nil {
            return false
        }
        guard let tld = labels.last else { return false }
        return tld.wholeMatch(of: /[a-z]{2,63}/) != nil || tld.hasPrefix("xn--")
    }

    /// A request header name (contract: letters, digits and dashes, 1–64).
    static func isHeaderName(_ text: String) -> Bool {
        clean(text).wholeMatch(of: /[A-Za-z0-9-]{1,64}/) != nil
    }
}

/// One request header row of an MCP connector form. `stored`: an existing header whose secret
/// stays in the vault while its value is left blank (edit form only).
struct HeaderDraft: Hashable, Sendable, Identifiable {
    var id = UUID()
    var name = ""
    var value = ""
    var secret = true
    var stored = false
}

/// The Add connector form as typed.
struct ConnectorDraft: Hashable, Sendable {
    enum Problem: Hashable, Sendable {
        case name, url, domain, headerName, duplicateHeader, prefix
    }

    var kind: CustomConnector.Kind = .mcp
    var name = ""
    var description = ""
    // MCP server
    var url = ""
    var headers: [HeaderDraft] = []
    // API key
    var domain = ""
    var headerName = "Authorization"
    var valuePrefix = "Bearer "
    var key = ""

    /// Format problems of what's typed (an empty field isn't one: it only keeps Save off).
    var problems: Set<Problem> {
        var problems = Set<Problem>()
        if ConnectorFormRules.clean(name).count > ConnectorFormRules.nameLimit { problems.insert(.name) }
        switch kind {
        case .mcp:
            if !ConnectorFormRules.clean(url).isEmpty, !ConnectorFormRules.isHTTPSURL(url) { problems.insert(.url) }
            let named = headers.map { ConnectorFormRules.clean($0.name) }.filter { !$0.isEmpty }
            if named.contains(where: { !ConnectorFormRules.isHeaderName($0) }) { problems.insert(.headerName) }
            if Set(named.map { $0.lowercased() }).count != named.count { problems.insert(.duplicateHeader) }
        case .apiKey:
            if !ConnectorFormRules.clean(domain).isEmpty, !ConnectorFormRules.isDomain(domain) { problems.insert(.domain) }
            if !ConnectorFormRules.isHeaderName(headerName) { problems.insert(.headerName) }
            if valuePrefix.count > ConnectorFormRules.prefixLimit { problems.insert(.prefix) }
        }
        return problems
    }

    /// Everything required is filled in (every header row has a name and a value).
    var isComplete: Bool {
        guard !ConnectorFormRules.clean(name).isEmpty else { return false }
        switch kind {
        case .mcp:
            return !ConnectorFormRules.clean(url).isEmpty && headers.count <= ConnectorFormRules.maxHeaders
                && headers.allSatisfy { !ConnectorFormRules.clean($0.name).isEmpty && !ConnectorFormRules.clean($0.value).isEmpty }
        case .apiKey:
            return !ConnectorFormRules.clean(domain).isEmpty && !ConnectorFormRules.clean(key).isEmpty
        }
    }

    var canSave: Bool { isComplete && problems.isEmpty }

    /// POST /api/custom-connectors; nil until the form can be saved.
    var request: CreateCustomConnectorRequest? {
        guard canSave else { return nil }
        let name = ConnectorFormRules.clean(name)
        let description = ConnectorFormRules.clean(description)
        switch kind {
        case .mcp:
            let headers = headers.map {
                CreateCustomConnectorRequest.Header(name: ConnectorFormRules.clean($0.name), value: ConnectorFormRules.clean($0.value), secret: $0.secret)
            }
            return .mcp(name: name, description: description, url: ConnectorFormRules.clean(url), headers: headers)
        case .apiKey:
            return .apiKey(name: name, description: description, domain: ConnectorFormRules.normalizedDomain(domain),
                           headerName: ConnectorFormRules.clean(headerName), valuePrefix: valuePrefix, key: ConnectorFormRules.clean(key))
        }
    }

    /// After Save was tapped: the key and secret header values are gone (sent once, never kept);
    /// the rest stays, so a refused form is still filled in.
    mutating func dropSecrets() {
        key = ""
        for index in headers.indices where headers[index].secret {
            headers[index].value = ""
        }
    }

    var hasSecrets: Bool {
        !key.isEmpty || headers.contains { $0.secret && !$0.value.isEmpty }
    }
}
