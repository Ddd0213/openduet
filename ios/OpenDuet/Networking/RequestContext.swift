// Headers every request carries (prompt L165, docs/API.md): the iPhone's IANA timezone and
// the app's current language, so the server keeps User.timezone and User.language in sync.
// M25: and the iPhone's region (X-Region, two letters) for User.region (the weather's unit).
import Foundation

enum RequestContext {
    /// "zh-Hans" when the app runs in Simplified Chinese (per-app language included), else "en".
    static var locale: AppLanguage {
        Bundle.main.preferredLocalizations.first?.hasPrefix("zh") == true ? .zhHans : .en
    }

    /// TimeZone.current, read per request (autoupdating, so a change while running is picked up).
    static var timezone: String { TimeZone.autoupdatingCurrent.identifier }

    /// M25: the region set in Settings (ISO 3166-1 alpha-2, "US"); nil when it isn't a country
    /// (e.g. "001", World), and then no header is sent.
    static var region: String? { RegionCode.header(Locale.autoupdatingCurrent.region?.identifier) }

    /// M28: the model's name for the signed-in devices list ("iPhone 16 Pro", DeviceModelName);
    /// nil when the header rule refuses it, and then no header is sent.
    static let deviceName: String? = DeviceNameHeader.header(DeviceModelName.current)

    static func apply(to request: inout URLRequest, token: String?) {
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.setValue(timezone, forHTTPHeaderField: "X-Timezone")
        request.setValue(locale.rawValue, forHTTPHeaderField: "X-Locale")
        if let region { request.setValue(region, forHTTPHeaderField: "X-Region") }
        if let deviceName { request.setValue(deviceName, forHTTPHeaderField: DeviceNameHeader.field) }
    }
}
