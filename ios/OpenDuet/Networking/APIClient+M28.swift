// M28 routes (docs/API.md "M28 sessions"): the signed-in devices. GET /api/sessions lists them (the
// current one first), DELETE /api/sessions/:id signs one out (204; the current one is 400
// validation_failed field id, an unknown or expired one 404 not_found), POST
// /api/sessions/revoke-others signs out every other device at once. Errors map to APIError as
// everywhere else; a 401 runs `onUnauthorized` (back to sign-in).
import Foundation

extension APIClient {
    /// GET /api/sessions: every live session of this account, the current one first. A server from
    /// before M28 answers 404 not_found.
    nonisolated func sessions() async throws -> SessionList {
        try await get("/api/sessions")
    }

    /// DELETE /api/sessions/:id (204): that device is signed out at once.
    nonisolated func deleteSession(id: String) async throws {
        _ = try await send(try makeRequest("DELETE", "/api/sessions/\(id.pathSegment)"))
    }

    /// POST /api/sessions/revoke-others: every other device signed out in one go (`revoked` may be 0).
    nonisolated func revokeOtherSessions() async throws -> RevokeOtherSessionsResponse {
        try decode(RevokeOtherSessionsResponse.self, from: try await send(try makeRequest("POST", "/api/sessions/revoke-others")))
    }
}
