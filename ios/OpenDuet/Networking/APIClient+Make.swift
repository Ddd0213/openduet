// M6 (iOS 2) routes (docs/API.md "Routes"): the Make tab's artifacts (list, create, detail, the
// HTML the viewer renders with loadHTMLString, refresh, edit, pin), the skills list, reactions
// and Good / Bad response feedback. Build progress arrives as `artifact` events; errors map to
// APIError as everywhere else.
import Foundation

extension APIClient {
    // MARK: - Artifacts

    /// GET /api/artifacts (newest first).
    nonisolated func artifacts() async throws -> [ArtifactSummary] {
        let list: ArtifactList = try await get("/api/artifacts")
        return list.artifacts
    }

    /// POST /api/artifacts -> the new artifact (status building).
    nonisolated func createArtifact(_ body: CreateArtifactRequest) async throws -> ArtifactSummary {
        let response: ArtifactResponse = try await call("POST", "/api/artifacts", json: body)
        return response.artifact
    }

    nonisolated func artifact(id: String) async throws -> ArtifactDetail {
        try await get("/api/artifacts/\(id.pathSegment)")
    }

    /// GET /api/artifacts/:id/html: the self-contained page (text/html), fetched through the
    /// signed-in session so the web view never loads a server URL itself (L172).
    nonisolated func artifactHTML(id: String) async throws -> String {
        var request = try makeRequest("GET", "/api/artifacts/\(id.pathSegment)/html")
        request.setValue("text/html", forHTTPHeaderField: "Accept")
        let data = try await send(request)
        guard let html = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else {
            throw APIError.invalidResponse
        }
        return html
    }

    /// POST /api/artifacts/:id/refresh (dashboard ↻): the artifact, building again until ready.
    nonisolated func refreshArtifact(id: String) async throws -> ArtifactSummary {
        let data = try await send(try makeRequest("POST", "/api/artifacts/\(id.pathSegment)/refresh"))
        return try decode(ArtifactResponse.self, from: data).artifact
    }

    /// POST /api/artifacts/:id/edit (✎ / Comment).
    nonisolated func editArtifact(id: String, prompt: String) async throws -> ArtifactSummary {
        let response: ArtifactResponse = try await call(
            "POST", "/api/artifacts/\(id.pathSegment)/edit", json: EditArtifactRequest(prompt: prompt)
        )
        return response.artifact
    }

    /// PATCH /api/artifacts/:id (Add to / Remove from tab bar). Pinning one unpins the previous.
    nonisolated func updateArtifact(id: String, _ body: UpdateArtifactRequest) async throws -> ArtifactSummary {
        let response: ArtifactResponse = try await call("PATCH", "/api/artifacts/\(id.pathSegment)", json: body)
        return response.artifact
    }

    /// M9: DELETE /api/artifacts/:id (204), long-press Delete on a gallery tile.
    nonisolated func deleteArtifact(id: String) async throws {
        _ = try await send(try makeRequest("DELETE", "/api/artifacts/\(id.pathSegment)"))
    }

    /// M27: GET /api/artifacts/:id/data: a dashboard's live data as it is now (`json` exactly as
    /// stored, nil when it has none), handed to the open page in place. Not an open.
    nonisolated func artifactData(id: String) async throws -> ArtifactDataResponse {
        try await get("/api/artifacts/\(id.pathSegment)/data")
    }

    /// M24: GET /api/artifacts/:id/versions (the viewer's ⋯ Versions and Undo): newest first,
    /// never the page itself.
    nonisolated func artifactVersions(id: String) async throws -> ArtifactVersionList {
        try await get("/api/artifacts/\(id.pathSegment)/versions")
    }

    /// M24: POST /api/artifacts/:id/restore {versionId}: that version becomes the newest (Undo
    /// restores the one before the newest). 409 while a build, edit or refresh runs; 404 for a
    /// version dropped by the limit.
    nonisolated func restoreArtifact(id: String, versionId: String) async throws -> ArtifactSummary {
        let response: ArtifactResponse = try await call(
            "POST", "/api/artifacts/\(id.pathSegment)/restore", json: RestoreArtifactRequest(versionId: versionId)
        )
        return response.artifact
    }

    // MARK: - Skills

    /// GET /api/skills ("/" in the composer).
    nonisolated func skills() async throws -> [Skill] {
        let list: SkillList = try await get("/api/skills")
        return list.skills
    }

    // MARK: - Reactions and feedback

    /// PUT (on) / DELETE (off) /api/messages/:id/reactions/:emoji -> the updated message.
    nonisolated func react(messageId: String, emoji: String, on: Bool) async throws -> Message {
        let path = "/api/messages/\(messageId.pathSegment)/reactions/\(emoji.pathSegment)"
        let data = try await send(try makeRequest(on ? "PUT" : "DELETE", path))
        return try decode(ReactionResponse.self, from: data).message
    }

    /// POST /api/feedback with the message and its rating (204; the server posts
    /// "Thanks for the feedback" as a system line).
    nonisolated func rate(messageId: String, _ rating: FeedbackRequest.Rating) async throws {
        try await sendFeedback(FeedbackRequest(messageId: messageId, rating: rating, text: nil))
    }
}
