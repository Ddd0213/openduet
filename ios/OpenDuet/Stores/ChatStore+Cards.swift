// Card taps (L182): Approve / Not now on approval and spend request cards, card actions
// (suggestion Start / Hide, plate Done), chips that send text and alert buttons. The tap shows
// `.inFlight` in cardRequests[messageId] until the answer; TaskBoard turns the answer into card
// state (approval written into the card, 409 / 410 reload the card's thread, other failures
// leave the reason with Retry = the same call again).
import Foundation

extension ChatStore {
    /// M20: `always` also stores an Always rule for the card's `always` scope.
    func approveCard(messageId: String, approvalId: String, version: Int, always: Bool = false) {
        decide(messageId: messageId, approvalId: approvalId, version: version, approve: true, always: always)
    }

    func declineCard(messageId: String, approvalId: String, version: Int) {
        decide(messageId: messageId, approvalId: approvalId, version: version, approve: false, always: false)
    }

    private func decide(messageId: String, approvalId: String, version: Int, approve: Bool, always: Bool) {
        guard !tornDown, board.beginRequest(messageId) else { return }
        runTap(messageId, { [client] in
            approve
                ? try await client.approve(approvalId: approvalId, version: version, always: always)
                : try await client.decline(approvalId: approvalId, version: version)
        }) { store, result in
            let followUp = store.board.answerApproval(messageId: messageId, approvalId: approvalId, result, main: &store.reducer)
            if case .reload(let target) = followUp { store.reloadCardThread(target) }
        }
    }

    /// POST /api/messages/:id/action; the updated card is upserted where it is shown.
    func cardAction(messageId: String, action: MessageActionRequest.Action, itemId: String?) {
        guard !tornDown, board.beginRequest(messageId) else { return }
        let body = MessageActionRequest(action: action, itemId: itemId)
        runTap(messageId, { [client] in try await client.messageAction(messageId: messageId, body) }) { store, result in
            store.board.answerAction(messageId: messageId, result, main: &store.reducer)
        }
    }

    /// M12: a model_error card's Retry, or Switch model with the picked model. The card reads
    /// "Retrying…" while it runs; the answer is the card as `retrying` (a new failure posts a new
    /// card), a refusal (409: not open any more) shows its reason on the card.
    func retryModel(messageId: String, modelId: String?) {
        guard !tornDown, board.beginRequest(messageId) else { return }
        let body = MessageActionRequest(action: .retry, itemId: nil, modelId: modelId)
        runTap(messageId, { [client] in try await client.messageAction(messageId: messageId, body) }) { store, result in
            store.board.answerAction(messageId: messageId, result, main: &store.reducer)
        }
    }

    /// Chips that send text as the user (plate Draft / Book, "↪ Shorten", "Ask again"): a normal
    /// message in the main thread.
    func sendCardText(_ text: String) {
        send(text: text, attachmentIds: [], quoting: false)
    }

    /// Alert card buttons. open_url hands the link to openRoute (duet:// opens in the app; the
    /// UI shows http(s) links in its Safari sheet before calling this); open_connector and
    /// open_usage are M4 (OpenDuet sheet / Usage screen), open_browser is M6 (the assistant's computer).
    func openAlert(_ action: AlertPayload.Action) {
        switch action.type {
        case .openURL:
            guard let link = action.url, let url = URL(string: link) else { return }
            openRoute(url)
        case .openConnector:
            // The connector's detail sheet; without a toolkit, the OpenDuet sheet.
            if let toolkit = action.toolkit, !toolkit.isEmpty {
                openConnectorDetail(toolkit)
            } else {
                present(.assistant)
            }
        case .openUsage:
            present(.usage)
        case .openBrowser:
            openComputer()
        }
    }

    // MARK: - Helpers

    /// Runs one tap's request (cancelled on teardown) and hands its outcome to `answer` on the
    /// main actor; connectivity failures also show the offline bar.
    func runTap<T: Sendable>(
        _ id: String,
        _ request: @escaping @Sendable () async throws -> T,
        answer: @escaping @MainActor (ChatStore, Result<T, any Error>) -> Void
    ) {
        let token = UUID()
        let task = Task { [weak self] in
            let result = await Self.result(request)
            guard let self else { return }
            if self.cardTasks[id]?.token == token { self.cardTasks[id] = nil }
            guard !self.tornDown else { return }
            switch result {
            case .success: self.markOnline()
            case .failure(let error): self.noteFailure(error)
            }
            answer(self, result)
        }
        cardTasks[id] = (token, task)
    }
}
