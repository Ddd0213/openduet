// Connectors (Composio toolkits) and tool policies (backend/src/contract/connectors.ts).
// The UI always shows `name` (the display name), never the toolkit slug.
import Foundation

enum PolicyMode: String, Codable, Sendable { case ask, always }

/// The rows of the OpenDuet sheet's "What OpenDuet has access to".
enum AccessCategory: String, Decodable, Sendable {
    case files, mail, calendar, payments
    case teamChat = "team_chat"
}

struct ConnectedAccount: Decodable, Hashable, Sendable, Identifiable {
    enum Status: String, Decodable, Sendable { case active, expired, failed }
    var id: ID
    /// The real address or handle of the account.
    var label: String
    var status: Status
    var connectedAt: Date
}

struct Connector: Decodable, Hashable, Sendable, Identifiable {
    /// Composio toolkit slug: an identifier only, never shown.
    var toolkit: String
    var name: String
    var description: String
    /// Server-relative logo URL fetched through the session.
    var logoUrl: String?
    var category: AccessCategory?
    var accounts: [ConnectedAccount]

    var id: String { toolkit }
    var isConnected: Bool { !accounts.isEmpty }
}

/// GET /api/connectors?query=: connected first, then the catalog.
struct ConnectorList: Decodable, Sendable {
    /// False when COMPOSIO_API_KEY isn't set: the app shows "isn't set up yet".
    var configured: Bool
    var connectors: [Connector]
}

struct ConnectorTool: Decodable, Hashable, Sendable, Identifiable {
    enum Access: String, Decodable, Sendable { case read, write }
    var slug: String
    var name: String
    var description: String
    var access: Access
    var mode: PolicyMode
    /// Common tools are listed first in each group.
    var common: Bool
    /// M20: false when the picker's Always is disabled for this tool (missing from an older server = true).
    var alwaysAllowed = true
    /// M20: why Always is disabled.
    var alwaysBlocked: AlwaysBlocked?

    var id: String { slug }
}

/// M20: why a tool's Ask / Always picker can't be set to Always.
enum AlwaysBlocked: String, Decodable, Hashable, Sendable {
    /// payments, passwords / credentials and security settings always ask
    case floor
    /// it sends to other people: Always is chosen on its approval card, for that recipient only
    case perRecipient = "per_recipient"
}

extension ConnectorTool {
    private enum CodingKeys: String, CodingKey { case slug, name, description, access, mode, common, alwaysAllowed, alwaysBlocked }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        slug = try c.decode(String.self, forKey: .slug)
        name = try c.decode(String.self, forKey: .name)
        description = try c.decode(String.self, forKey: .description)
        access = try c.decode(Access.self, forKey: .access)
        mode = try c.decode(PolicyMode.self, forKey: .mode)
        common = try c.decode(Bool.self, forKey: .common)
        alwaysAllowed = try c.decodeIfPresent(Bool.self, forKey: .alwaysAllowed) ?? true
        // An unknown reason from a newer server still disables Always (alwaysAllowed false).
        alwaysBlocked = (try? c.decodeIfPresent(AlwaysBlocked.self, forKey: .alwaysBlocked)) ?? nil
    }
}

/// GET /api/connectors/:toolkit: the connector detail sheet.
struct ConnectorDetail: Decodable, Sendable {
    var connector: Connector
    var tools: [ConnectorTool]
}

/// POST /api/connectors/:toolkit/connect: open `url` in ASWebAuthenticationSession, callback duet://oauth.
struct ConnectResponse: Decodable, Sendable {
    var url: URL
    var callbackScheme: String
}

/// PUT /api/connectors/:toolkit/policy: one tool, or "All tools" when tool is nil.
struct UpdatePolicyRequest: Codable, Hashable, Sendable {
    var tool: String?
    var mode: PolicyMode

    private enum CodingKeys: String, CodingKey { case tool, mode }

    // `tool` is required on the wire, so nil goes out as an explicit null.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(tool, forKey: .tool)
        try c.encode(mode, forKey: .mode)
    }
}
