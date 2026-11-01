// The M8 run record routes (contract §1): GET /api/runs (newest first, paged with ?before=) and
// GET /api/runs/:id (the steps, oldest first). Only the signed-in user's runs; 404 otherwise.
import Foundation

extension APIClient {
    /// GET /api/runs?taskId=<id> | ?channelId=<id> (neither = every run) &before=<runId>&limit=30
    nonisolated func runs(_ scope: RunScope, before: String?, limit: Int = RunsBoard.pageSize) async throws -> RunList {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        switch scope {
        case .all: break
        case .task(let id): query.append(URLQueryItem(name: "taskId", value: id))
        case .channel(let id): query.append(URLQueryItem(name: "channelId", value: id))
        }
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        return try await get("/api/runs", query: query)
    }

    nonisolated func run(id: String) async throws -> RunDetail {
        try await get("/api/runs/\(id.pathSegment)")
    }
}
