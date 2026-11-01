// M11: the channel system (backend/src/contract/m11.ts): the soul, the two memory layers, what a
// channel can use (skills, custom connectors, apps), Agent Skills folders and imports, and custom
// connectors (MCP servers, domain-bound API keys) whose secrets stay in the server's vault.
import Foundation

// MARK: - Soul

/// GET / PUT /api/soul. `name` is what the assistant calls itself in replies; the app keeps showing "OpenDuet".
struct Soul: Decodable, Hashable, Sendable {
    var name: String
    var addressAs: String
    var identity: String
    var persona: String
    var tone: String
    var updatedAt: Date?
}

/// PUT /api/soul: only the fields that change.
struct UpdateSoulRequest: Codable, Hashable, Sendable {
    var name: String? = nil
    var addressAs: String? = nil
    var identity: String? = nil
    var persona: String? = nil
    var tone: String? = nil
}

// MARK: - Memory

enum MemorySource: String, Codable, AssistantValue, Sendable { case user, assistant, dreaming }

/// One saved fact ("About you" or a channel's own). `sourceMessageId`: the message it came from.
struct MemoryFact: Decodable, Hashable, Sendable, Identifiable {
    var id: ID
    var text: String
    var source: MemorySource = .assistant
    var sourceMessageId: ID? = nil
    var createdAt: Date
    /// M23: where a fact saved in the background was read (an email, an event); nil otherwise
    var sourceRef: SourceRef? = nil

    private enum CodingKeys: String, CodingKey { case id, text, source, sourceMessageId, createdAt, sourceRef }

    init(id: ID, text: String, source: MemorySource = .assistant, sourceMessageId: ID? = nil, createdAt: Date) {
        self.id = id; self.text = text; self.source = source; self.sourceMessageId = sourceMessageId; self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ID.self, forKey: .id)
        text = try c.decode(String.self, forKey: .text)
        source = (try? c.decodeIfPresent(MemorySource.self, forKey: .source)) ?? .assistant
        sourceMessageId = try c.decodeIfPresent(ID.self, forKey: .sourceMessageId)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        sourceRef = try? c.decodeIfPresent(SourceRef.self, forKey: .sourceRef)
    }
}

/// GET / PUT /api/channels/:id/memory: the channel's own memory.
struct ChannelMemoryState: Decodable, Hashable, Sendable {
    var channelId: ID
    var useSharedMemory: Bool
    var document: String
    var facts: [MemoryFact]
    var updatedAt: Date?
}

/// POST /api/memory/facts (channelId nil = "About you"; sent as an explicit null).
struct CreateMemoryFactRequest: Codable, Hashable, Sendable {
    var channelId: ID?
    var text: String

    private enum CodingKeys: String, CodingKey { case channelId, text }
    init(channelId: ID?, text: String) { self.channelId = channelId; self.text = text }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(channelId, forKey: .channelId)
        try c.encode(text, forKey: .text)
    }
}

/// PATCH /api/memory/facts/:id
struct UpdateMemoryFactRequest: Codable, Hashable, Sendable {
    var text: String
}

struct MemoryFactResponse: Decodable, Sendable {
    var fact: MemoryFact
}

/// GET /api/memory/overview (Everything): each channel's purpose and recent activity, never its private memory.
struct MemoryOverview: Decodable, Hashable, Sendable {
    struct ChannelSummary: Decodable, Hashable, Sendable, Identifiable {
        var channelId: ID
        var name: String
        var purpose: String
        var useSharedMemory: Bool
        var factCount: Int
        var lastMessageAt: Date?
        var recent: String?
        var id: ID { channelId }
    }
    var channels: [ChannelSummary]
}

// MARK: - Access (what a channel can use)

enum AccessKind: String, Codable, Sendable { case skill, connector, app }
enum AccessScope: String, Codable, Sendable { case all, channels }

/// A skill (Skill.id), a custom connector (CustomConnector.id) or an app (a Composio toolkit slug).
struct AccessRef: Codable, Hashable, Sendable {
    var kind: AccessKind
    var id: String
}

/// GET /api/channels/:id/access
struct ChannelAccess: Decodable, Hashable, Sendable {
    struct Item: Decodable, Hashable, Sendable, Identifiable {
        var kind: AccessKind
        var id: String
        var name: String
        var description: String
        /// the item's own default
        var scope: AccessScope
        /// usable in this channel now
        var enabled: Bool
        var ref: AccessRef { AccessRef(kind: kind, id: id) }
    }
    var channelId: ID
    var items: [Item]
}

