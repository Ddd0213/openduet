// Composer attachments (L179): uploaded one at a time with a progress ring; too large and
// unsupported types fail inline with Retry; removing an uploaded, unsent file deletes it on
// the server; sending takes the uploaded ones (ChatStore+Send). M21 (review C19): a task's
// "Reply to OpenDuet" has attachments too (TaskSession.attachments, uploaded to the task's
// channel); `attachmentTaskIds` says which task an attachment belongs to, the rest are the chat
// composer's. One queue serves both.
import Foundation

extension ChatStore {
    /// `taskId`: the open task's "Reply to OpenDuet" (nil = the chat composer).
    func addAttachments(_ files: [PickedFile], taskId: String? = nil) {
        guard !tornDown else { return }
        if let taskId, board.sessions[taskId] == nil { return }
        var added: [ComposerAttachment] = []
        for file in files {
            let id = UUID()
            uploadSources[id] = file
            if let taskId { attachmentTaskIds[id] = taskId }
            let upload: ComposerAttachment.Upload = file.data.count > UploadFileResponse.maxUploadBytes
                ? .failed(reason: Self.uploadFailure(APIError.tooLarge))
                : .uploading(progress: 0)
            added.append(ComposerAttachment(id: id, name: file.name, mime: file.mime, thumbnail: nil, upload: upload))
            if case .uploading = upload { uploadQueue.append(id) }
            if file.mime.hasPrefix("image/") { makeThumbnail(id: id, data: file.data) }
        }
        if let taskId {
            board.updateSession(taskId) { $0.attachments.append(contentsOf: added) }
        } else {
            composer.attachments.append(contentsOf: added)
        }
        pumpUploads()
    }

    func removeAttachment(_ id: UUID) {
        var removed: ComposerAttachment?
        updateAttachments(of: id) { list in
            guard let index = list.firstIndex(where: { $0.id == id }) else { return }
            removed = list.remove(at: index)
        }
        guard let attachment = removed else { return }
        uploadSources[id] = nil
        attachmentTaskIds[id] = nil
        uploadQueue.removeAll { $0 == id }
        if uploadTask?.id == id {
            uploadTask?.task.cancel()
            uploadTask = nil
            pumpUploads()
        }
        if case .uploaded(let file) = attachment.upload { deleteUploaded(file) }
    }

    func retryAttachment(_ id: UUID) {
        guard let source = uploadSources[id], source.data.count <= UploadFileResponse.maxUploadBytes else { return }
        var retried = false
        updateAttachments(of: id) { list in
            guard let index = list.firstIndex(where: { $0.id == id }), case .failed = list[index].upload else { return }
            list[index].upload = .uploading(progress: 0)
            retried = true
        }
        guard retried else { return }
        uploadQueue.append(id)
        pumpUploads()
    }

    /// M21: the task detail closes (or another task opens): its reply's attachments go like the
    /// chat composer's on a channel switch (uploads cancelled, uploaded files deleted).
    func discardTaskAttachments(_ taskId: String) {
        let ids = board.sessions[taskId]?.attachments.map(\.id) ?? []
        ids.forEach { removeAttachment($0) }
    }

    /// The list `id` is in: its task's reply composer, else the chat composer.
    private func updateAttachments(of id: UUID, _ body: (inout [ComposerAttachment]) -> Void) {
        if let taskId = attachmentTaskIds[id] {
            board.updateSession(taskId) { body(&$0.attachments) }
        } else {
            body(&composer.attachments)
        }
    }

    // MARK: - Upload queue

    private func pumpUploads() {
        guard !tornDown, uploadTask == nil, !uploadQueue.isEmpty else { return }
        let id = uploadQueue.removeFirst()
        guard let file = uploadSources[id] else { return pumpUploads() }
        // A task's reply uploads to the task's channel (the server checks the files are there).
        let channelId: String
        if let taskId = attachmentTaskIds[id] {
            guard let taskChannel = board.sessions[taskId]?.task?.summary.channelId else {
                finishUpload(id, .failed(reason: Self.uploadFailure(APIError.notFound)))
                return
            }
            channelId = taskChannel
        } else {
            channelId = reducer.channelId
        }
        let task = Task { [client] in
            do {
                let uploaded = try await client.upload(channelId: channelId, file: file) { [weak self] fraction in
                    Task { @MainActor [weak self] in self?.setProgress(id, fraction) }
                }
                finishUpload(id, .uploaded(uploaded))
            } catch is CancellationError {
                finishUpload(id, nil)
            } catch {
                noteFailure(error)
                finishUpload(id, .failed(reason: Self.uploadFailure(error)))
            }
        }
        uploadTask = (id, task)
    }

    private func setProgress(_ id: UUID, _ fraction: Double) {
        updateAttachments(of: id) { list in
            guard let index = list.firstIndex(where: { $0.id == id }),
                  case .uploading(let current) = list[index].upload,
                  fraction - current >= 0.02 || (fraction >= 1 && current < 1) else { return }
            list[index].upload = .uploading(progress: fraction)
        }
    }

    private func finishUpload(_ id: UUID, _ result: ComposerAttachment.Upload?) {
        if uploadTask?.id == id { uploadTask = nil }
        if let result {
            var found = false
            updateAttachments(of: id) { list in
                guard let index = list.firstIndex(where: { $0.id == id }) else { return }
                list[index].upload = result
                found = true
            }
            if found {
                if case .uploaded = result { markOnline() }
            } else if case .uploaded(let file) = result {
                // Removed while the last bytes went up.
                deleteUploaded(file)
            }
        }
        pumpUploads()
    }

    private func deleteUploaded(_ file: ChannelFile) {
        Task { [client] in try? await client.deleteFile(id: file.id) }
    }

    private func makeThumbnail(id: UUID, data: Data) {
        Task {
            let thumbnail = await Task.detached(priority: .utility) { Thumbnail.jpeg(from: data) }.value
            guard let thumbnail else { return }
            updateAttachments(of: id) { list in
                guard let index = list.firstIndex(where: { $0.id == id }) else { return }
                list[index].thumbnail = thumbnail
            }
        }
    }

    /// The inline reason under a failed thumbnail.
    static func uploadFailure(_ error: any Error) -> String {
        switch error as? APIError {
        case .tooLarge: String(localized: "Too large (25 MB max)")
        case .unsupportedType: String(localized: "This file type isn't supported")
        case .unreachable: String(localized: "Can't reach your server.")
        default: String(localized: "Couldn't upload")
        }
    }
}
