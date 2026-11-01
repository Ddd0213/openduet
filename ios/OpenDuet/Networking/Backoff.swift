// Reconnect timing for the event stream (prompt L184): 1, 2, 4, 8, 16, then 30 s at most,
// back to 1 s once a connection opens. Foundation only (host tests).
import Foundation

struct Backoff: Sendable {
    var base: Double = 1
    var cap: Double = 30
    private(set) var attempt = 0

    init(base: Double = 1, cap: Double = 30) {
        self.base = base
        self.cap = cap
    }

    /// The wait before the next reconnect, in seconds; each call doubles the following one.
    mutating func nextDelay() -> Double {
        let delay = min(cap, base * pow(2, Double(attempt)))
        attempt = min(attempt + 1, 30)
        return delay
    }

    mutating func reset() { attempt = 0 }
}

enum StreamTiming {
    /// No byte at all for this long (the server pings every ~20 s) means the connection is dead.
    static let heartbeatTimeout: Double = 45
    /// After a reconnect, the replay through Last-Event-ID gets a moment to echo messages the
    /// server already has before the offline queue sends anything again.
    static let replayGrace: Double = 0.5
}