/// PUT /api/channels/:id/access (not on the main thread).
struct UpdateChannelAccessRequest: Codable, Hashable, Sendable {
    struct Change: Codable, Hashable, Sendable {
        var kind: AccessKind
        var id: String
        var enabled: Bool
    }
    var changes: [Change]
}

/// PUT /api/access/scope ("Share with all channels" = all) -> 204.
struct UpdateAccessScopeRequest: Codable, Hashable, Sendable {
    var ref: AccessRef
    var scope: AccessScope
}

// MARK: - Skills (Agent Skills folders)

/// M25: `upload` = Add skill › Upload a skill (a .zip, a .skill or a single SKILL.md). Skill decodes
/// an unknown value as `.manual`.
enum SkillSource: String, Codable, AssistantValue, Sendable { case manual, github, zip, assistant, upload }

/// A file in a skill folder other than SKILL.md.
struct SkillFileInfo: Decodable, Hashable, Sendable {
    var path: String
    var size: Int
    /// false for binary files (not shown or edited in the app)
    var text: Bool
}

/// GET /api/skills/:id/files/<path>
struct SkillFileContent: Decodable, Hashable, Sendable {
    var path: String
    var text: String
}

/// A text file written in the app. In PATCH, `text` nil deletes it (sent as an explicit null).
struct SkillFileWrite: Codable, Hashable, Sendable {
    var path: String
    var text: String?

    private enum CodingKeys: String, CodingKey { case path, text }
    init(path: String, text: String?) { self.path = path; self.text = text }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(path, forKey: .path)
        try c.encode(text, forKey: .text)
    }
}

/// PATCH /api/skills/:id
struct UpdateSkillRequest: Codable, Hashable, Sendable {
    var description: String? = nil
    var instructions: String? = nil
    var files: [SkillFileWrite]? = nil
}

/// GET /api/skills/github/preview?url= and POST /api/skills/zip/preview: nothing saved yet.
/// M25: POST /api/skills/upload/preview (.zip, .skill or SKILL.md) answers `upload`.
struct SkillImportPreview: Decodable, Hashable, Sendable {
    enum Source: String, Decodable, Sendable { case github, zip, upload }
    struct Candidate: Decodable, Hashable, Sendable, Identifiable {
        var name: String
        var description: String
        var excerpt: String
        var files: [SkillFileInfo]
        /// its scripts run on the assistant's computer; the first run asks
        var hasScripts: Bool
        /// importing replaces the skill with this name
        var exists: Bool
        var id: String { name }
    }
    var importId: ID
    var source: Source
    var sourceUrl: String?
    var skills: [Candidate]
    var warnings: [String]
}

/// POST /api/skills/import -> SkillList. channelId nil = Everything (all channels).
struct SkillImportRequest: Codable, Hashable, Sendable {
    var importId: ID
    var names: [String]
    var channelId: ID?

    private enum CodingKeys: String, CodingKey { case importId, names, channelId }
    init(importId: ID, names: [String], channelId: ID?) { self.importId = importId; self.names = names; self.channelId = channelId }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(importId, forKey: .importId)
        try c.encode(names, forKey: .names)
        try c.encode(channelId, forKey: .channelId)
    }
}

// MARK: - Custom connectors

/// A secret the server keeps: only whether it's set and its last 4 characters.
struct SecretInfo: Decodable, Hashable, Sendable {
    var set: Bool
    var last4: String?
}

struct ConnectorHeader: Decodable, Hashable, Sendable {
    var name: String
    var secret: Bool
    /// plain headers only
    var value: String?
    /// secret headers only
    var secretInfo: SecretInfo?
}

struct CustomConnectorTool: Decodable, Hashable, Sendable, Identifiable {
    enum Access: String, Decodable, Sendable { case read, write }
    var name: String
    var description: String
    var access: Access
    var mode: PolicyMode
    /// M20: false when the picker's Always is disabled (missing from an older server = true).
    var alwaysAllowed = true
    /// M20: why Always is disabled.
    var alwaysBlocked: AlwaysBlocked?
    var id: String { name }
}

extension CustomConnectorTool {
    private enum CodingKeys: String, CodingKey { case name, description, access, mode, alwaysAllowed, alwaysBlocked }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        description = try c.decode(String.self, forKey: .description)
        access = try c.decode(Access.self, forKey: .access)
        mode = try c.decode(PolicyMode.self, forKey: .mode)
        alwaysAllowed = try c.decodeIfPresent(Bool.self, forKey: .alwaysAllowed) ?? true
        alwaysBlocked = (try? c.decodeIfPresent(AlwaysBlocked.self, forKey: .alwaysBlocked)) ?? nil
    }
}

