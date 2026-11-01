// M6 (iOS 1): files from the assistant on the store side (L180). File cards, Files rows and
// duet://files/<id> open a full-screen preview of a copy downloaded through the signed-in
// session into a temporary folder (removed when the preview closes and on sign-out); the
// channel sheet and profile > Files list GET /api/channels/:id/files and pick up new file
// cards and attachments live from `message` events. M9: long-press Delete on a Files row.
// M26: any file can be deleted (a sent one too), optionally with its original on the assistant's
// computer, from a Files row or the preview's ⋯ menu (FileDeleteRules); the answer's message
// replaces the card in the loaded threads, and a deleted file leaves every loaded list.
import Foundation

extension ChatStore {
    var fileActions: FileActions {
        var actions = FileActions()
        actions.open = { [weak self] id in self?.openFile(id) }
        actions.closePreview = { [weak self] in self?.closeFilePreview() }
        actions.retryPreview = { [weak self] in self?.retryFilePreview() }
        actions.openChannelSheet = { [weak self] in self?.openChannelSheet() }
        actions.closeChannelSheet = { [weak self] in self?.closeChannelSheet() }
        actions.refreshChannelFiles = { [weak self] in self?.refreshChannelFiles() }
        actions.refreshMainFiles = { [weak self] in self?.refreshMainFiles() }
        actions.delete = { [weak self] id, alsoWorkspace in self?.deleteFile(id, alsoWorkspace: alsoWorkspace, fromPreview: false) }
        actions.deletePreviewed = { [weak self] alsoWorkspace in
            guard let self, let id = self.computerBoard.files.preview?.id else { return }
            self.deleteFile(id, alsoWorkspace: alsoWorkspace, fromPreview: true)
        }
        actions.openLink = { [weak self] url in self?.openRoute(url) }
        return actions
    }

    // MARK: - Delete (M9, M26)

    /// Delete after the in-place confirmation (a Files row's, or the preview's at its bottom):
    /// DELETE /api/files/:id, `?alsoWorkspace=true` with the switch on. The row (or the preview's
    /// confirmation) shows the spinner meanwhile. A success, a 404 (already gone) or a 200 whose
    /// body doesn't decode removes the file everywhere; a refusal stays where it was asked.
    func deleteFile(_ id: String, alsoWorkspace: Bool, fromPreview: Bool) {
        guard !tornDown, !id.isEmpty, !isDeletingFile(id) else { return }
        clearWorkspaceGoneNote()
        setFileDelete(id, .inFlight, fromPreview: fromPreview)
        let key = ShellState.RequestKey.deleteFile(id)
        runTap(key, { [client] in try await client.deleteFile(id: id, alsoWorkspace: alsoWorkspace) }) { store, result in
            switch FileDeleteRules.outcome(result) {
            case .deleted(let response):
                store.fileDeleted(id, response: response)
            case .refused(let failure):
                store.setFileDelete(id, .failed(failure), fromPreview: fromPreview)
            case .cancelled:
                store.setFileDelete(id, nil, fromPreview: fromPreview)
            }
        }
    }

    /// The file leaves every loaded list and its preview closes; the card or text message it was
    /// in reads as the server rewrote it ("Deleted") in the main thread and the open task, the way
    /// its `message` event would; a missing original gets the short note under the lists.
    private func fileDeleted(_ id: String, response: DeleteFileResponse?) {
        removeFile(id, closingPreview: true)
        if let message = response?.message {
            board.accept(message, main: &reducer)
        }
        if response?.workspace == .missing {
            let now = Date.now
            computerBoard.files.mainFiles.workspaceGoneAt = now
            computerBoard.files.channelSheet?.workspaceGoneAt = now
        }
    }

    private func isDeletingFile(_ id: String) -> Bool {
        let files = computerBoard.files
        return files.mainFiles.deleting[id] == .inFlight || files.channelSheet?.deleting[id] == .inFlight
            || (files.preview?.id == id && files.preview?.deleting == .inFlight)
    }

    /// A row's delete shows in the lists that have the row; the preview's at the preview's bottom.
    private func setFileDelete(_ id: String, _ request: FileDeleteRequest?, fromPreview: Bool) {
        if fromPreview {
            if computerBoard.files.preview?.id == id { computerBoard.files.preview?.deleting = request }
            return
        }
        if computerBoard.files.mainFiles.files.contains(where: { $0.id == id }) {
            computerBoard.files.mainFiles.deleting[id] = request
        }
        if computerBoard.files.channelSheet?.files.contains(where: { $0.id == id }) == true {
            computerBoard.files.channelSheet?.deleting[id] = request
        }
    }

    private func clearWorkspaceGoneNote() {
        if computerBoard.files.mainFiles.workspaceGoneAt != nil { computerBoard.files.mainFiles.workspaceGoneAt = nil }
        if computerBoard.files.channelSheet?.workspaceGoneAt != nil { computerBoard.files.channelSheet?.workspaceGoneAt = nil }
    }

