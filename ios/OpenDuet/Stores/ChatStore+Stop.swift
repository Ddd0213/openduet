// M10 stop responding (contract §1): ■ in the composer stops the assistant's reply in that thread. The
// main thread or a channel calls POST /api/channels/:id/stop, a task's "Reply to OpenDuet" calls
// POST /api/tasks/:id/stop. The typing dots and the live status go at once (ThreadReducer /
// TaskSession beginStop); the server's `done` (cancelled) and the partial text's `message`
// (stopped: true) follow as usual. A 409 means nothing was running any more and stays silent;
// any other failure brings the reply's dots back and shows its reason by the composer for a few
// seconds. Messages queued behind the stopped turn still run (the server's rule).
import Foundation

/// The chat thread's failed stop: which channel it was for, and why.
struct ThreadStopFailure: Hashable, Sendable {
    var channelId: String
    var reason: String
}

extension ChatStore {
    /// How long a failed stop's reason stays by the composer.
    static let stopFailureSeconds: Double = 6

    /// ■ in the chat composer: the selected channel's (or the main thread's) own chat turns.
    func stopReply() {
        guard !tornDown else { return }
        let channelId = reducer.channelId
        guard !channelId.isEmpty else { return }
        let key = "ch:\(channelId)"
        clearStopFailure(key)
        let hidden = reducer.beginStop()
        stopTasks[key]?.cancel()
        stopTasks[key] = Task { [weak self, client] in
            let result = await Self.result { try await client.stopChannel(id: channelId) }
            guard let self, !Task.isCancelled, !self.tornDown else { return }
            self.stopTasks[key] = nil
            switch result {
            case .success:
                self.markOnline()
            case .failure(let error):
                self.noteFailure(error)
                guard let reason = ThreadReducer.stopFailure(for: error) else { return }
                // Back in the thread it was for (parked if the user switched channels meanwhile).
                self.updateThread(.channel(channelId)) { $0.resumeStop(hidden) }
                self.stopFailure = ThreadStopFailure(channelId: channelId, reason: reason)
                self.scheduleStopFailureClear(key)
            }
        }
    }

    /// ■ in the open task detail's "Reply to OpenDuet": that task's own session.
    func stopTaskReply() {
        guard !tornDown, let taskId = board.openTaskId else { return }
        let key = "task:\(taskId)"
        clearStopFailure(key)
        var hidden = Set<String>()
        board.updateSession(taskId) { hidden = $0.beginStop() }
        stopTasks[key]?.cancel()
        stopTasks[key] = Task { [weak self, client] in
            let result = await Self.result { try await client.stopTask(id: taskId) }
            guard let self, !Task.isCancelled, !self.tornDown else { return }
            self.stopTasks[key] = nil
            switch result {
            case .success:
                self.markOnline()
            case .failure(let error):
                self.noteFailure(error)
                guard let reason = ThreadReducer.stopFailure(for: error) else { return }
                self.board.updateSession(taskId) { $0.resumeStop(hidden, failure: reason) }
                self.scheduleStopFailureClear(key)
            }
        }
    }

    // MARK: - The failure line

    private func clearStopFailure(_ key: String) {
        stopFailureTasks[key]?.cancel()
        stopFailureTasks[key] = nil
        if key.hasPrefix("ch:") {
            stopFailure = nil
        } else if key.hasPrefix("task:") {
            board.updateSession(String(key.dropFirst(5))) { $0.stopFailure = nil }
        }
    }

    private func scheduleStopFailureClear(_ key: String) {
        stopFailureTasks[key]?.cancel()
        stopFailureTasks[key] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.stopFailureSeconds))
            guard let self, !Task.isCancelled else { return }
            self.stopFailureTasks[key] = nil
            self.clearStopFailure(key)
        }
    }
}
