// M27 the composer microphone's settings (VoiceSettings.dictation), shared by the composers and the
// settings' Voice page: the page's answers come in through `take` (the profile cache's
// VoiceSettingsModel), and a composer loads GET /api/voice-settings itself when it has nothing
// recent for its server. The last answer per server is kept on the phone (not secret: the engine,
// the on-device switch, whether cloud is ready), so dictation works offline as the user set it.
import Foundation
import Observation

@MainActor @Observable
final class DictationSettingsStore {
    static let shared = DictationSettingsStore()

    /// The settings for `owner` (nil: none known yet for this client).
    private(set) var settings: DictationSettings?
    @ObservationIgnored private var owner: ObjectIdentifier?
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var loading: Task<Void, Never>?

    /// A composer reloads what's older than this when it appears.
    static let freshFor: TimeInterval = 5 * 60

    private init() {}

    /// A fresh answer of GET / PUT /api/voice-settings for this client.
    func take(_ dictation: DictationSettings, for api: APIClient) {
        adopt(api)
        settings = dictation
        fetchedAt = Date()
        Self.remember(dictation, server: api.server)
    }

    /// The settings to dictate with now: what's known for this client, else one load, else the
    /// last ones kept on the phone for its server, else Apple's recognizer (as before M27).
    func current(for api: APIClient?) async -> DictationSettings {
        guard let api else { return settings ?? .standard }
        adopt(api)
        if let settings { return settings }
        await refresh(api, force: true)
        return settings ?? Self.remembered(server: api.server) ?? .standard
    }

    /// Loads again when nothing recent is known (`force`: whatever its age).
    func refresh(_ api: APIClient?, force: Bool = false) async {
        guard let api else { return }
        adopt(api)
        if !force, let fetchedAt, Date().timeIntervalSince(fetchedAt) < Self.freshFor, settings != nil { return }
        if let loading {
            await loading.value
            return
        }
        let task = Task { @MainActor in
            if let answer = try? await api.voiceSettings() { self.take(answer.dictation, for: api) }
        }
        loading = task
        await task.value
        loading = nil
    }

    /// Another signed-in client starts over (its own server and user).
    private func adopt(_ api: APIClient) {
        let id = ObjectIdentifier(api)
        guard owner != id else { return }
        owner = id
        settings = nil
        fetchedAt = nil
        loading = nil
    }

    // MARK: - Kept on the phone

    private static func key(_ server: ServerAddress) -> String { "dictation.settings." + server.string }

    private static func remember(_ settings: DictationSettings, server: ServerAddress) {
        let value: [String: Any] = [
            "engine": settings.engine.rawValue, "onDeviceOnly": settings.onDeviceOnly, "cloudReady": settings.cloudReady,
        ]
        UserDefaults.standard.set(value, forKey: key(server))
    }

    private static func remembered(server: ServerAddress) -> DictationSettings? {
        guard let value = UserDefaults.standard.dictionary(forKey: key(server)),
              let engine = (value["engine"] as? String).flatMap(DictationEngine.init(rawValue:)) else { return nil }
        return DictationSettings(
            engine: engine, onDeviceOnly: value["onDeviceOnly"] as? Bool ?? false, providerId: nil, modelId: nil,
            cloudReady: value["cloudReady"] as? Bool ?? false
        )
    }
}
