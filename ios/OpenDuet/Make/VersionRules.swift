// M24 (review-make P1-4): the viewer's ⋯ Versions and Undo. Each row of the Versions sheet says
// who saved it and why ("Edited by OpenDuet", "Restored by you") with what was asked (first ~80
// characters); every row but the newest (the page as it is now) can be restored. Undo restores
// the one before the newest (ArtifactVersionList.undoTarget). The list loads when the page does
// and again with every new version. M27: live data updates have their own label ("Data updated
// by OpenDuet", "5 updates"); the list follows merged data updates, one load at a time.
// Pure Foundation (host-tested).
import Foundation

enum VersionRules {
    /// Who saved a version and why; `who` nil = a value from a newer server.
    enum Label: Hashable, Sendable {
        enum Who: Hashable, Sendable { case you, assistant }
        case made(Who?)
        case edited(Who?)
        case refreshed(Who?)
        case restored(Who?)
        /// an unknown reason ("Changed by OpenDuet")
        case changed(Who?)
        /// M27: live data updates ("Data updated by OpenDuet")
        case dataUpdated(Who?)
    }

    static func label(_ version: ArtifactVersion) -> Label {
        let who: Label.Who? = switch version.by {
        case .user?: .you
        case .assistant?: .assistant
        case nil: nil
        }
        switch version.reason {
        case .create?: return .made(who)
        case .edit?: return .edited(who)
        case .refresh?: return .refreshed(who)
        case .restore?: return .restored(who)
        case .data?: return .dataUpdated(who)
        case nil: return .changed(who)
        }
    }

    /// M27: a data row's second line (it has no prompt): how many updates were merged into it,
    /// when more than one ("5 updates"); nil for one, and for every other row.
    static func updates(_ version: ArtifactVersion) -> Int? {
        guard version.reason == .data, version.dataUpdates > 1 else { return nil }
        return version.dataUpdates
    }

    /// The row's second line: what was asked, on one line, at most `limit` characters. A comment's
    /// quoted passage ("> ..." lines) gives way to the note under it when there is one.
    static func detail(_ prompt: String?, limit: Int = 80) -> String? {
        guard let prompt else { return nil }
        let lines = prompt.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let notes = lines.filter { !$0.hasPrefix(">") }
        let chosen = notes.isEmpty ? lines.map { line in String(line.drop { char in char == ">" || char == " " }) } : notes
        let text = chosen.joined(separator: " ")
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !text.isEmpty else { return nil }
        guard text.count > limit else { return text }
        return String(text.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }

    /// Every row but the newest can be restored (the newest is the page as it is now).
    static func canRestore(_ version: ArtifactVersion, in list: ArtifactVersionList) -> Bool {
        guard let newest = list.versions.first else { return false }
        return version.id != newest.id
    }

    /// Why a restore didn't go through: the assistant is changing the page (409), the version was
    /// dropped by the limit of 10 (404), or the usual reasons.
    static func failure(_ error: any Error) -> String {
        switch error as? APIError {
        case .server(_, "conflict")?, .staleVersion?:
            String(localized: "OpenDuet is still working on this page. Try again when it's done.")
        case .notFound?:
            String(localized: "That version isn't kept any more.")
        default:
            TaskBoard.reason(for: error)
        }
    }

    /// What the viewer keeps for one artifact: the list (newest first) and the restore going on.
    struct Listing: Hashable, Sendable {
        enum Phase: Hashable, Sendable { case idle, loading, loaded, failed(reason: String) }
        var artifactId: String?
        var phase: Phase = .idle
        var list = ArtifactVersionList(versions: [])
        /// the version being restored (its row spins; Undo and the other rows wait)
        var restoring: String?
        /// the last restore's failure, shown in the sheet
        var failure: String?
        /// M27: a load is in flight / was asked for again meanwhile (one more after it)
        var inFlight = false
        var again = false

        /// Undo: the one before the newest, while nothing is being restored.
        var undoTarget: ArtifactVersion? { restoring == nil ? list.undoTarget : nil }

        /// A load is asked for: another artifact starts empty; the same one keeps its rows
        /// meanwhile. M27: true = start it now; false = one is in flight (it loads once more).
        @discardableResult
        mutating func begin(_ id: String) -> Bool {
            if artifactId != id { self = Listing(artifactId: id) }
            if list.versions.isEmpty { phase = .loading }
            guard !inFlight else {
                again = true
                return false
            }
            inFlight = true
            return true
        }

        /// The load answered. True = asked again meanwhile: load once more.
        @discardableResult
        mutating func loaded(_ list: ArtifactVersionList, id: String) -> Bool {
            guard artifactId == id else { return false }
            self.list = list
            phase = .loaded
            return end()
        }

        /// A failed reload keeps the rows it had.
        @discardableResult
        mutating func failed(_ reason: String, id: String) -> Bool {
            guard artifactId == id else { return false }
            if list.versions.isEmpty { phase = .failed(reason: reason) }
            return end()
        }

        /// The load was cancelled: nothing changes but the load ends.
        @discardableResult
        mutating func cancelled(_ id: String) -> Bool {
            guard artifactId == id else { return false }
            return end()
        }

        private mutating func end() -> Bool {
            inFlight = false
            defer { again = false }
            return again
        }
    }
}
