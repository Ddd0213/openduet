// M11 routes: the soul, the two memory layers, channel access, skills folders and imports, custom
// connectors and connection cards (docs/API.md "M11"). 409 conflict / 400 validation_failed come
// back as APIError like everywhere else; a failed connector check is .validationFailed(message:).
import Foundation

extension APIClient {
    // MARK: - Soul

    nonisolated func soul() async throws -> Soul { try await get("/api/soul") }

    nonisolated func updateSoul(_ body: UpdateSoulRequest) async throws -> Soul {
        try await call("PUT", "/api/soul", json: body)
    }

    // MARK: - Memory

    /// GET /api/channels/:id/memory: a channel's own memory (the main thread's is GET /api/memory).
    nonisolated func channelMemory(channelId: String) async throws -> ChannelMemoryState {
        try await get("/api/channels/\(channelId.pathSegment)/memory")
    }

    nonisolated func updateChannelMemory(channelId: String, document: String) async throws -> ChannelMemoryState {
        try await call("PUT", "/api/channels/\(channelId.pathSegment)/memory", json: UpdateMemoryRequest(document: document))
    }

    nonisolated func addMemoryFact(_ body: CreateMemoryFactRequest) async throws -> MemoryFact {
        let response: MemoryFactResponse = try await call("POST", "/api/memory/facts", json: body)
        return response.fact
    }

    nonisolated func updateMemoryFact(id: String, text: String) async throws -> MemoryFact {
        let response: MemoryFactResponse = try await call("PATCH", "/api/memory/facts/\(id.pathSegment)", json: UpdateMemoryFactRequest(text: text))
        return response.fact
    }

    /// DELETE /api/memory/facts/:id (204): the fact is archived (forgotten).
    nonisolated func forgetMemoryFact(id: String) async throws {
        _ = try await send(try makeRequest("DELETE", "/api/memory/facts/\(id.pathSegment)"))
    }

    nonisolated func memoryOverview() async throws -> MemoryOverview { try await get("/api/memory/overview") }

    // MARK: - Access

    nonisolated func channelAccess(channelId: String) async throws -> ChannelAccess {
        try await get("/api/channels/\(channelId.pathSegment)/access")
    }

    nonisolated func updateChannelAccess(channelId: String, _ body: UpdateChannelAccessRequest) async throws -> ChannelAccess {
        try await call("PUT", "/api/channels/\(channelId.pathSegment)/access", json: body)
    }

    /// PUT /api/access/scope (204).
    nonisolated func updateAccessScope(_ body: UpdateAccessScopeRequest) async throws {
        _ = try await send(try makeRequest("PUT", "/api/access/scope", json: body))
    }

    // MARK: - Skills

    nonisolated func createSkill(_ body: CreateSkillRequest) async throws -> Skill {
        try await call("POST", "/api/skills", json: body)
    }

    nonisolated func updateSkill(id: String, _ body: UpdateSkillRequest) async throws -> Skill {
        try await call("PATCH", "/api/skills/\(id.pathSegment)", json: body)
    }

    nonisolated func deleteSkill(id: String) async throws {
        _ = try await send(try makeRequest("DELETE", "/api/skills/\(id.pathSegment)"))
    }

    /// GET /api/skills/:id/files/<path> (text files only).
    nonisolated func skillFile(skillId: String, path: String) async throws -> SkillFileContent {
        let segments = path.split(separator: "/").map { String($0).pathSegment }.joined(separator: "/")
        return try await get("/api/skills/\(skillId.pathSegment)/files/\(segments)")
    }

    /// GET /api/skills/:id/export: the folder as a zip (for the share sheet).
    nonisolated func exportSkill(id: String) async throws -> Data {
        var request = try makeRequest("GET", "/api/skills/\(id.pathSegment)/export")
        request.setValue("application/zip", forHTTPHeaderField: "Accept")
        return try await send(request)
    }

    nonisolated func previewGitHubSkills(url: String) async throws -> SkillImportPreview {
        try await get("/api/skills/github/preview", query: [URLQueryItem(name: "url", value: url)], timeout: 60)
    }

    /// POST /api/skills/zip/preview (multipart "file", at most 20 MB).
    nonisolated func previewZipSkills(fileName: String, data: Data) async throws -> SkillImportPreview {
        guard data.count <= 20 * 1024 * 1024 else { throw APIError.tooLarge }
        let form = MultipartForm()
        var request = try makeRequest("POST", "/api/skills/zip/preview")
        request.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 120
        request.httpBody = form.body(field: "file", fileName: fileName, mime: "application/zip", data: data)
        return try decode(SkillImportPreview.self, from: try await send(request))
    }

    nonisolated func importSkills(_ body: SkillImportRequest) async throws -> [Skill] {
        let list: SkillList = try await call("POST", "/api/skills/import", json: body)
        return list.skills
    }

    // MARK: - Custom connectors

    nonisolated func customConnectors() async throws -> [CustomConnector] {
        let list: CustomConnectorList = try await get("/api/custom-connectors")
        return list.connectors
    }

    nonisolated func createCustomConnector(_ body: CreateCustomConnectorRequest) async throws -> CustomConnector {
        let response: CustomConnectorResponse = try await call("POST", "/api/custom-connectors", json: body)
        return response.connector
    }

    nonisolated func updateCustomConnector(id: String, _ body: UpdateCustomConnectorRequest) async throws -> CustomConnector {
        let response: CustomConnectorResponse = try await call("PATCH", "/api/custom-connectors/\(id.pathSegment)", json: body)
        return response.connector
    }

    nonisolated func testCustomConnector(id: String) async throws -> CustomConnector {
        let data = try await send(try makeRequest("POST", "/api/custom-connectors/\(id.pathSegment)/test"))
        return try decode(CustomConnectorResponse.self, from: data).connector
    }

    nonisolated func setCustomConnectorPolicy(id: String, _ body: UpdatePolicyRequest) async throws -> CustomConnector {
        let response: CustomConnectorResponse = try await call("PUT", "/api/custom-connectors/\(id.pathSegment)/policy", json: body)
        return response.connector
    }

    nonisolated func deleteCustomConnector(id: String) async throws {
        _ = try await send(try makeRequest("DELETE", "/api/custom-connectors/\(id.pathSegment)"))
    }

    /// POST /api/messages/:id/connect: a connection_request card's values (straight to the vault).
    nonisolated func submitConnection(messageId: String, _ body: ConnectRequestSubmit) async throws -> Message {
        let response: MessageActionResponse = try await call("POST", "/api/messages/\(messageId.pathSegment)/connect", json: body)
        return response.message
    }
}
