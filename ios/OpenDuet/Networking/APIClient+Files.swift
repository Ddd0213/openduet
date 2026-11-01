// Uploads with progress (L179) and the signed-in loader for images and files (L172, L186).
import Foundation

extension APIClient {
    /// POST /api/channels/:id/files (multipart "file", at most 25 MB); progress is 0...1.
    nonisolated func upload(channelId: String, file: PickedFile, onProgress: @escaping @Sendable (Double) -> Void) async throws -> ChannelFile {
        guard file.data.count <= UploadFileResponse.maxUploadBytes else { throw APIError.tooLarge }
        let form = MultipartForm()
        var request = try makeRequest("POST", "/api/channels/\(channelId.pathSegment)/files")
        request.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 120
        let body = form.body(field: "file", fileName: file.name, mime: file.mime, data: file.data)
        let delegate = UploadProgressDelegate(onProgress: onProgress)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await HTTPSessions.api.upload(for: request, from: body, delegate: delegate)
        } catch {
            throw APIError.transport(error)
        }
        try check(response, body: data)
        return try decode(UploadFileResponse.self, from: data).file
    }
}

extension APIClient {
    /// GET /api/channels/:id/files (newest first): the channel sheet's and profile's Files lists.
    nonisolated func channelFiles(channelId: String) async throws -> [ChannelFile] {
        let list: ChannelFileList = try await get("/api/channels/\(channelId.pathSegment)/files")
        return list.files
    }

    /// GET /api/files/:id/content with its headers, for a file the app knows only by id (a
    /// duet://files/<id> link): the real type and the file name from Content-Disposition.
    nonisolated func fileContent(id: String) async throws -> (data: Data, mime: String?, name: String?) {
        var request = try makeRequest("GET", "/api/files/\(id.pathSegment)/content")
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await HTTPSessions.files.data(for: request)
        } catch {
            throw APIError.transport(error)
        }
        try check(response, body: data)
        let http = response as? HTTPURLResponse
        return (data, http?.mimeType, FileNaming.dispositionName(http?.value(forHTTPHeaderField: "Content-Disposition")))
    }
}

extension APIClient: AuthenticatedLoading {
    /// Bytes of a server path (ChannelFile.url ...) through the signed-in session: kept in memory
    /// for the session and, for /api/files/<id>/content (immutable per id), on disk.
    func data(for path: String) async throws -> Data {
        let key = path as NSString
        if let hit = memoryCache.object(forKey: key) { return hit as Data }
        if let running = inFlight[path] { return try await running.value }
        let task = Task { try await self.fetch(path) }
        inFlight[path] = task
        defer { inFlight[path] = nil }
        let data = try await task.value
        memoryCache.setObject(data as NSData, forKey: key, cost: data.count)
        return data
    }

    private nonisolated func fetch(_ path: String) async throws -> Data {
        var request = try makeRequest("GET", path)
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        let immutable = path.hasPrefix("/api/files/")
        if immutable, let cached = HTTPSessions.fileCache.cachedResponse(for: request) { return cached.data }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await HTTPSessions.files.data(for: request)
        } catch {
            throw APIError.transport(error)
        }
        try check(response, body: data)
        if immutable {
            HTTPSessions.fileCache.storeCachedResponse(CachedURLResponse(response: response, data: data), for: request)
        }
        return data
    }
}
