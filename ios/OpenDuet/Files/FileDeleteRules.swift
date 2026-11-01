// M26 (docs/API.md "DELETE /api/files/:id", "In the app"): deleting a file from a Files row or the
// preview's ⋯ menu. Pure Foundation, host-tested.
// - The in-place confirmation's switch "Also delete from OpenDuet's computer" (off by default) shows
//   only for a file with an original in /workspace outside artifacts/ and .skills/ (the server
//   refuses those: an artifact's page is deleted from Make, a skill's copy from Skills).
// - The request carries `?alsoWorkspace=true` only when the switch is on (some proxies drop a
//   DELETE's body), nothing at all when it is off.
// - 200 with a body that doesn't decode, and 404, still count as deleted; a refusal deletes nothing
//   and stays inline under the row with its own line.
import Foundation

/// A delete in flight, or the refusal that stays under the row (or at the preview's bottom).
enum FileDeleteRequest: Hashable, Sendable {
    case inFlight
    case failed(FileDeleteFailure)

    var failure: FileDeleteFailure? {
        if case .failed(let failure) = self { failure } else { nil }
    }
}

/// Why a delete didn't happen, and what the confirmation offers next.
struct FileDeleteFailure: Hashable, Sendable {
    var reason: String
    /// Retry can work as it is (the computer or the server was out of reach, or busy)
    var retries: Bool
    /// the original isn't on the assistant's computer any more: offer to delete the chat's copy only
    var offersChatOnly = false
}

/// What the store does with DELETE /api/files/:id's answer.
enum FileDeleteOutcome: Hashable, Sendable {
    /// leaves every loaded list; `response` nil: a 404 (gone already) or a body that didn't decode
    case deleted(DeleteFileResponse?)
    case refused(FileDeleteFailure)
    /// the request was cancelled (sign-out): nothing to show
    case cancelled
}

enum FileDeleteRules {
    /// The folders of /workspace whose files the server won't delete (PROTECTED_WORKSPACE_DIRS).
    static let protectedFolders: Set<String> = ["artifacts", ".skills"]

    /// Whether the confirmation shows "Also delete from OpenDuet's computer": the file has an
    /// original in /workspace and its first folder isn't artifacts/ or .skills/.
    static func offersWorkspaceDelete(_ file: ChannelFile) -> Bool {
        guard let path = file.workspacePath, !path.isEmpty else { return false }
        let first = path.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        return !protectedFolders.contains(first)
    }

    /// DELETE /api/files/:id's query: `alsoWorkspace=true` with the switch on, nothing otherwise.
    static func query(alsoWorkspace: Bool) -> [URLQueryItem] {
        alsoWorkspace ? [URLQueryItem(name: "alsoWorkspace", value: "true")] : []
    }

    static func outcome(_ result: Result<DeleteFileResponse?, any Error>) -> FileDeleteOutcome {
        switch result {
        case .success(let response):
            return .deleted(response)
        case .failure(let error as APIError) where error == .notFound:
            return .deleted(nil)
        case .failure(let error) where error is CancellationError:
            return .cancelled
        case .failure(let error):
            return .refused(failure(error))
        }
    }

    /// The line under the row for a refusal (nothing was deleted).
    static func failure(_ error: any Error) -> FileDeleteFailure {
        switch error as? APIError {
        case .server(_, FileDeleteRefusal.protectedPath.rawValue)?:
            return FileDeleteFailure(
                reason: String(localized: "This file belongs to an artifact or a skill on OpenDuet's computer. Delete it there."),
                retries: false
            )
        case .server(_, FileDeleteRefusal.computerUnreachable.rawValue)?:
            return FileDeleteFailure(reason: String(localized: "Couldn't reach OpenDuet's computer. Nothing was deleted."), retries: true)
        case .server(_, FileDeleteRefusal.computerBusy.rawValue)?:
            return FileDeleteFailure(reason: String(localized: "You're using OpenDuet's browser. Hand it back and try again."), retries: true)
        case .notConfigured?:
            return FileDeleteFailure(reason: String(localized: "OpenDuet's computer isn't set up."), retries: false)
        case .validationFailed(field: "alsoWorkspace", _)?:
            return FileDeleteFailure(
                reason: String(localized: "This file isn't on OpenDuet's computer any more."),
                retries: false, offersChatOnly: true
            )
        default:
            return FileDeleteFailure(reason: TaskBoard.reason(for: error), retries: true)
        }
    }

    /// The note "It was already gone from OpenDuet's computer." under a list stays through the
    /// reload that list does as the preview that deleted the file closes (the page appears again
    /// at once); a refresh after that (a pull, Retry, the page opened again) clears it, and so does
    /// the next delete.
    static let noteGrace: TimeInterval = 2

    static func keepsNote(setAt: Date, now: Date) -> Bool {
        now.timeIntervalSince(setAt) < noteGrace
    }

    /// The preview's failed line: a file that answers 404 was deleted (a duet://files link, or a
    /// card from before the delete reached this device).
    static func previewReason(_ error: any Error) -> String {
        if case APIError.notFound? = error as? APIError { return String(localized: "This file was deleted.") }
        return TaskBoard.reason(for: error)
    }
}
