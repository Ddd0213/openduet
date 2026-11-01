// M25 contract (backend/src/contract/m25.ts): the built-in key-less connectors (Settings › Apps and
// connectors › "Built in"). What M25 adds to older models (SkillSource.upload,
// SkillImportPreview.Source.upload) sits next to those models; X-Region is in RequestContext.
// Tolerant like the rest: an unknown id drops the row, an unknown state reads nil.
import Foundation

/// One built-in: the key-less read-only tool every user has. The app has its own name, icon and
/// "what it sends where" line for each id; `providers` are proper names, shown as sent.
struct BuiltinConnector: Decodable, Hashable, Sendable, Identifiable {
    /// Also the tool's name.
    enum Kind: String, Decodable, Sendable, CaseIterable { case webSearch = "web_search", weather, exchangeRate = "exchange_rate", readFeed = "read_feed" }
    /// on = the assistant has it; off = turned off on this server; unreachable = its last call couldn't
    /// reach the service.
    enum State: String, Decodable, Sendable { case on, off, unreachable }

    var kind: Kind
    /// nil: a state from a newer server (show it like on, without a status line)
    var state: State?
    /// who answers, in the order tried ("Exa", "Parallel"); empty for read_feed and while off
    var providers: [String]
    /// no key or account (a free tier / a public service)
    var keyless: Bool
    /// when a call last reached (or failed to reach) the service; nil = not since the server started
    var checkedAt: Date?

    var id: String { kind.rawValue }

    private enum CodingKeys: String, CodingKey { case id, state, providers, keyless, checkedAt }

    init(kind: Kind, state: State?, providers: [String], keyless: Bool, checkedAt: Date?) {
        self.kind = kind
        self.state = state
        self.providers = providers
        self.keyless = keyless
        self.checkedAt = checkedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(Kind.self, forKey: .id)
        state = try? c.decodeIfPresent(State.self, forKey: .state)
        providers = (try? c.decodeIfPresent([String].self, forKey: .providers)) ?? []
        keyless = (try? c.decodeIfPresent(Bool.self, forKey: .keyless)) ?? true
        checkedAt = try c.decodeIfPresent(Date.self, forKey: .checkedAt)
    }
}

/// GET /api/builtin-connectors: every built-in in the server's order, off ones included. A row with
/// an id this build doesn't know is dropped.
struct BuiltinConnectorList: Decodable, Hashable, Sendable {
    var connectors: [BuiltinConnector]

    private enum CodingKeys: String, CodingKey { case connectors }

    /// One element, kept only when this build knows its id.
    private struct Known: Decodable {
        var value: BuiltinConnector?
        init(from decoder: Decoder) throws { value = try? BuiltinConnector(from: decoder) }
    }

    init(connectors: [BuiltinConnector]) { self.connectors = connectors }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connectors = (try c.decodeIfPresent([Known].self, forKey: .connectors) ?? []).compactMap(\.value)
    }
}

/// X-Region (RequestContext): the iPhone's region as the server takes it (m25.ts RegionCode).
enum RegionCode {
    /// "us" -> "US"; nil for anything but two ASCII letters ("001" = World, "", nil): no header then.
    static func header(_ identifier: String?) -> String? {
        guard let identifier, identifier.count == 2, identifier.allSatisfy({ $0.isASCII && $0.isLetter }) else { return nil }
        return identifier.uppercased()
    }
}
