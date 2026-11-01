// M25 routes (docs/API.md "M25"): Upload a skill's preview (a .zip, a .skill or a SKILL.md; the
// server decides by the bytes) and the built-in connectors list. 400 validation_failed and 413
// too_large come back as APIError like everywhere else.
import Foundation

extension APIClient {
    /// POST /api/skills/upload/preview (multipart "file" with the file's own name, at most 20 MB).
    /// Then POST /api/skills/import as for GitHub.
    nonisolated func previewUploadedSkills(fileName: String, mime: String, data: Data) async throws -> SkillImportPreview {
        guard data.count <= SkillUpload.maxBytes else { throw APIError.tooLarge }
        let form = MultipartForm()
        var request = try makeRequest("POST", "/api/skills/upload/preview")
        request.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 120
        request.httpBody = form.body(field: "file", fileName: fileName, mime: mime, data: data)
        return try decode(SkillImportPreview.self, from: try await send(request))
    }

    /// GET /api/builtin-connectors: all of them in the server's order, off ones included.
    nonisolated func builtinConnectors() async throws -> [BuiltinConnector] {
        let list: BuiltinConnectorList = try await get("/api/builtin-connectors")
        return list.connectors
    }
}