    /// The file leaves every loaded list (and, after the user's own delete, its preview closes).
    private func removeFile(_ id: String, closingPreview: Bool) {
        if computerBoard.files.mainFiles.files.contains(where: { $0.id == id }) || computerBoard.files.mainFiles.deleting[id] != nil {
            computerBoard.files.mainFiles.files.removeAll { $0.id == id }
            computerBoard.files.mainFiles.deleting[id] = nil
        }
        if let sheet = computerBoard.files.channelSheet, sheet.files.contains(where: { $0.id == id }) || sheet.deleting[id] != nil {
            computerBoard.files.channelSheet?.files.removeAll { $0.id == id }
            computerBoard.files.channelSheet?.deleting[id] = nil
        }
        if closingPreview, computerBoard.files.preview?.id == id { closeFilePreview() }
    }

    // MARK: - Preview

    /// A file card, a Files row or duet://files/<id>. A file the app has never seen (a link
    /// only) is named from the download's headers.
    func openFile(_ id: String) {
        guard !tornDown, !id.isEmpty else { return }
        let known = knownFile(id)
        let file = known ?? ChannelFile(
            id: id, channelId: reducer.channelId, messageId: nil, name: String(localized: "File"),
            mime: "application/octet-stream", size: 0, source: .assistant,
            url: "/api/files/\(id.pathSegment)/content", createdAt: .now
        )
        computerBoard.files.preview = FilePreviewState(file: file)
        downloadPreview(file, known: known != nil)
    }

    func closeFilePreview() {
        computerRuntime.previewTask?.cancel()
        computerRuntime.previewTask = nil
        computerBoard.files.preview = nil
        // Quick Look may still read the copy while the cover slides away.
        if let directory = computerRuntime.previewDirectory {
            computerRuntime.previewDirectory = nil
            Task {
                try? await Task.sleep(for: .seconds(1))
                ComputerFiles.remove(directory)
            }
        }
    }

    func retryFilePreview() {
        guard let preview = computerBoard.files.preview else { return }
        computerBoard.files.preview?.phase = .loading
        downloadPreview(preview.file, known: knownFile(preview.file.id) != nil)
    }

    private func downloadPreview(_ file: ChannelFile, known: Bool) {
        computerRuntime.previewTask?.cancel()
        if let old = computerRuntime.previewDirectory {
            ComputerFiles.remove(old)
            computerRuntime.previewDirectory = nil
        }
        computerRuntime.previewTask = Task { [client] in
            let result = await Self.result { try await ComputerFiles.download(file, known: known, client: client) }
            guard !Task.isCancelled, !tornDown, computerBoard.files.preview?.id == file.id else {
                if case .success(let copy) = result { ComputerFiles.remove(copy.directory) }
                return
            }
            switch result {
            case .success(let copy):
                markOnline()
                computerRuntime.previewDirectory = copy.directory
                // In place: a Delete asked from the ⋯ menu while it downloaded keeps its state.
                computerBoard.files.preview?.file = copy.file
                computerBoard.files.preview?.phase = .ready(localURL: copy.url)
            case .failure(let error):
                noteFailure(error)
                // M26: a 404 is a deleted file ("This file was deleted.").
                computerBoard.files.preview?.phase = .failed(reason: FileDeleteRules.previewReason(error))
            }
        }
    }

    /// The file's metadata from what the app already has (lists, threads, the open task). M26: a
    /// deleted one isn't known (its bytes are gone; a link to it gets the 404 line).
    private func knownFile(_ id: String) -> ChannelFile? {
        let files = computerBoard.files
        if let hit = files.channelSheet?.files.first(where: { $0.id == id }) { return hit.isDeleted ? nil : hit }
        if let hit = files.mainFiles.files.first(where: { $0.id == id }) { return hit.isDeleted ? nil : hit }
        let threads = [reducer.thread.messages, board.openSession?.state.thread.messages ?? []]
        for messages in threads {
            for message in messages.reversed() {
                if let hit = FileLists.files(in: message).first(where: { $0.id == id }) { return hit.isDeleted ? nil : hit }
            }
        }
        return nil
    }

    // MARK: - Files lists

    /// The channel's header pill (only in a channel): its sheet with the Files list.
    func openChannelSheet() {
        guard !tornDown, let channel = menu.state.selected, !channel.isMain else { return }
        computerBoard.files.channelSheet = ChannelSheetState(channelId: channel.id, channel: channel)
        loadFiles(channel.id)
    }

    func closeChannelSheet() {
        if let id = computerBoard.files.channelSheet?.channelId, id != user.mainChannelId {
            computerRuntime.listTasks[id]?.cancel()
            computerRuntime.listTasks[id] = nil
        }
        computerBoard.files.channelSheet = nil
    }

