// The M3 JSON routes (docs/API.md "Routes"): tasks, the task's own session, Up next, approval
// decisions and card actions. POST /api/tasks/:id/messages (SSE) is in APIClient+Stream.
// Approve answers 409 stale_version / 410 expired as APIError.staleVersion / .expired.
import Foundation

extension APIClient {
    // MARK: - Tasks

    /// GET /api/tasks?channelId=<id>; nil = Everything (the server leaves out archived tasks).
    /// M22: unfinished tasks plus those resolved in the last 7 days, with `olderResolved`.
    nonisolated func tasks(channelId: String?) async throws -> TaskList {
        try await get("/api/tasks", query: Self.scope(channelId))
    }

    /// M22: GET /api/tasks?resolved=older[&cursor=]: the resolved tasks older than the 7-day
    /// window, newest first; `nextCursor` nil on the last page.
    nonisolated func olderResolvedTasks(channelId: String?, cursor: String?) async throws -> TaskList {
        var query = [URLQueryItem(name: "resolved", value: "older")]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await get("/api/tasks", query: query + Self.scope(channelId))
    }

    /// M22: GET /api/tasks?q=: every unarchived task whose title or prompt has the text, any age.
    nonisolated func searchTasks(_ text: String, channelId: String?) async throws -> [TaskSummary] {
        let list: TaskList = try await get("/api/tasks", query: [URLQueryItem(name: "q", value: text)] + Self.scope(channelId))
        return list.tasks
    }

    /// M22: POST /api/tasks/:id/retry (a failed run again; 409 not_retryable / task_running).
    nonisolated func retryTask(id: String) async throws -> TaskDetail {
        try decode(TaskDetail.self, from: try await send(try makeRequest("POST", "/api/tasks/\(id.pathSegment)/retry")))
    }

    /// M22: POST /api/tasks/:id/reopen (a resolved task back to needs_input; 409 not_resolved).
    nonisolated func reopenTask(id: String) async throws -> TaskDetail {
        try decode(TaskDetail.self, from: try await send(try makeRequest("POST", "/api/tasks/\(id.pathSegment)/reopen")))
    }

    /// M22: GET /api/needs-you: everything waiting on the user (`count` is the Tasks tab badge).
    nonisolated func needsYou() async throws -> NeedsYou {
        try await get("/api/needs-you")
    }

    private nonisolated static func scope(_ channelId: String?) -> [URLQueryItem] {
        channelId.map { [URLQueryItem(name: "channelId", value: $0)] } ?? []
    }

    /// POST /api/tasks (the + FAB sheet's Start).
    nonisolated func createTask(_ body: CreateTaskRequest) async throws -> TaskDetail {
        try await call("POST", "/api/tasks", json: body)
    }

    nonisolated func task(id: String) async throws -> TaskDetail {
        try await get("/api/tasks/\(id.pathSegment)")
    }

    /// PATCH /api/tasks/:id: Mark complete (status resolved) or Archive.
    nonisolated func updateTask(id: String, _ body: UpdateTaskRequest) async throws -> TaskDetail {
        try await call("PATCH", "/api/tasks/\(id.pathSegment)", json: body)
    }

    /// M9: PATCH /api/tasks/:id for Pin / Unpin and a routine's Pause / Resume / time / title.
    /// docs/API.md answers the TaskDetail; the M9 contract comment says `{ task: TaskSummary }`,
    /// so both shapes are accepted.
    nonisolated func patchTask(id: String, _ body: UpdateTaskRequest) async throws -> TaskPatchAnswer {
        let data = try await send(try makeRequest("PATCH", "/api/tasks/\(id.pathSegment)", json: body))
        if let detail = try? JSONCoding.decoder().decode(TaskDetail.self, from: data) { return TaskPatchAnswer(detail: detail) }
        return TaskPatchAnswer(summary: try decode(TaskEnvelope.self, from: data).task)
    }

    /// M10: POST /api/channels/:id/stop: cancels this channel's own chat turns (not its tasks).
    /// 409 conflict (APIError.server(status: 409, ...)) means nothing was running any more.
    nonisolated func stopChannel(id: String) async throws -> StopResponse {
        let data = try await send(try makeRequest("POST", "/api/channels/\(id.pathSegment)/stop"))
        return try decode(StopResponse.self, from: data)
    }

