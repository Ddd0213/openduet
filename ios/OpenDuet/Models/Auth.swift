// Server info, sign-in and the signed-in user (backend/src/contract/auth.ts).
import Foundation

/// GET /api/server-info (unauthenticated).
struct ServerInfo: Decodable, Hashable, Sendable {
    var name: String
    var version: String
    var apiVersion: Int
}

/// POST /api/session
struct SignInRequest: Codable, Hashable, Sendable {
    var username: String
    var password: String
}

/// POST /api/session response. The token goes to the Keychain and into Authorization: Bearer.
struct SignInResponse: Decodable, Sendable {
    var token: String
    var user: CurrentUser
}

/// Optional services; when one is off the app shows its "isn't set up yet" state.
struct Features: Decodable, Hashable, Sendable {
    enum PushProvider: String, Decodable, Sendable { case apns, ntfy, bark }
    var connectors: Bool
    var webSearch: Bool
    var push: PushProvider?
    var computer: Bool
    /// M12: a usable default chat model is set up (missing from an older server = true).
    var models: Bool = true
    /// A usable realtime voice model is set up (missing from an older server = false).
    var voice: Bool = false
    /// M20: off = the assistant's computer isn't deployed on this server; else its browser's mode
    /// (missing from an older server: headless when `computer`, otherwise off).
    var computerMode: ComputerMode = .off
    /// M20: the browser closes after this many idle minutes; nil = never (or an older server).
    var computerIdleMinutes: Int?
}

/// M20: whether the assistant's computer is deployed, and how its browser runs.
enum ComputerMode: String, Decodable, Hashable, Sendable { case off, headless, headed }

extension Features {
    private enum CodingKeys: String, CodingKey { case connectors, webSearch, push, computer, models, voice, computerMode, computerIdleMinutes }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connectors = try c.decode(Bool.self, forKey: .connectors)
        webSearch = try c.decode(Bool.self, forKey: .webSearch)
        push = try c.decodeIfPresent(PushProvider.self, forKey: .push)
        computer = try c.decode(Bool.self, forKey: .computer)
        models = try c.decodeIfPresent(Bool.self, forKey: .models) ?? true
        voice = try c.decodeIfPresent(Bool.self, forKey: .voice) ?? false
        // An unknown mode from a newer server still says whether there is a computer.
        let raw: String? = (try? c.decodeIfPresent(String.self, forKey: .computerMode)) ?? nil
        let mode = raw.flatMap(ComputerMode.init(rawValue:))
        computerMode = mode ?? (computer ? .headless : .off)
        computerIdleMinutes = try c.decodeIfPresent(Int.self, forKey: .computerIdleMinutes)
    }
}

/// The signed-in user (contract shape "Me": GET/PATCH /api/me).
struct CurrentUser: Decodable, Hashable, Sendable, Identifiable {
    var id: ID
    var username: String
    var name: String
    var firstName: String
    /// The real address from a connected mail account; nil until there is one.
    var email: String?
    /// IANA name, kept in sync from the X-Timezone header.
    var timezone: String
    var language: AppLanguage
    var briefTime: LocalTime
    var checkinMinute: Int
    var weekendsOn: Bool
    var onboardedAt: Date?
    var mainChannelId: ID
    var features: Features
    var createdAt: Date
}

/// PATCH /api/me (only the fields that changed).
struct UpdateMeRequest: Codable, Hashable, Sendable {
    var firstName: String?
    var briefTime: LocalTime?
    var weekendsOn: Bool?
}

/// GET /api/onboarding: page 2's chips from the user's real setup.
struct OnboardingInfo: Decodable, Hashable, Sendable {
    struct Chip: Decodable, Hashable, Sendable {
        enum Kind: String, Decodable, Sendable { case app, channel, skill }
        var kind: Kind
        var label: String
        /// Composio toolkit slug for kind app (picks the logo); never shown as text.
        var toolkit: String?
    }
    struct Slack: Decodable, Hashable, Sendable {
        var connected: Bool
    }
    var chips: [Chip]
    var slack: Slack
}

/// POST /api/onboarding/complete response; the first-day scan runs in the background.
struct OnboardingCompleteResponse: Decodable, Sendable {
    var user: CurrentUser
    var scanStarted: Bool
}
