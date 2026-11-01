// The JSON routes the M2 data layer uses (docs/API.md "Routes").
import Foundation

extension APIClient {
    /// GET /api/server-info (no auth): the sign-in screen's address check.
    nonisolated func serverInfo(timeout: TimeInterval = 6) async throws -> ServerInfo {
        try await get("/api/server-info", timeout: timeout)
    }

    /// POST /api/session. Also returns the `user` JSON alone, for the offline cache (never the token).
    nonisolated func signIn(username: String, password: String) async throws -> (SignInResponse, Data?) {
        let data = try await send(try makeRequest("POST", "/api/session", json: SignInRequest(username: username, password: password)))
        return (try decode(SignInResponse.self, from: data), Self.jsonField("user", of: data))
    }

    /// DELETE /api/session (revokes this token on the server).
    nonisolated func signOut() async throws {
        _ = try await send(try makeRequest("DELETE", "/api/session"))
    }

    /// GET /api/me, with its raw JSON for the offline cache.
    nonisolated func me(timeout: TimeInterval? = nil) async throws -> (CurrentUser, Data) {
        let data = try await send(try makeRequest("GET", "/api/me", timeout: timeout))
        return (try decode(CurrentUser.self, from: data), data)
    }

    nonisolated func channels() async throws -> [Channel] {
        let list: ChannelList = try await get("/api/channels")
        return list.channels
    }

    /// GET /api/channels/:id/messages, newest page or the page before `before` (oldest first).
    nonisolated func messages(channelId: String, before: String?, limit: Int = 50) async throws -> MessagePage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.insert(URLQueryItem(name: "before", value: before), at: 0) }
        return try await get("/api/channels/\(channelId.pathSegment)/messages", query: query)
    }

    /// M21: `messageId` = the newest message seen; the server reads up to its own createdAt.
    nonisolated func markRead(channelId: String, at date: Date, messageId: String? = nil) async throws {
        let body = MarkReadRequest(at: date, messageId: messageId)
        _ = try await send(try makeRequest("POST", "/api/channels/\(channelId.pathSegment)/read", json: body))
    }

    /// DELETE /api/files/:id (an uploaded attachment removed before sending).
    nonisolated func deleteFile(id: String) async throws {
        _ = try await send(try makeRequest("DELETE", "/api/files/\(id.pathSegment)"))
    }

    /// One top-level field of a JSON object, re-serialized.
    static func jsonField(_ name: String, of data: Data) -> Data? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let field = object[name], JSONSerialization.isValidJSONObject(field) else { return nil }
        return try? JSONSerialization.data(withJSONObject: field)
    }
}
