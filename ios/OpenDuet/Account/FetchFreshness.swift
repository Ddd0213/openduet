// M19: when a sheet that loads on appear fetches a part again. The settings (the profile sheet)
// load the user, the connectors, the models / skills / custom connectors and the voice settings
// every time they appear; reopened within `window` seconds, a part that loaded is not fetched
// again (a part that is missing or failed always is). Pages keep their own pull to refresh.
// Foundation only, so the Mac host tests drive it.
import Foundation

struct FetchFreshness: Sendable {
    /// How long a fetched part counts as fresh.
    var window: TimeInterval = 60
    private var fetchedAt: [String: Date] = [:]

    init(window: TimeInterval = 60) {
        self.window = window
    }

    /// Whether `key` should be fetched now; when it should, the fetch is noted at `now`.
    /// `loaded` = the part is on screen without a failure (otherwise it is always fetched).
    mutating func claim(_ key: String, loaded: Bool, now: Date = .now) -> Bool {
        if loaded, let last = fetchedAt[key], now.timeIntervalSince(last) >= 0, now.timeIntervalSince(last) < window {
            return false
        }
        fetchedAt[key] = now
        return true
    }

    /// Forget a part (its next appear fetches it).
    mutating func reset(_ key: String) {
        fetchedAt[key] = nil
    }
}
