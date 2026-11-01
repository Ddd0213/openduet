// Channels and their shared files (backend/src/contract/channels.ts).
import Foundation

/// The 3x8 icon grid of the New channel sheet, in display order.
enum ChannelIcon: String, Codable, CaseIterable, Sendable {
    case checkbox, calendar, mail, dollar, chart, globe, pin, house
    case cube, play, folder, pencil, magnifier, heart, people, briefcase
    case book, plane, car, scissors, bag, gift, sprout, music
}

/// The 9 colour swatches of the New channel sheet, in display order.
enum ChannelColor: String, Codable, CaseIterable, Sendable {
    case berry = "#B54C76"
    case blush = "#E5C0C5"
    case sand = "#E0BCAD"
    case orange = "#E69F4E"
    case sage = "#CAD0BA"
    case green = "#5D927A"
    case mist = "#BECDDA"
    case blue = "#6290C2"
    case lavender = "#C1BDD3"
}

/// A channel; the main thread is the one with isMain = true.
struct Channel: Decodable, Hashable, Sendable, Identifiable {
    var id: ID
    var isMain: Bool
    var name: String
    var icon: ChannelIcon
    var colorHex: ChannelColor
    var purpose: String
    var archived: Bool
    var unreadCount: Int
    var lastReadAt: Date?
    var lastMessageAt: Date?
    var createdAt: Date
    /// M11: this channel's addendum to the soul ("Here, OpenDuet also…"); the main thread's is always "".
    var soulExtra: String = ""
    /// M11: whether this channel reads "About you" (shared memory); the main thread always does.
    var useSharedMemory: Bool = true
    /// M12: this channel's own model (ModelEntry.id); nil = the default model (always nil on the main thread).
    var modelId: ID? = nil
    /// M12: this channel's thinking level; nil = the default (clamped per model at run time).
    var thinkingLevel: ThinkingLevel? = nil
    /// M21: the turn running in this channel's own thread (cold start restores dots and Stop).
    var activeRun: ActiveRun? = nil
}

extension Channel {
    private enum CodingKeys: String, CodingKey {
        case id, isMain, name, icon, colorHex, purpose, archived, unreadCount, lastReadAt, lastMessageAt, createdAt
        case soulExtra, useSharedMemory
        case modelId, thinkingLevel
        case activeRun
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ID.self, forKey: .id)
        isMain = try c.decode(Bool.self, forKey: .isMain)
        name = try c.decode(String.self, forKey: .name)
        icon = try c.decode(ChannelIcon.self, forKey: .icon)
        colorHex = try c.decode(ChannelColor.self, forKey: .colorHex)
        purpose = try c.decode(String.self, forKey: .purpose)
        archived = try c.decode(Bool.self, forKey: .archived)
        unreadCount = try c.decode(Int.self, forKey: .unreadCount)
        lastReadAt = try c.decodeIfPresent(Date.self, forKey: .lastReadAt)
        lastMessageAt = try c.decodeIfPresent(Date.self, forKey: .lastMessageAt)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        soulExtra = try c.decodeIfPresent(String.self, forKey: .soulExtra) ?? ""
        useSharedMemory = try c.decodeIfPresent(Bool.self, forKey: .useSharedMemory) ?? true
        modelId = try c.decodeIfPresent(ID.self, forKey: .modelId)
        // A level from a newer server reads as the default rather than failing the whole list.
        thinkingLevel = (try? c.decodeIfPresent(ThinkingLevel.self, forKey: .thinkingLevel)) ?? nil
        activeRun = (try? c.decodeIfPresent(ActiveRun.self, forKey: .activeRun)) ?? nil
    }
}

/// GET /api/channels (?archived=true for the Archived list).
struct ChannelList: Decodable, Sendable {
    var channels: [Channel]
}

/// POST /api/channels
struct CreateChannelRequest: Codable, Hashable, Sendable {
    var name: String
    var icon: ChannelIcon
    var colorHex: ChannelColor
    var purpose: String
    /// M11: skills, connectors and apps to turn on here (on top of everything with scope all). nil = left out.
    var access: [AccessRef]? = nil
    /// M11: the assistant greets the new channel and offers tasks (the server's default is true). nil = left out.
    var greet: Bool? = nil
}

