// M17 wire shapes (backend/src/contract/m17.ts, docs/API.md "M17"): connector templates from the
// official MCP Registry, one-tap installs, remote MCP sign-in (OAuth start / finish) and pasted
// mcpServers configs. Connector answers are the M11 CustomConnector (with `registryName` / `oauth`).
import Foundation

// MARK: - Templates (GET /api/connector-templates)

/// What the user fills in for a template: a request header's value or one `{name}` part of the URL.
struct ConnectorTemplateInput: Codable, Hashable, Sendable, Identifiable {
    enum Kind: String, Codable, Sendable {
        case header
        case urlVariable
    }
    /// header: the header name ("Authorization"); urlVariable: the `{name}` in the URL
    var name: String
    var description: String
    /// a secret value goes to the vault (a secure field)
    var secret: Bool
    var required: Bool
    var kind: Kind
    var id: String { name }
}

struct ConnectorTemplate: Codable, Hashable, Sendable, Identifiable {
    struct Remote: Codable, Hashable, Sendable {
        enum Transport: String, Codable, Sendable {
            case streamableHTTP = "streamable-http"
            case sse
        }
        var type: Transport
        /// may still hold `{variables}`
        var url: String
    }
    /// the registry name, e.g. "com.notion/mcp" (the install key)
    var name: String
    var title: String
    var description: String
    var website: String?
    /// https, on the registry's or the vendor's host
    var iconUrl: String?
    var remote: Remote
    var inputs: [ConnectorTemplateInput]
    /// true = it asks for sign-in; false = it doesn't; nil = not known until it's installed
    var needsSignIn: Bool?
    var installed: Bool
    var featured: Bool
    var id: String { name }
}

/// GET /api/connector-templates?query=&cursor=
struct ConnectorTemplateList: Codable, Hashable, Sendable {
    var templates: [ConnectorTemplate]
    /// pass back as `cursor`; nil = the end
    var nextCursor: String?
}

/// POST /api/connector-templates/install. `inputs` is left out when empty (a one-tap install).
struct InstallTemplateRequest: Codable, Hashable, Sendable {
    var name: String
    var inputs: [String: String] = [:]

    init(name: String, inputs: [String: String] = [:]) {
        self.name = name
        self.inputs = inputs
    }

    private enum CodingKeys: String, CodingKey { case name, inputs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        inputs = try c.decodeIfPresent([String: String].self, forKey: .inputs) ?? [:]
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        if !inputs.isEmpty { try c.encode(inputs, forKey: .inputs) }
    }
}

struct InstallTemplateResponse: Decodable, Hashable, Sendable {
    var connector: CustomConnector
    /// the server asks for sign-in: POST /api/custom-connectors/:id/oauth/start next
    var needsSignIn: Bool
}

// MARK: - Sign-in (remote MCP OAuth)

/// POST /api/custom-connectors/:id/oauth/start (no body).
struct OAuthStartResponse: Decodable, Hashable, Sendable {
    /// open in ASWebAuthenticationSession
    var authorizeUrl: String
    /// "duet"
    var callbackScheme: String
    /// "duet://oauth/callback"
    var redirectUri: String
    /// the sign-in must finish before this (about 10 minutes)
    var expiresAt: Date
}

/// POST /api/custom-connectors/:id/oauth/finish: the query of the callback URL. Absent values are
/// left out (the server's schema is strict).
struct OAuthFinishRequest: Codable, Hashable, Sendable {
    var state: String
    var code: String?
    var error: String?
    var errorDescription: String?

    init(state: String, code: String? = nil, error: String? = nil, errorDescription: String? = nil) {
        self.state = state
        self.code = code
        self.error = error
        self.errorDescription = errorDescription
    }

    private enum CodingKeys: String, CodingKey { case state, code, error, errorDescription }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(state, forKey: .state)
        try c.encodeIfPresent(code, forKey: .code)
        try c.encodeIfPresent(error, forKey: .error)
        try c.encodeIfPresent(errorDescription, forKey: .errorDescription)
    }
}

// MARK: - Paste a config (POST /api/custom-connectors/import)

struct ImportConnectorsRequest: Codable, Hashable, Sendable {
    /// a Claude / Cursor / VS Code / Zed config, a bare map of servers or one entry
    var json: String
}

struct ImportConnectorsResponse: Decodable, Hashable, Sendable {
    struct Skipped: Decodable, Hashable, Sendable, Identifiable {
        enum Reason: Decodable, Hashable, Sendable {
            /// a `command` entry: runs a program locally
            case stdio
            /// a connector with that URL is there already
            case exists
            /// no usable https URL, a bad header, placeholders, over 20
            case invalid
            /// the check failed (`message` has the reason)
            case failed
            /// a newer server's reason
            case other(String)

            init(from decoder: Decoder) throws {
                let raw = try decoder.singleValueContainer().decode(String.self)
                switch raw {
                case "stdio": self = .stdio
                case "exists": self = .exists
                case "invalid": self = .invalid
                case "failed": self = .failed
                default: self = .other(raw)
                }
            }
        }
        var name: String
        var reason: Reason
        /// the details in plain words
        var message: String
        var id: String { name }
    }
    /// created, in config order; those with `oauth.needsSignIn` wait for sign-in
    var connectors: [CustomConnector]
    var skipped: [Skipped]
}
