// Non-secret session state in UserDefaults: the server address (kept after sign-out to
// prefill sign-in), the signed-in user's JSON for offline launches, the "finished onboarding on
// this device" marker per server + user (M4: the server's onboardedAt decides; the marker only
// covers a POST /api/onboarding/complete that hasn't gone through yet, see OnboardingGate) and
// the registered push device id.
import Foundation

enum SessionDefaults {
    private static let serverKey = "session.server"
    private static let userKey = "session.user"

    static var server: ServerAddress? {
        get {
            guard let string = UserDefaults.standard.string(forKey: serverKey) else { return nil }
            return try? ServerAddress.parse(string).get()
        }
        set { UserDefaults.standard.set(newValue?.string, forKey: serverKey) }
    }

    /// The raw /api/me JSON of the signed-in user (no token).
    static func cacheUser(_ json: Data) {
        UserDefaults.standard.set(json, forKey: userKey)
    }

    static var cachedUser: CurrentUser? {
        guard let data = UserDefaults.standard.data(forKey: userKey) else { return nil }
        return try? JSONCoding.decoder().decode(CurrentUser.self, from: data)
    }

    static func clearUser() {
        UserDefaults.standard.removeObject(forKey: userKey)
    }

    static func hasSeenOnboarding(server: ServerAddress, userId: String) -> Bool {
        UserDefaults.standard.bool(forKey: onboardingKey(server, userId))
    }

    static func markOnboardingSeen(server: ServerAddress, userId: String) {
        UserDefaults.standard.set(true, forKey: onboardingKey(server, userId))
    }

    private static func onboardingKey(_ server: ServerAddress, _ userId: String) -> String {
        "onboarding.seen.\(server.string)|\(userId)"
    }

    // MARK: - Remote push (M4)

    /// The id POST /api/devices returned for this iPhone (DELETE /api/devices/:id on sign-out).
    static func deviceId(server: ServerAddress, userId: String) -> String? {
        UserDefaults.standard.string(forKey: deviceKey(server, userId))
    }

    static func setDeviceId(_ id: String?, server: ServerAddress, userId: String) {
        UserDefaults.standard.set(id, forKey: deviceKey(server, userId))
    }

    private static func deviceKey(_ server: ServerAddress, _ userId: String) -> String {
        "push.deviceId.\(server.string)|\(userId)"
    }
}
