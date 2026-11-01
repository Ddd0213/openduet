// M26 (docs/API.md "DELETE /api/files/:id"): deleting any of the user's files, sent or not,
// optionally with its original in /workspace. The composer's "remove an upload before sending"
// keeps its old call (APIClient+Routes.deleteFile(id:)).
import Foundation

extension APIClient {
    /// DELETE /api/files/:id, with `?alsoWorkspace=true` only when asked (FileDeleteRules.query).
    /// nil: an empty answer (a server before M26: 204) or one that doesn't decode; both still
    /// count as deleted. A 404 is thrown as APIError.notFound (the caller takes it as gone). The
    /// bytes this device kept of the file go once it is gone.
    nonisolated func deleteFile(id: String, alsoWorkspace: Bool) async throws -> DeleteFileResponse? {
        let request = try makeRequest("DELETE", "/api/files/\(id.pathSegment)", query: FileDeleteRules.query(alsoWorkspace: alsoWorkspace))
        let data: Data
        do {
            data = try await send(request)
        } catch let error as APIError where error == .notFound {
            await forgetFile(id: id)
            throw error
        }
        await forgetFile(id: id)
        guard !data.isEmpty else { return nil }
        return try? decode(DeleteFileResponse.self, from: data)
    }

    /// The copies of a deleted file's bytes (memory, and the disk cache of /api/files/<id>/content).
    private func forgetFile(id: String) {
        let path = "/api/files/\(id.pathSegment)/content"
        memoryCache.removeObject(forKey: path as NSString)
        if let request = try? makeRequest("GET", path) {
            HTTPSessions.fileCache.removeCachedResponse(for: request)
        }
    }
}