struct CustomConnector: Decodable, Hashable, Sendable, Identifiable {
    enum Kind: String, Codable, Sendable {
        case mcp
        case apiKey = "api_key"
    }
    enum Status: String, Decodable, Sendable { case active, failed }
    var id: ID
    var kind: Kind
    var name: String
    var description: String
    var url: String?
    var domain: String?
    var headerName: String?
    var valuePrefix: String?
    var secret: SecretInfo?
    var headers: [ConnectorHeader]
    var status: Status
    var error: String?
    var tools: [CustomConnectorTool]
    var scope: AccessScope
    var channelIds: [ID]
    var createdAt: Date
    /// M17: the MCP Registry name it was installed from; nil when added by hand (or an older server)
    var registryName: String?
    /// M17: its OAuth sign-in; nil when the server doesn't use one (or an older server)
    var oauth: ConnectorOAuthState?
}

/// M17: whether a remote MCP server's sign-in tokens are stored (they never leave the server).
struct ConnectorOAuthState: Decodable, Hashable, Sendable {
    var signedIn: Bool
    /// show "Sign in"
    var needsSignIn: Bool
    /// when the current access token runs out (the server renews it on its own); nil = unknown
    var expiresAt: Date?
}

/// GET /api/custom-connectors
struct CustomConnectorList: Decodable, Sendable {
    var connectors: [CustomConnector]
}

struct CustomConnectorResponse: Decodable, Sendable {
    var connector: CustomConnector
}

/// POST /api/custom-connectors ("Add connector"): verified before it's saved (400 with the reason).
enum CreateCustomConnectorRequest: Codable, Hashable, Sendable {
    struct Header: Codable, Hashable, Sendable {
        var name: String
        var value: String
        var secret: Bool
    }
    case mcp(name: String, description: String, url: String, headers: [Header])
    case apiKey(name: String, description: String, domain: String, headerName: String, valuePrefix: String, key: String)

    private enum CodingKeys: String, CodingKey { case kind, name, description, url, headers, domain, headerName, valuePrefix, key }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let name = try c.decode(String.self, forKey: .name)
        let description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        switch try c.decode(CustomConnector.Kind.self, forKey: .kind) {
        case .mcp:
            self = .mcp(name: name, description: description, url: try c.decode(String.self, forKey: .url),
                        headers: try c.decodeIfPresent([Header].self, forKey: .headers) ?? [])
        case .apiKey:
            self = .apiKey(name: name, description: description, domain: try c.decode(String.self, forKey: .domain),
                           headerName: try c.decodeIfPresent(String.self, forKey: .headerName) ?? "Authorization",
                           valuePrefix: try c.decodeIfPresent(String.self, forKey: .valuePrefix) ?? "Bearer ",
                           key: try c.decode(String.self, forKey: .key))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .mcp(name, description, url, headers):
            try c.encode(CustomConnector.Kind.mcp, forKey: .kind)
            try c.encode(name, forKey: .name); try c.encode(description, forKey: .description)
            try c.encode(url, forKey: .url); try c.encode(headers, forKey: .headers)
        case let .apiKey(name, description, domain, headerName, valuePrefix, key):
            try c.encode(CustomConnector.Kind.apiKey, forKey: .kind)
            try c.encode(name, forKey: .name); try c.encode(description, forKey: .description)
            try c.encode(domain, forKey: .domain); try c.encode(headerName, forKey: .headerName)
            try c.encode(valuePrefix, forKey: .valuePrefix); try c.encode(key, forKey: .key)
        }
    }
}

/// PATCH /api/custom-connectors/:id. A header with value nil keeps its stored value (explicit null).
struct UpdateCustomConnectorRequest: Codable, Hashable, Sendable {
    struct Header: Codable, Hashable, Sendable {
        var name: String
        var value: String?
        var secret: Bool

        private enum CodingKeys: String, CodingKey { case name, value, secret }
        init(name: String, value: String?, secret: Bool) { self.name = name; self.value = value; self.secret = secret }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(name, forKey: .name)
            try c.encode(value, forKey: .value)
            try c.encode(secret, forKey: .secret)
        }
    }
    var name: String? = nil
    var description: String? = nil
    var url: String? = nil
    var domain: String? = nil
    var headerName: String? = nil
    var valuePrefix: String? = nil
    var key: String? = nil
    var headers: [Header]? = nil
}

/// POST /api/messages/:id/connect: what the user typed into a connection_request card (to the vault).
struct ConnectRequestSubmit: Codable, Hashable, Sendable {
    var name: String? = nil
    var url: String? = nil
    var domain: String? = nil
    /// the card's field key -> the typed value
    var values: [String: String]
}
