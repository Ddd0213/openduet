// The live screen and input of the assistant's computer (prompt L143): a WebSocket to
// /api/computer/stream that the backend proxies to the computer's /stream and /control/*.
// Binary frames are JPEG screen frames; text frames are ComputerServerMessage JSON; the app
// sends ComputerClientMessage text frames while the user is in control. It reconnects with
// Backoff until stopped, and pings every 20 s so a dead connection is noticed. M28: a socket the
// server closed with 4001 (the session was signed out) or whose upgrade was 401 isn't retried; one
// authorized request follows instead, and its 401 signs the app out (ComputerStreamEnd).
import Foundation
import OSLog

@MainActor
final class ComputerStream {
    enum Signal: Sendable {
        /// the first message arrived on a new connection
        case open
        case frame(Data)
        case message(ComputerServerMessage)
        /// the connection dropped; a retry follows after a backoff (M28: not after 4001 or a 401
        /// upgrade whose check was refused: then this is the last signal)
        case closed
    }

    private let request: URLRequest
    private let onSignal: (Signal) -> Void
    private var task: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var backoff = Backoff()

    nonisolated private static let log = Logger(subsystem: "dev.openduet.OpenDuet", category: "computer")

    /// Its own session: no cookies, and an idle timeout longer than the 20 s ping.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 60
        return URLSession(configuration: config)
    }()

    init(request: URLRequest, onSignal: @escaping (Signal) -> Void) {
        self.request = request
        self.onSignal = onSignal
    }

    var isRunning: Bool { task != nil }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in await self?.run() }
    }

    func stop() {
        task?.cancel()
        task = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    /// One input event for the browser; dropped while disconnected (the user sees the screen
    /// isn't live and retries).
    func send(_ message: ComputerClientMessage) {
        guard let socket, let data = try? JSONEncoder().encode(message), let text = String(data: data, encoding: .utf8) else { return }
        socket.send(.string(text)) { error in
            if let error { Self.log.info("Computer input not sent: \(error.localizedDescription, privacy: .public)") }
        }
    }

    private func run() async {
        while !Task.isCancelled {
            let socket = Self.session.webSocketTask(with: request)
            socket.maximumMessageSize = 8 << 20
            self.socket = socket
            socket.resume()
            let pinger = Task { [weak socket] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(20))
                    guard !Task.isCancelled, let socket else { return }
                    socket.sendPing { error in if error != nil { socket.cancel(with: .goingAway, reason: nil) } }
                }
            }
            var opened = false
            do {
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    if !opened {
                        opened = true
                        backoff.reset()
                        onSignal(.open)
                    }
                    switch message {
                    case .data(let data):
                        onSignal(.frame(data))
                    case .string(let text):
                        if let decoded = try? JSONCoding.decoder().decode(ComputerServerMessage.self, from: Data(text.utf8)) {
                            onSignal(.message(decoded))
                        }
                    @unknown default:
                        break
                    }
                }
            } catch {
                Self.log.info("Computer stream closed: \(error.localizedDescription, privacy: .public)")
            }
            // M28: read before our own cancel below: the server's close code (4001 = the session
            // was signed out or expired) and the upgrade's status (401 on a server that refused it).
            let end = ComputerStreamEnd.after(
                closeCode: socket.closeCode.rawValue,
                upgradeStatus: (socket.response as? HTTPURLResponse)?.statusCode
            )
            pinger.cancel()
            socket.cancel(with: .goingAway, reason: nil)
            if self.socket === socket { self.socket = nil }
            guard !Task.isCancelled else { return }
            onSignal(.closed)
            if end == .checkSession {
                // No reconnect: one authorized request, whose 401 signs the app out as usual.
                let refused = await Self.sessionRefused(request)
                guard !Task.isCancelled else { return }
                if !ComputerStreamEnd.reconnects(afterCheckRefused: refused) {
                    task = nil
                    return
                }
            }
            try? await Task.sleep(for: .seconds(backoff.nextDelay()))
        }
    }

    /// M28: GET /api/me through the signed-in session's client (the one this stream's token belongs
    /// to), so its 401 runs `onUnauthorized` and the app goes back to sign-in. True when the server
    /// refused the session; false when it is still good or the server couldn't be reached. No client
    /// for this token (the app already signed out or in again): refused, nothing to do.
    private static func sessionRefused(_ request: URLRequest) async -> Bool {
        let bearer = request.value(forHTTPHeaderField: "Authorization")
        guard let client = NotificationsCoordinator.shared.session?.client,
              let token = client.token, bearer == "Bearer \(token)" else { return true }
        do {
            _ = try await client.me(timeout: 15)
            return false
        } catch APIError.unauthorized {
            return true
        } catch {
            return false
        }
    }
}
