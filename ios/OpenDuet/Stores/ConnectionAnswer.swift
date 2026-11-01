// M11: the answer of a connection card's Connect (POST /api/messages/:id/connect), in the same
// cardRequests[messageId] the card's other taps use. Success upserts the connected card. A 400
// (the server couldn't verify the connector) keeps the card open with the server's own reason
// under the fields. A 409 means the card was answered meanwhile (another device, or the account
// turned active): the card's thread is fetched again. Pure Foundation (host-tested).
import Foundation

enum ConnectionAnswer {
    /// The line under the fields: a 400 says the server's reason in its words; a 409 that the
    /// card isn't open any more; anything else the usual reason.
    static func reason(for error: any Error) -> String {
        switch error as? APIError {
        case .validationFailed(_, let message)? where !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
            return message
        case let api? where isConflict(api):
            return String(localized: "This card was already answered.")
        default:
            return TaskBoard.reason(for: error)
        }
    }

    /// 409 conflict (the card isn't open), whichever way the client mapped it.
    static func isConflict(_ error: APIError) -> Bool {
        switch error {
        case .staleVersion: true
        case .server(let status, let code): status == 409 || code == "conflict"
        default: false
        }
    }
}

extension TaskBoard {
    /// Connect's answer for the card `messageId`. Returns a reload of the card's thread for a 409.
    mutating func answerConnection(messageId: String, _ result: Result<Message, any Error>, main: inout ThreadReducer) -> CardFollowUp {
        switch result {
        case .success(let message):
            clearRequest(messageId)
            accept(message, main: &main)
            return .nothing
        case .failure(let error) where error is CancellationError:
            clearRequest(messageId)
            return .nothing
        case .failure(let error):
            failRequest(messageId, reason: ConnectionAnswer.reason(for: error))
            if let api = error as? APIError, ConnectionAnswer.isConflict(api) {
                return .reload(thread(containing: messageId, main: main) ?? .main)
            }
            return .nothing
        }
    }
}
