// The app's CallSession over the signed-in APIClient: the call routes, the real engines (picked by
// the start answer's engine) and the microphone permission. ShellHost makes one per session.
import AVFoundation
import Foundation

/// The call routes through the signed-in client (it keeps no answers, so no credential either).
struct CallBackendClient: CallBackend {
    let client: APIClient

    func startCall(_ body: StartCallRequest) async throws -> StartCallResponse { try await client.startCall(body) }
    func sendCallLines(callId: String, _ lines: [CallLine]) async throws { try await client.sendCallLines(callId: callId, lines) }
    func callTool(callId: String, _ body: CallToolRequest) async throws -> CallToolResponse { try await client.callTool(callId: callId, body) }
    func endCall(callId: String, _ body: EndCallRequest) async throws -> Message { try await client.endCall(callId: callId, body) }
}

extension CallSession {
    static func live(client: APIClient) -> CallSession {
        let backend = CallBackendClient(client: client)
        return CallSession(backend: backend, language: phoneLanguage, permission: microphonePermission) { engine in
            switch engine {
            case .gemini: GeminiLiveEngine(backend: backend)
            case .stepfun: StepRealtimeEngine(backend: backend)
            }
        }
    }

    /// The language the app shows ("zh-Hans", "en"), so the voice can greet in it.
    private static var phoneLanguage: String? {
        Bundle.main.preferredLocalizations.first.map { String($0.prefix(16)) }
    }

    /// Asks once; afterwards answers what Settings says.
    private static func microphonePermission() async -> MicPermission {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        default: return await AVAudioApplication.requestRecordPermission() ? .granted : .denied
        }
    }
}
