// The provider's WebSocket on the phone (URLSessionWebSocketTask). The request comes from the
// codec with the credential already in it (Gemini: ?access_token=, StepFun: Authorization:
// Bearer); it goes straight to URLSession and is never logged or kept here. An ephemeral session:
// no cookies, cache or credentials on disk.
import Foundation

@MainActor
final class URLSessionLiveSocket: LiveSocket {
    private let session: URLSession
    private let task: URLSessionWebSocketTask

    init(_ request: URLRequest) {
        let configuration = URLSessionConfiguration.ephemeral
        // A quiet minute on a live call isn't a timeout; the provider closes idle sessions itself.
        configuration.timeoutIntervalForRequest = 600
        configuration.waitsForConnectivity = false
        session = URLSession(configuration: configuration)
        task = session.webSocketTask(with: request)
        // Gemini's setup and replies can be large (audio in base64).
        task.maximumMessageSize = 16 << 20
        task.resume()
    }

    func send(_ text: String) {
        task.send(.string(text)) { _ in
            // A failed send shows up as the socket closing (receive throws).
        }
    }

    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let text):
            return text
        case .data(let data):
            // Gemini Live sends its JSON as binary frames.
            return String(decoding: data, as: UTF8.self)
        @unknown default:
            return ""
        }
    }

    func ping(_ pong: @escaping @MainActor () -> Void) {
        task.sendPing { error in
            guard error == nil else { return }
            Task { @MainActor in pong() }
        }
    }

    func close() {
        task.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }

    var closeCode: Int { task.closeCode == .invalid ? 0 : task.closeCode.rawValue }

    var closeReason: String {
        task.closeReason.map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
}