    func refreshChannelFiles() {
        guard let id = computerBoard.files.channelSheet?.channelId else { return }
        if computerBoard.files.channelSheet?.files.isEmpty == true { computerBoard.files.channelSheet?.phase = .loading }
        if let at = computerBoard.files.channelSheet?.workspaceGoneAt, !FileDeleteRules.keepsNote(setAt: at, now: .now) {
            computerBoard.files.channelSheet?.workspaceGoneAt = nil
        }
        loadFiles(id)
    }

    /// Profile > Files: the main thread's files.
    func refreshMainFiles() {
        guard !tornDown else { return }
        if computerBoard.files.mainFiles.files.isEmpty { computerBoard.files.mainFiles.phase = .loading }
        if let at = computerBoard.files.mainFiles.workspaceGoneAt, !FileDeleteRules.keepsNote(setAt: at, now: .now) {
            computerBoard.files.mainFiles.workspaceGoneAt = nil
        }
        loadFiles(user.mainChannelId)
    }

    private func loadFiles(_ channelId: String) {
        computerRuntime.listTasks[channelId]?.cancel()
        computerRuntime.listTasks[channelId] = Task { [client] in
            let result = await Self.result { try await client.channelFiles(channelId: channelId) }
            guard !Task.isCancelled, !tornDown else { return }
            computerRuntime.listTasks[channelId] = nil
            switch result {
            case .success(let files):
                markOnline()
                applyFiles(FileLists.sorted(files), channelId: channelId)
            case .failure(let error):
                noteFailure(error)
                failFiles(TaskBoard.reason(for: error), channelId: channelId)
            }
        }
    }

    private func applyFiles(_ files: [ChannelFile], channelId: String) {
        if computerBoard.files.channelSheet?.channelId == channelId {
            computerBoard.files.channelSheet?.files = files
            computerBoard.files.channelSheet?.phase = .loaded
        }
        if channelId == user.mainChannelId {
            // In place, like the sheet's: a delete in flight and the M26 note survive a reload.
            computerBoard.files.mainFiles.files = files
            computerBoard.files.mainFiles.phase = .loaded
        }
    }

    /// Once loaded, a failed refresh keeps the list.
    private func failFiles(_ reason: String, channelId: String) {
        if computerBoard.files.channelSheet?.channelId == channelId, computerBoard.files.channelSheet?.files.isEmpty == true {
            computerBoard.files.channelSheet?.phase = .failed(reason: reason)
        }
        if channelId == user.mainChannelId, computerBoard.files.mainFiles.files.isEmpty {
            computerBoard.files.mainFiles.phase = .failed(reason: reason)
        }
    }

    /// A new file card or attachment joins the loaded lists of its channel. M26: a deleted one (the
    /// `message` event a delete sends, from any device) leaves them instead of being upserted.
    func noteFileMessage(_ message: Message) {
        let files = FileLists.files(in: message)
        guard !files.isEmpty else { return }
        for file in files {
            if file.isDeleted {
                removeFile(file.id, closingPreview: false)
                continue
            }
            if var sheet = computerBoard.files.channelSheet, sheet.channelId == file.channelId, sheet.phase == .loaded {
                sheet.files = FileLists.upsert(file, into: sheet.files)
                computerBoard.files.channelSheet = sheet
            }
            if file.channelId == user.mainChannelId, computerBoard.files.mainFiles.phase == .loaded {
                computerBoard.files.mainFiles.files = FileLists.upsert(file, into: computerBoard.files.mainFiles.files)
            }
        }
    }
}

/// The temporary copies the preview reads (Quick Look, the web view, Share).
enum ComputerFiles {
    struct Copy: Sendable {
        var file: ChannelFile
        var url: URL
        var directory: URL
    }

    static var root: URL {
        FileManager.default.temporaryDirectory.appending(path: "Previews", directoryHint: .isDirectory)
    }

    /// Downloads through the signed-in session; a file known only by id takes its name and
    /// type from the response.
    static func download(_ file: ChannelFile, known: Bool, client: APIClient) async throws -> Copy {
        var file = file
        let data: Data
        if known {
            data = try await client.data(for: file.url)
        } else {
            let content = try await client.fileContent(id: file.id)
            data = content.data
            if let name = content.name { file.name = name }
            if let mime = content.mime { file.mime = mime }
            file.size = content.data.count
        }
        return try write(data, for: file)
    }

    static func write(_ data: Data, for file: ChannelFile) throws -> Copy {
        let directory = root.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appending(path: FileNaming.localName(file.name, mime: file.mime), directoryHint: .notDirectory)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        return Copy(file: file, url: url, directory: directory)
    }

    static func remove(_ directory: URL) {
        try? FileManager.default.removeItem(at: directory)
    }

    /// Sign-out: every copy goes.
    static func removeAll() {
        try? FileManager.default.removeItem(at: root)
    }
}