/// PATCH /api/channels/:id (only the fields that changed).
struct UpdateChannelRequest: Hashable, Sendable {
    var name: String?
    var icon: ChannelIcon?
    var colorHex: ChannelColor?
    var purpose: String?
    var archived: Bool?
    /// M11 (not on the main thread: 400)
    var soulExtra: String? = nil
    var useSharedMemory: Bool? = nil
    /// M12 (not on the main thread: 400): nil = unchanged, .clear = back to the default (null)
    var modelId: Patch<ID>? = nil
    var thinkingLevel: Patch<ThinkingLevel>? = nil
}

extension UpdateChannelRequest: Codable {
    private enum CodingKeys: String, CodingKey {
        case name, icon, colorHex, purpose, archived, soulExtra, useSharedMemory, modelId, thinkingLevel
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        icon = try c.decodeIfPresent(ChannelIcon.self, forKey: .icon)
        colorHex = try c.decodeIfPresent(ChannelColor.self, forKey: .colorHex)
        purpose = try c.decodeIfPresent(String.self, forKey: .purpose)
        archived = try c.decodeIfPresent(Bool.self, forKey: .archived)
        soulExtra = try c.decodeIfPresent(String.self, forKey: .soulExtra)
        useSharedMemory = try c.decodeIfPresent(Bool.self, forKey: .useSharedMemory)
        modelId = try c.decodePatch(ID.self, forKey: .modelId)
        thinkingLevel = try c.decodePatch(ThinkingLevel.self, forKey: .thinkingLevel)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(icon, forKey: .icon)
        try c.encodeIfPresent(colorHex, forKey: .colorHex)
        try c.encodeIfPresent(purpose, forKey: .purpose)
        try c.encodeIfPresent(archived, forKey: .archived)
        try c.encodeIfPresent(soulExtra, forKey: .soulExtra)
        try c.encodeIfPresent(useSharedMemory, forKey: .useSharedMemory)
        try c.encodePatch(modelId, forKey: .modelId)
        try c.encodePatch(thinkingLevel, forKey: .thinkingLevel)
    }
}

/// POST /api/channels/:id/read
/// POST /api/channels/:id/read. M21: `messageId` (the newest message seen) is what the server
/// reads up to; `at` is kept for older servers.
struct MarkReadRequest: Codable, Hashable, Sendable {
    var at: Date?
    var messageId: String? = nil
}

/// A file in a channel: a composer attachment or a file from the assistant.
/// Bytes come from `url` (GET /api/files/:id/content) through the signed-in session.
/// M26 (M26Models.swift): origin, workspacePath, taskId, taskTitle, artifactId, deletedAt; all nil
/// from older servers and rows, and an origin this build doesn't know reads nil.
struct ChannelFile: Decodable, Hashable, Sendable, Identifiable {
    enum Source: String, AssistantValue, Sendable { case user, assistant }
    var id: ID
    var channelId: ID
    var messageId: ID?
    var name: String
    /// Real type detected from the bytes by the server.
    var mime: String
    var size: Int
    var source: Source
    var url: String
    var createdAt: Date
    /// M26: how it got here; nil = from before M26 and not matched (the Files page's "Other").
    var origin: FileOrigin? = nil
    /// M26: its path in /workspace, relative to /workspace ("build/build.py"); nil = none.
    var workspacePath: String? = nil
    /// M26: the task whose own session made it.
    var taskId: ID? = nil
    /// M26: that task's title; nil without taskId or once the task is deleted.
    var taskTitle: String? = nil
    /// M26: the Make artifact this file is the page of (the row opens it).
    var artifactId: ID? = nil
    /// M26: set once the user deleted it (only on chat cards and the DELETE answer).
    var deletedAt: Date? = nil

    var isImage: Bool { mime.hasPrefix("image/") }
    var isDeleted: Bool { deletedAt != nil }
}

/// GET /api/channels/:id/files (newest first; M26: deleted files are left out).
struct ChannelFileList: Decodable, Sendable {
    var files: [ChannelFile]
}

/// POST /api/channels/:id/files (multipart "file", at most 25 MB).
struct UploadFileResponse: Decodable, Sendable {
    static let maxUploadBytes = 25 * 1024 * 1024
    var file: ChannelFile
}
