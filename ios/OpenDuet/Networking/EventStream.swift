// The live GET /api/events connection (prompt L73, L184): resumes with Last-Event-ID (stored
// per server + user), reconnects with backoff 1, 2, 4 ... 30 s, and reconnects when no byte
// has arrived for 45 s (heartbeat watchdog; the server pings every ~20 s). The owner runs it
// only while the app is in the foreground. M21: a `resync` (too much to replay) moves the cursor
// to its id and the same connection goes on; the owner reloads what it shows (ChatStore.resync).
import Foundation

@MainActor
final class EventStream {
    enum Signal {
        /// Connected (again): the server is reachable and the replay is on its way.
        case live
        case event(DuetEvent)
        /// The connection failed or went silent; a reconnect is scheduled.
        case lost
    }

    private let client: APIClient
    private let cursor: EventCursor
    private let onSignal: (Signal) -> Void
    private var task: Task<Void, Never>?
    private var backoff = Backoff()
    private var lastActivity = ContinuousClock.now
    private(set) var isConnected = false

    init(client: APIClient, cursor: EventCursor, onSignal: @escaping (Signal) -> Void) {
        self.client = client
        self.cursor = cursor
        self.onSignal = onSignal
    }

    var isRunning: Bool { task != nil }

    func start() {
        guard task == nil else { return }
        task = Task { await run() }
    }

    func stop() {
        task?.cancel()
        task = nil
        isConnected = false
    }

    /// A request just failed to reach the server: drop the connection and retry now (with backoff
    /// from here on), unless a reconnect is already pending.
    func reconnect() {
        guard isConnected else { return }
        stop()
        start()
    }

    private func run() async {
        while !Task.isCancelled {
            var failed = false
            do {
                try await consume(client.events(after: cursor.value))
            } catch is CancellationError {
                return
            } catch APIError.unauthorized {
                // The session expired; SessionStore returns to sign-in.
                return
            } catch {
                failed = true
            }
            if Task.isCancelled { return }
            isConnected = false
            // A clean close (server restart) retries quietly; a failure shows the offline bar.
            if failed { onSignal(.lost) }
            let delay = backoff.nextDelay()
            try? await Task.sleep(for: .seconds(failed ? delay : min(delay, 1)))
        }
    }

    private struct SilentConnection: Error {}

    /// Reads one connection until it ends, failing it after 45 s without a byte.
    private func consume(_ stream: AsyncThrowingStream<APIClient.StreamItem, any Error>) async throws {
        lastActivity = .now
        try await withThrowingTaskGroup(of: Void.self) { group in
            // Child tasks aren't main-actor-isolated (a SIL "sending" error in the full build);
            // they hop back to the main actor for every item and for the silence check.
            group.addTask { [weak self] in
                for try await item in stream {
                    await self?.handle(item)
                }
            }
            group.addTask { [weak self] in
                while true {
                    try await Task.sleep(for: .seconds(5))
                    guard let self else { return }
                    if await self.isSilent { throw SilentConnection() }
                }
            }
            defer { group.cancelAll() }
            _ = try await group.next()
        }
    }

    private var isSilent: Bool {
        ContinuousClock.now - lastActivity > .seconds(StreamTiming.heartbeatTimeout)
    }

    private func handle(_ item: APIClient.StreamItem) {
        lastActivity = .now
        switch item {
        case .opened:
            backoff.reset()
            isConnected = true
            onSignal(.live)
        case .activity:
            break
        case .event(let event):
            // M21: a `resync`'s id is the server's newest event, the Last-Event-ID from here on,
            // even when it is lower than the stored one (a server restored from a backup).
            if case .resync = event.body { cursor.reset(to: event.id) } else { cursor.advance(to: event.id) }
            onSignal(.event(event))
        }
    }
}

/// The last event id this app has seen on GET /api/events, kept per server + user in
/// UserDefaults so a relaunch resumes the stream where it stopped (Last-Event-ID).
struct EventCursor: Sendable {
    let key: String

    init(server: ServerAddress, userId: String) {
        key = "events.lastId.\(server.string)|\(userId)"
    }

    var value: Int64? {
        let stored = UserDefaults.standard.object(forKey: key) as? NSNumber
        return stored?.int64Value
    }

    func advance(to id: Int64) {
        if let current = value, current >= id { return }
        UserDefaults.standard.set(NSNumber(value: id), forKey: key)
    }

    /// M21 resync: the server says where to go on from, forward or back.
    func reset(to id: Int64) {
        UserDefaults.standard.set(NSNumber(value: id), forKey: key)
    }

    func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}
