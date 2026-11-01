// M11 chat side of the channel system: a connection_request card's Connect (POST
// /api/messages/:id/connect). Undo on a memory_note, Apply / Not now on a soul_proposal and Not
// now on a connection card use the existing card-action path (cardAction); an app card's Connect
// is the existing Composio flow (connect(toolkit:)). The typed values live only in this one
// request: never stored, logged or kept after it. M22: a soul_setup card's Apply / Not now take
// the same path as soul_proposal's (POST /api/messages/:id/action apply | dismiss, busy and the
// reason under cardRequests[messageId], the answer upserted where the card shows); the card
// itself tells the Who OpenDuet is page to load the soul again (SoulRevision).
import Foundation

extension ChatStore {
    /// ShellActions.submitConnection (cardRequests[messageId]): success upserts the connected
    /// card; a 400 leaves the server's reason and keeps the card open; a 409 reloads its thread.
    func submitConnection(messageId: String, _ body: ConnectRequestSubmit) {
        guard !tornDown, board.beginRequest(messageId) else { return }
        runTap(messageId, { [client] in try await client.submitConnection(messageId: messageId, body) }) { store, result in
            let followUp = store.board.answerConnection(messageId: messageId, result, main: &store.reducer)
            if case .reload(let target) = followUp { store.reloadCardThread(target) }
        }
    }
}
