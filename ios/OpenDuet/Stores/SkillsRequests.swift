// M6 (iOS 2): the chat extras' requests (prompt L156-L157). "/" loads the skills list (GET
// /api/skills, again each time the list opens so a skill saved from a proposal card shows up);
// long-press reactions are optimistic (PUT / DELETE, rolled back with a short grey line on
// failure); Good / Bad response posts feedback for the message ("Thanks for the feedback"
// arrives as a server system line).
import Foundation

extension ChatStore {
    // MARK: - Skills

    func loadSkills() {
        guard !tornDown, makeRuntime.skillsTask == nil else { return }
        makeBoard.extras.skillsLoading = true
        makeRuntime.skillsTask = Task { [client] in
            let result = await Self.result { try await client.skills() }
            makeRuntime.skillsTask = nil
            guard !Task.isCancelled, !tornDown else { return }
            makeBoard.extras.skillsLoading = false
            switch result {
            case .success(let skills):
                markOnline()
                makeBoard.extras.skills = skills
                makeBoard.extras.skillsFailure = nil
            case .failure(let error):
                noteFailure(error)
                // A list already shown stays; only a first load shows the reason.
                if makeBoard.extras.skills == nil { makeBoard.extras.skillsFailure = TaskBoard.reason(for: error) }
            }
        }
    }

    // MARK: - Reactions

    /// 👍 ❤️ ⭐ on / off: shown at once, then PUT / DELETE; the answer (the updated message) is
    /// upserted; a failure puts that emoji back and leaves a short reason under the bubble.
    func react(messageId: String, emoji: String, on: Bool) {
        guard !tornDown, let target = board.thread(containing: messageId, main: reducer) else { return }
        var wasOn = false
        updateThread(target) { thread in
            guard let message = thread.thread.messages.first(where: { $0.id == messageId }) else { return }
            wasOn = ReactionToggle.isOn(message.reactions, emoji: emoji)
            _ = thread.setReactions(ReactionToggle.toggled(message.reactions, emoji: emoji, on: on), messageId: messageId)
        }
        guard wasOn != on else { return }
        makeBoard.extras.failures[messageId] = nil
        let key = "\(messageId)|\(emoji)"
        makeRuntime.extraTasks[key]?.cancel()
        makeRuntime.extraTasks[key] = Task { [client] in
            let result = await Self.result { try await client.react(messageId: messageId, emoji: emoji, on: on) }
            guard !Task.isCancelled, !tornDown else { return }
            makeRuntime.extraTasks[key] = nil
            switch result {
            case .success(let message):
                markOnline()
                updateThread(target) { _ = $0.accept(message) }
            case .failure(let error):
                noteFailure(error)
                updateThread(target) { thread in
                    guard let current = thread.thread.messages.first(where: { $0.id == messageId }) else { return }
                    _ = thread.setReactions(ReactionToggle.toggled(current.reactions, emoji: emoji, on: !on), messageId: messageId)
                }
                noteExtraFailure(messageId, String(localized: "Couldn't update the reaction. \(TaskBoard.reason(for: error))"))
            }
        }
    }

    // MARK: - Feedback

    /// Good / Bad response: checked in the menu at once; POST /api/feedback with the message.
    func rate(messageId: String, _ rating: FeedbackRequest.Rating) {
        guard !tornDown, makeBoard.extras.ratings[messageId] != rating else { return }
        let before = makeBoard.extras.ratings[messageId]
        makeBoard.extras.ratings[messageId] = rating
        makeBoard.extras.failures[messageId] = nil
        let key = "\(messageId)|rate"
        makeRuntime.extraTasks[key]?.cancel()
        makeRuntime.extraTasks[key] = Task { [client] in
            let result = await Self.result { try await client.rate(messageId: messageId, rating) }
            guard !Task.isCancelled, !tornDown else { return }
            makeRuntime.extraTasks[key] = nil
            switch result {
            case .success:
                markOnline()
            case .failure(let error):
                noteFailure(error)
                makeBoard.extras.ratings[messageId] = before
                noteExtraFailure(messageId, String(localized: "Couldn't send the feedback. \(TaskBoard.reason(for: error))"))
            }
        }
    }

    /// The grey line under the bubble fades after a few seconds.
    private func noteExtraFailure(_ messageId: String, _ reason: String) {
        makeBoard.extras.failures[messageId] = reason
        let key = "\(messageId)|failure"
        makeRuntime.extraTasks[key]?.cancel()
        makeRuntime.extraTasks[key] = Task {
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled, !tornDown else { return }
            if makeBoard.extras.failures[messageId] == reason { makeBoard.extras.failures[messageId] = nil }
        }
    }
}
