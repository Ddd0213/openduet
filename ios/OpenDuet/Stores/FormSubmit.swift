// M9 (contract §2): a form card's Submit and Skip on the store side. Submit shows at once: the
// card turns submitted with the answers and a pending user bubble shows the summary; then the
// summary goes out as a normal SendMessageRequest with `.form`, in the thread the card is in.
// A refusal (400) opens the card again with the reason; 409 (the card isn't open any more)
// fetches its thread again; offline it waits like any queued message. Foundation + models only,
// so the Mac host tests drive it.
import Foundation

/// A form card as it was before an optimistic Submit / Skip (the rollback).
struct FormSnapshot: Hashable, Sendable {
    var payload: FormPayload
    var updatedAt: Date
}

/// Form submissions waiting for the server, by the pending message's clientId.
struct FormSubmits: Sendable {
    struct Entry: Hashable, Sendable {
        var messageId: String
        var answers: [FormAnswer]
        var before: FormSnapshot
        /// the thread pinned at submit (the chat thread as its channel), for the rollback
        var thread: ThreadRef
    }

    /// What a failed send of a submission means for the card.
    enum Outcome: Hashable, Sendable {
        /// offline / signing out: the bubble keeps waiting, the card stays submitted
        case wait
        /// 409, or the stream ended without an answer: fetch the card's thread again
        case reload
        /// refused: the card opens again with this reason; the bubble goes
        case rollBack(reason: String)
    }

    private(set) var entries: [String: Entry] = [:]

    mutating func add(clientId: String, _ entry: Entry) {
        entries[clientId] = entry
    }

    func entry(_ clientId: String) -> Entry? {
        entries[clientId]
    }

    /// The pending message of a form card already on its way, if any.
    func clientId(for messageId: String) -> String? {
        entries.first { $0.value.messageId == messageId }?.key
    }

    /// The server echoed the message (accepted) or the submission ended otherwise.
    @discardableResult
    mutating func finish(_ clientId: String) -> Entry? {
        entries.removeValue(forKey: clientId)
    }

    mutating func removeAll() {
        entries = [:]
    }

    /// The form field of the request for this pending message (nil = an ordinary message).
    func submission(_ clientId: String) -> SendMessageRequest.FormSubmission? {
        entries[clientId].map { SendMessageRequest.FormSubmission(messageId: $0.messageId, answers: $0.answers) }
    }

    static func outcome(for error: any Error) -> Outcome {
        if error is CancellationError { return .wait }
        guard let api = error as? APIError else { return .rollBack(reason: TaskBoard.reason(for: error)) }
        if api.isConnectivity || api == .unauthorized { return .wait }
        if api.isConflict || api == .expired { return .reload }
        if case .validationFailed = api { return .rollBack(reason: String(localized: "Check your answers and try again.")) }
        return .rollBack(reason: api.localizedReason)
    }
}
