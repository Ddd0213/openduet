// M28 contract (backend/src/contract/m28.ts, docs/API.md "M28 sessions"): the signed-in devices.
// GET /api/sessions (SessionList), POST /api/sessions/revoke-others (RevokeOtherSessionsResponse),
// DELETE /api/sessions/:id (204), and the X-Device-Name header every request carries. Tolerant like
// the rest: a row without an id or a readable createdAt is skipped, missing fields read nil / false,
// so a newer server's extra fields or an odd row never empty the list.
import Foundation

/// One signed-in device: a live session of this account. Never carries the token.
struct SessionInfo: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    /// the session this app is using ("This iPhone"); exactly one row is current
    var current: Bool
    /// sign-in time
    var createdAt: Date
    /// the last request (the server writes it at most every 5 minutes); nil = none since M28
    var lastUsedAt: Date?
    /// createdAt + 90 days: the device is signed out by itself then
    var expiresAt: Date
    /// the app's X-Device-Name ("iPhone 15 Pro"); nil = an app before M28
    var deviceName: String?
    /// the sign-in's User-Agent; nil = none
    var userAgent: String?
    /// the sign-in's client IP; nil = unknown
    var signInIp: String?
    /// the last request's client IP; nil = none since M28
    var lastIp: String?
    /// an APNs token registered from this session gets pushes
    var push: Bool

    init(id: String, current: Bool, createdAt: Date, lastUsedAt: Date?, expiresAt: Date, deviceName: String?,
         userAgent: String?, signInIp: String?, lastIp: String?, push: Bool) {
        self.id = id
        self.current = current
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
        self.expiresAt = expiresAt
        self.deviceName = deviceName
        self.userAgent = userAgent
        self.signInIp = signInIp
        self.lastIp = lastIp
        self.push = push
    }

    /// The fixed lifetime (contract SESSION_MAX_AGE_MS): what a row without a readable expiresAt gets.
    static let maxAge: TimeInterval = 90 * 24 * 60 * 60

    private enum CodingKeys: String, CodingKey {
        case id, current, createdAt, lastUsedAt, expiresAt, deviceName, userAgent, signInIp, lastIp, push
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        current = (try? c.decodeIfPresent(Bool.self, forKey: .current)) ?? false
        lastUsedAt = try? c.decodeIfPresent(Date.self, forKey: .lastUsedAt)
        expiresAt = (try? c.decodeIfPresent(Date.self, forKey: .expiresAt)) ?? createdAt.addingTimeInterval(Self.maxAge)
        deviceName = Self.text(c, .deviceName)
        userAgent = Self.text(c, .userAgent)
        signInIp = Self.text(c, .signInIp)
        lastIp = Self.text(c, .lastIp)
        push = (try? c.decodeIfPresent(Bool.self, forKey: .push)) ?? false
    }

    /// A string field, nil for a missing, null, empty or non-string value.
    private static func text(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> String? {
        guard let value = try? c.decodeIfPresent(String.self, forKey: key), !value.isEmpty else { return nil }
        return value
    }
}

/// GET /api/sessions: the current session first, then the most recently used.
struct SessionList: Decodable, Hashable, Sendable {
    var sessions: [SessionInfo]

    init(sessions: [SessionInfo]) { self.sessions = sessions }

    /// This device's row ("This iPhone"), if the server listed it.
    var current: SessionInfo? { sessions.first(where: \.current) }
    /// Every other device, in the server's order.
    var others: [SessionInfo] { sessions.filter { !$0.current } }

    private enum CodingKeys: String, CodingKey { case sessions }

    /// One entry of `sessions`: a row, or nil for one this build can't read (never throws).
    private struct Entry: Decodable {
        let session: SessionInfo?
        init(from decoder: Decoder) throws { session = try? SessionInfo(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessions = ((try? c.decodeIfPresent([Entry].self, forKey: .sessions)) ?? []).compactMap(\.session)
    }
}

/// POST /api/sessions/revoke-others: how many other devices were signed out (0 is fine).
struct RevokeOtherSessionsResponse: Decodable, Hashable, Sendable {
    var revoked: Int

    init(revoked: Int) { self.revoked = revoked }

    private enum CodingKeys: String, CodingKey { case revoked }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        revoked = max(0, (try? c.decodeIfPresent(Int.self, forKey: .revoked)) ?? 0)
    }
}

/// The X-Device-Name header (contract DEVICE_NAME_HEADER / DeviceName): the device's model name.
enum DeviceNameHeader {
    static let field = "X-Device-Name"

    /// The server's rule: trimmed, 1-64 characters, printable ASCII (U+0020-U+007E); nil = send no
    /// header (the server would ignore the value anyway and keep the stored one).
    static func header(_ name: String?) -> String? {
        guard let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty, trimmed.unicodeScalars.count <= 64,
              trimmed.unicodeScalars.allSatisfy({ (0x20...0x7E).contains($0.value) }) else { return nil }
        return trimmed
    }
}
