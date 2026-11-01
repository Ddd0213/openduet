// Voice call routes (.pi/handoff/m13-contract.md): start (or resume) a call, its transcript, the
// voice's tool calls, the end, the whole conversation, and the voice settings. Every call route
// answers no-store. A start without a usable realtime model is 400 not_configured; an open call on
// another channel is 409 conflict. The answer of a start holds the provider credential: it stays in
// memory only (the engine), and nothing here logs bodies.
import Foundation

extension APIClient {
    // MARK: - Calls

    /// POST /api/calls (again with callId to reconnect the same call: a fresh credential).
    nonisolated func startCall(_ body: StartCallRequest) async throws -> StartCallResponse {
        var request = try makeRequest("POST", "/api/calls", json: body)
        // The server mints a Gemini token with the provider first.
        request.timeoutInterval = 30
        return try decode(StartCallResponse.self, from: try await send(request))
    }

    /// POST /api/calls/:id/lines (204); 409 once the call has ended.
    nonisolated func sendCallLines(callId: String, _ lines: [CallLine]) async throws {
        _ = try await send(try makeRequest("POST", "/api/calls/\(callId.pathSegment)/lines", json: CallLinesRequest(lines: lines)))
    }

    /// POST /api/calls/:id/tool: one of the voice's tool calls, with the lines not sent yet.
    nonisolated func callTool(callId: String, _ body: CallToolRequest) async throws -> CallToolResponse {
        var request = try makeRequest("POST", "/api/calls/\(callId.pathSegment)/tool", json: body)
        request.timeoutInterval = 30
        return try decode(CallToolResponse.self, from: try await send(request))
    }

    /// POST /api/calls/:id/end: the call's line in the chat (a second end answers the same message).
    nonisolated func endCall(callId: String, _ body: EndCallRequest) async throws -> Message {
        var request = try makeRequest("POST", "/api/calls/\(callId.pathSegment)/end", json: body)
        // The server names the call with a utility model before it answers.
        request.timeoutInterval = 30
        return try decode(MessageActionResponse.self, from: try await send(request)).message
    }

    /// GET /api/calls/:id: the transcript and what the call handed to the assistant.
    nonisolated func callDetail(id: String) async throws -> CallDetail {
        try await get("/api/calls/\(id.pathSegment)")
    }

    // MARK: - Voice settings

    nonisolated func voiceSettings() async throws -> VoiceSettings { try await get("/api/voice-settings") }

    /// PUT /api/voice-settings (400 when the model isn't a usable realtime one or the voice isn't the engine's).
    nonisolated func updateVoiceSettings(_ body: UpdateVoiceSettingsRequest) async throws -> VoiceSettings {
        try await call("PUT", "/api/voice-settings", json: body)
    }
}
