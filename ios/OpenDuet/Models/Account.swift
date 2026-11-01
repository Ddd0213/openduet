// Usage, memory, devices (push) and skills (backend/src/contract/account.ts).
import Foundation

/// GET /api/usage and the "usage" event. A limit of 0 means no limit: the bars just show usage.
struct UsageState: Decodable, Hashable, Sendable {
    struct Window: Decodable, Hashable, Sendable {
        var used: Int
        var limit: Int
        /// nil until a message starts the window ("Starts when a message is sent").
        var resetsAt: Date?
    }
    struct FullReset: Decodable, Hashable, Sendable {
        var available: Bool
        /// End of the current month ("Expires Nov 30").
        var expiresAt: Date
    }
    var session: Window
    var weekly: Window
    var fullReset: FullReset
    var limited: Bool
    /// When limited: when usage resumes.
    var resumesAt: Date?
}

/// GET /api/memory
struct MemoryState: Decodable, Hashable, Sendable {
    /// M11: "About you" facts carry their source (Models/M11Models.swift); archived ones are left out.
    typealias Fact = MemoryFact
    var document: String
    var facts: [Fact]
    var updatedAt: Date?
}

/// PUT /api/memory
struct UpdateMemoryRequest: Codable, Hashable, Sendable {
    var document: String
}

/// POST /api/devices: register this iPhone for remote push.
struct RegisterDeviceRequest: Codable, Hashable, Sendable {
    enum Provider: String, Codable, Sendable { case apns }
    enum Environment: String, Codable, Sendable { case production, sandbox }
    var provider: Provider
    /// The APNs device token as lowercase hex.
    var token: String
    var environment: Environment
    var locale: AppLanguage
}

struct RegisterDeviceResponse: Decodable, Sendable {
    var deviceId: ID
}

/// A saved skill, invoked with /name in the composer.
/// M11: an Agent Skills folder. `instructions` is SKILL.md's body; `files` are its other files.
struct Skill: Decodable, Hashable, Sendable, Identifiable {
    var id: ID
    var name: String
    var description: String
    var instructions: String
    var createdAt: Date
    /// M11: where it came from (Written by you / GitHub / Zip / the assistant).
    var source: SkillSource = .manual
    /// M11: github: the repository or folder URL it was imported from.
    var sourceUrl: String? = nil
    var files: [SkillFileInfo] = []
    /// M11: all = on in every channel; channels = only in `channelIds`.
    var scope: AccessScope = .all
    var channelIds: [ID] = []
}

extension Skill {
    private enum CodingKeys: String, CodingKey {
        case id, name, description, instructions, createdAt, source, sourceUrl, files, scope, channelIds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ID.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        description = try c.decode(String.self, forKey: .description)
        instructions = try c.decode(String.self, forKey: .instructions)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        source = (try? c.decodeIfPresent(SkillSource.self, forKey: .source)) ?? .manual
        sourceUrl = try c.decodeIfPresent(String.self, forKey: .sourceUrl)
        files = try c.decodeIfPresent([SkillFileInfo].self, forKey: .files) ?? []
        scope = (try? c.decodeIfPresent(AccessScope.self, forKey: .scope)) ?? .all
        channelIds = try c.decodeIfPresent([ID].self, forKey: .channelIds) ?? []
    }

    /// M11: a skill with a script file runs on the assistant's computer (the first run of a new version asks).
    var hasScripts: Bool {
        files.contains { file in [".py", ".js", ".mjs", ".sh"].contains { file.path.lowercased().hasSuffix($0) } }
    }
}

/// GET /api/skills
struct SkillList: Decodable, Sendable {
    var skills: [Skill]
}

/// POST /api/skills
struct CreateSkillRequest: Codable, Hashable, Sendable {
    var name: String
    var description: String
    var instructions: String
    /// M11: text files that go with it (nil = left out).
    var files: [SkillFileWrite]? = nil
    /// M11: where it was written (nil = left out = Everything, all channels; a channel = only there).
    var channelId: ID? = nil
}
