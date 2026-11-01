// M10: a task row's menu, built once for both the trailing ⋯ button and the long-press
// (TaskRows.swift draws it): Discuss (opens the task thread), Pin / Unpin, Mark complete, Rename,
// Archive, Copy link and Delete (asks in place under the row). No "add sub-goal". Routine rows
// keep their own menu (Run now, Pause / Resume, Edit time, Delete). And the Rename rule: trimmed,
// 1-200 characters, as the server checks it (UpdateTaskRequest.title). Pure Foundation
// (host-tested).
import Foundation

enum TaskRowMenuItem: Hashable, Sendable, CaseIterable {
    case discuss, pin, markComplete, rename, archive, copyLink, delete
}

struct TaskRowMenuModel: Hashable, Sendable {
    var pinned: Bool
    var resolved: Bool
    /// Mark complete / Archive in flight for the row (cardRequests[taskId])
    var updating: Bool
    var pinning: Bool
    var renaming: Bool
    var deleting: Bool

    /// The menu's order.
    var items: [TaskRowMenuItem] { TaskRowMenuItem.allCases }

    func isDisabled(_ item: TaskRowMenuItem) -> Bool {
        switch item {
        case .discuss, .copyLink: false
        // A pin and a rename share the task's one optimistic PATCH (TasksReducer).
        case .pin, .rename: pinning || renaming || deleting
        case .markComplete: resolved || updating || deleting
        case .archive: updating || deleting
        case .delete: deleting
        }
    }

    /// Delete sits under a divider.
    func startsGroup(_ item: TaskRowMenuItem) -> Bool { item == .delete }
}

enum TaskTitleRule {
    static let maxLength = 200

    /// The title as it would be sent: trimmed; nil when empty or longer than 200 characters
    /// (UTF-16 units, the server's zod `.max(200)`).
    static func cleaned(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf16.count <= maxLength else { return nil }
        return trimmed
    }

    static func isTooLong(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count > maxLength
    }

    /// Save is possible: a valid title that differs from the current one.
    static func canSave(_ draft: String, current: String) -> Bool {
        guard let title = cleaned(draft) else { return false }
        return title != current
    }
}