    /// M10: POST /api/tasks/:id/stop: cancels the task session's running or queued turns (409 when idle).
    nonisolated func stopTask(id: String) async throws -> StopResponse {
        let data = try await send(try makeRequest("POST", "/api/tasks/\(id.pathSegment)/stop"))
        return try decode(StopResponse.self, from: data)
    }

    /// M9: DELETE /api/tasks/:id (204); task_deleted follows as an event.
    nonisolated func deleteTask(id: String) async throws {
        _ = try await send(try makeRequest("DELETE", "/api/tasks/\(id.pathSegment)"))
    }

    /// M9: GET /api/tasks/:id/runs: a routine's run history, newest first.
    nonisolated func routineRuns(taskId: String) async throws -> [RunRecord] {
        let list: RoutineRuns = try await get("/api/tasks/\(taskId.pathSegment)/runs")
        return list.runs
    }

    /// M9: POST /api/tasks/:id/run: a routine's Run now (409 while one is running).
    nonisolated func runRoutine(taskId: String) async throws -> RunRecord {
        let data = try await send(try makeRequest("POST", "/api/tasks/\(taskId.pathSegment)/run"))
        return try decode(RunNowResponse.self, from: data).run
    }

    /// GET /api/tasks/:id/messages: the task's own session, paged like a channel (oldest first).
    nonisolated func taskMessages(taskId: String, before: String?, limit: Int = 50) async throws -> MessagePage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.insert(URLQueryItem(name: "before", value: before), at: 0) }
        return try await get("/api/tasks/\(taskId.pathSegment)/messages", query: query)
    }

    // MARK: - Up next

    nonisolated func upNext() async throws -> UpNext {
        try await get("/api/up-next")
    }

    /// POST /api/up-next/:id/add -> the new task.
    nonisolated func addSuggestion(id: String) async throws -> TaskSummary {
        let data = try await send(try makeRequest("POST", "/api/up-next/\(id.pathSegment)/add"))
        return try decode(AddSuggestionResponse.self, from: data).task
    }

    /// M22: POST /api/up-next (the + sheet's "Save for Up next", same body as Start) -> 201 the kept
    /// suggestion.
    nonisolated func saveForLater(_ body: CreateTaskRequest) async throws -> Suggestion {
        let response: SaveForLaterResponse = try await call("POST", "/api/up-next", json: body)
        return response.suggestion
    }

    /// POST /api/up-next/:id/hide (204).
    nonisolated func hideSuggestion(id: String) async throws {
        _ = try await send(try makeRequest("POST", "/api/up-next/\(id.pathSegment)/hide"))
    }

    // MARK: - Cards

    /// POST /api/approvals/:id/approve with the version the card showed. Throws
    /// APIError.staleVersion (409) when the card changed and .expired (410) when it ran out.
    /// M20: `always` also stores an Always rule for the card's `always` scope (one recipient, or
    /// one site and kind of click); only sent when true.
    nonisolated func approve(approvalId: String, version: Int, always: Bool = false) async throws -> Approval {
        let body = ApprovalDecisionRequest(version: version, always: always ? true : nil)
        let response: ApprovalDecisionResponse = try await call(
            "POST", "/api/approvals/\(approvalId.pathSegment)/approve", json: body
        )
        return response.approval
    }

    /// POST /api/approvals/:id/decline (the server also accepts a stale version and answers the latest).
    nonisolated func decline(approvalId: String, version: Int) async throws -> Approval {
        let response: ApprovalDecisionResponse = try await call(
            "POST", "/api/approvals/\(approvalId.pathSegment)/decline", json: ApprovalDecisionRequest(version: version)
        )
        return response.approval
    }

    /// POST /api/messages/:id/action (suggestion Start / Hide, plate item Done) -> the updated card.
    nonisolated func messageAction(messageId: String, _ body: MessageActionRequest) async throws -> Message {
        let response: MessageActionResponse = try await call("POST", "/api/messages/\(messageId.pathSegment)/action", json: body)
        return response.message
    }

    // MARK: - Helpers

    /// A JSON request whose 2xx body decodes as T.
    nonisolated func call<T: Decodable & Sendable>(_ method: String, _ path: String, json body: some Encodable) async throws -> T {
        try decode(T.self, from: try await send(try makeRequest(method, path, json: body)))
    }
}
