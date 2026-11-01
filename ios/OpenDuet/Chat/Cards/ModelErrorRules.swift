// M12 model_error card's state (pure Foundation, host-tested): the phase from the card's own
// payload plus the tap in flight / failed in cardRequests[messageId], like the M11 cards.
import Foundation

enum ModelErrorPhase: Hashable, Sendable {
    /// Retry / Switch model (or Set up models when there's nothing to retry with)
    case open
    /// Retry tapped: the card reads "Retrying…" at once (optimistic) while the action is in flight
    case retrying
    /// the retry failed: the buttons are back with the reason
    case failed(reason: String)
    /// the server took the retry (a new failure posts a new card): the phrase line only
    case retried
    case dismissed

    init(_ payload: ModelErrorPayload, request: CardRequest?) {
        switch payload.state {
        case .retrying: self = .retried
        case .dismissed: self = .dismissed
        case .open:
            switch request {
            case .inFlight: self = .retrying
            case .failed(let reason): self = .failed(reason: reason)
            case nil: self = .open
            }
        }
    }

    /// The card folds to its phrase line (a retry under way, taken or dismissed).
    var isCollapsed: Bool {
        switch self {
        case .retrying, .retried, .dismissed: true
        case .open, .failed: false
        }
    }

    /// The buttons can be tapped.
    var canAct: Bool {
        switch self {
        case .open, .failed: true
        case .retrying, .retried, .dismissed: false
        }
    }
}

enum ModelErrorCopy {
    /// "Set up models" instead of Retry / Switch model: the server has nothing to retry with.
    static func needsSetup(_ payload: ModelErrorPayload) -> Bool { !payload.retry }

    /// The model's name as the caption, nil without one.
    static func caption(_ payload: ModelErrorPayload) -> String? {
        let label = (payload.modelLabel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return label.isEmpty ? nil : label
    }

    /// Switch model's list: the usable chat models, the one that failed last.
    static func switchOptions(_ state: ModelsState, failed: String?) -> [ModelEntry] {
        let usable = ModelCatalog.usableChatModels(state)
        return usable.filter { $0.id != failed } + usable.filter { $0.id == failed }
    }
}
