// M26 contract (backend/src/contract/m26.ts): where a file came from, deleting one (also after it
// was sent, optionally its original on the assistant's computer) and the deleted file card. The fields M26
// adds to ChannelFile sit next to it in Channels.swift; their tolerant decoding is here. Tolerant like
// the rest: an origin or a workspace result this build doesn't know reads nil.
import Foundation

/// How a file got into the chat (ChannelFile.origin).
enum FileOrigin: String, Decodable, Hashable, Sendable, CaseIterable {
    /// The assistant's send_file
    case send
    /// computer_files_write shared it in the chat
    case write
    /// a computer screenshot posted in the chat
    case screenshot
    /// the composer
    case upload
}

extension ChannelFile {
    private enum CodingKeys: String, CodingKey {
        case id, channelId, messageId, name, mime, size, source, url, createdAt
        case origin, workspacePath, taskId, taskTitle, artifactId, deletedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ID.self, forKey: .id)
        channelId = try c.decode(ID.self, forKey: .channelId)
        messageId = try c.decodeIfPresent(ID.self, forKey: .messageId)
        name = try c.decode(String.self, forKey: .name)
        mime = try c.decode(String.self, forKey: .mime)
        size = try c.decode(Int.self, forKey: .size)
        source = try c.decode(Source.self, forKey: .source)
        url = try c.decode(String.self, forKey: .url)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        origin = try? c.decodeIfPresent(FileOrigin.self, forKey: .origin)
        workspacePath = try? c.decodeIfPresent(String.self, forKey: .workspacePath)
        taskId = try? c.decodeIfPresent(ID.self, forKey: .taskId)
        taskTitle = try? c.decodeIfPresent(String.self, forKey: .taskTitle)
        artifactId = try? c.decodeIfPresent(ID.self, forKey: .artifactId)
        deletedAt = try c.decodeIfPresent(Date.self, forKey: .deletedAt)
    }
}

/// DELETE /api/files/:id: also delete the original in /workspace (default false). The server takes
/// it as `?alsoWorkspace=true` or as this JSON body; send nothing for false (what older apps do).
struct DeleteFileRequest: Codable, Hashable, Sendable {
    var alsoWorkspace: Bool
}

/// DELETE /api/files/:id -> 200 (before M26: 204, only for uploads never sent).
struct DeleteFileResponse: Decodable, Hashable, Sendable {
    /// What became of the original in /workspace.
    enum Workspace: String, Decodable, Hashable, Sendable {
        /// alsoWorkspace was false
        case notAsked = "not_asked"
        case deleted
        /// nothing was at that path any more (the chat's copy was still deleted)
        case missing
    }

    /// The deleted file (deletedAt set).
    var file: ChannelFile
    /// The card or text message it was in, as it now reads; nil for an upload never sent.
    var message: Message?
    /// nil: a result from a newer server (treat it like deleted)
    var workspace: Workspace?

    private enum CodingKeys: String, CodingKey { case file, message, workspace }

    init(file: ChannelFile, message: Message?, workspace: Workspace?) {
        self.file = file
        self.message = message
        self.workspace = workspace
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        file = try c.decode(ChannelFile.self, forKey: .file)
        message = try c.decodeIfPresent(Message.self, forKey: .message)
        workspace = try? c.decodeIfPresent(Workspace.self, forKey: .workspace)
    }
}

/// The ApiError codes DELETE /api/files/:id answers with besides the shared ones (not_found,
/// validation_failed field "alsoWorkspace", not_configured). APIError reads the new ones as
/// `.server(status:code:)`; nothing was deleted when any of them comes back.
enum FileDeleteRefusal: String, Sendable, CaseIterable {
    /// 409: the original is under artifacts/ or .skills/ (an artifact's page, a skill's copy)
    case protectedPath = "protected_path"
    /// 503: the assistant's computer couldn't be reached to delete the original
    case computerUnreachable = "computer_unreachable"
    /// 409: the user is driving the assistant's browser
    case computerBusy = "computer_busy"
}
