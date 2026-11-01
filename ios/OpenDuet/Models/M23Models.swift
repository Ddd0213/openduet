// M23 contract (backend/src/contract/m23.ts): where background writes came from, the brief's
// unchecked sources, and the quick-reply limits.
import Foundation

/// Where a memory or an Up next suggestion came from ("From Gmail · Re: Q4 budget"). Display only.
struct SourceRef: Decodable, Hashable, Sendable {
    enum Kind: String, Decodable, Sendable { case email, event, doc, chat, web }
    /// "Gmail", "Google Calendar"; nil for the chat itself
    var app: String?
    /// nil: a kind this build doesn't know
    var kind: Kind?
    var title: String
    var at: Date?

    private enum CodingKeys: String, CodingKey { case app, kind, title, at }

    init(app: String?, kind: Kind?, title: String, at: Date? = nil) {
        self.app = app
        self.kind = kind
        self.title = title
        self.at = at
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        app = try c.decodeIfPresent(String.self, forKey: .app)
        kind = try? c.decode(Kind.self, forKey: .kind)
        title = try c.decode(String.self, forKey: .title)
        at = try c.decodeIfPresent(Date.self, forKey: .at)
    }
}

/// TextPayload.brief: the morning brief's sources it couldn't read ("Couldn't check Gmail").
struct BriefInfo: Decodable, Hashable, Sendable {
    var unchecked: [String]
}

/// The quick-reply limits the server enforces (m23.ts): 2-3 options, each at most 24 characters.
enum QuickReplyLimits {
    static let min = 2
    static let max = 3
    static let maxChars = 24
}
