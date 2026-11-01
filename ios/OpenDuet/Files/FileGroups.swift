// M26 (docs/API.md "Files page"): both Files lists (profile › Files and a channel sheet's Files)
// sort each row into one group by where it came from. Pure Foundation, host-tested.
//   1. The assistant sent you: `send`, and `write` without a task (files the assistant wrote while chatting);
//   2. You uploaded: `upload`, and rows with no origin whose source is the user (older servers);
//   3. Screenshots;
//   4. one group per task (`write` with a task), newest task first, collapsed by default;
//   5. Other: no origin and source the assistant (unmatched older rows, every row of a pre-M26 server).
// Each group keeps the list's order (newest first); empty groups are left out. A `send` or a
// `screenshot` made in a task stays in its own group and names the task in its row.
import Foundation

struct FileGroup: Hashable, Sendable, Identifiable {
    enum Kind: Hashable, Sendable {
        case sent
        case uploaded
        case screenshots
        /// `title` nil: the task was deleted since ("Deleted task", opens nothing)
        case task(id: String, title: String?)
        case other
    }

    var kind: Kind
    /// newest first
    var files: [ChannelFile]

    var id: String {
        switch kind {
        case .sent: "sent"
        case .uploaded: "uploaded"
        case .screenshots: "screenshots"
        case .task(let id, _): "task:\(id)"
        case .other: "other"
        }
    }

    /// The task a task group opens (nil for every other group and for a task deleted since).
    var taskLink: URL? {
        guard case .task(let id, let title?) = kind, !title.isEmpty else { return nil }
        return FileGroups.taskLink(id)
    }
}

enum FileGroups {
    /// Where one row goes (a task group by the row's task id).
    enum Slot: Hashable, Sendable {
        case sent, uploaded, screenshots, task(String), other
    }

    static func slot(_ file: ChannelFile) -> Slot {
        let task = file.taskId.flatMap { $0.isEmpty ? nil : $0 }
        switch file.origin {
        case .send: return .sent
        case .write: return task.map(Slot.task) ?? .sent
        case .screenshot: return .screenshots
        case .upload: return .uploaded
        case nil: return file.source == .user ? .uploaded : .other
        }
    }

    /// The list as loaded (newest first) in its groups. Deleted rows never show in a list.
    static func groups(_ files: [ChannelFile]) -> [FileGroup] {
        var sent: [ChannelFile] = []
        var uploaded: [ChannelFile] = []
        var shots: [ChannelFile] = []
        var other: [ChannelFile] = []
        var taskOrder: [String] = []
        var tasks: [String: [ChannelFile]] = [:]
        for file in files where !file.isDeleted {
            switch slot(file) {
            case .sent: sent.append(file)
            case .uploaded: uploaded.append(file)
            case .screenshots: shots.append(file)
            case .other: other.append(file)
            case .task(let id):
                if tasks[id] == nil { taskOrder.append(id) }
                tasks[id, default: []].append(file)
            }
        }
        var out: [FileGroup] = []
        if !sent.isEmpty { out.append(FileGroup(kind: .sent, files: sent)) }
        if !uploaded.isEmpty { out.append(FileGroup(kind: .uploaded, files: uploaded)) }
        if !shots.isEmpty { out.append(FileGroup(kind: .screenshots, files: shots)) }
        for id in taskOrder {
            let rows = tasks[id] ?? []
            // The task's current title: the newest row that has one (rows agree unless it was
            // deleted since, and then none has it).
            let title = rows.lazy.compactMap(\.taskTitle).first { !$0.isEmpty }
            out.append(FileGroup(kind: .task(id: id, title: title), files: rows))
        }
        if !other.isEmpty { out.append(FileGroup(kind: .other, files: other)) }
        return out
    }

    /// The task's title in a row's subtitle: a `send` or `screenshot` made in a task that still
    /// exists. Task groups don't repeat it, and other rows have none.
    static func taskLine(_ file: ChannelFile) -> String? {
        guard file.origin == .send || file.origin == .screenshot,
              let task = file.taskId, !task.isEmpty,
              let title = file.taskTitle, !title.isEmpty else { return nil }
        return title
    }

    /// What a row opens when tapped: its artifact (duet://artifacts/<id>) when it is one's page,
    /// else nil (the file preview).
    static func artifactLink(_ file: ChannelFile) -> URL? {
        guard let id = file.artifactId, !id.isEmpty else { return nil }
        return link("artifacts", id)
    }

    static func taskLink(_ id: String) -> URL? {
        id.isEmpty ? nil : link("tasks", id)
    }

    private static func link(_ host: String, _ id: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = "duet"
        parts.host = host
        parts.path = "/" + id
        return parts.url
    }
}
