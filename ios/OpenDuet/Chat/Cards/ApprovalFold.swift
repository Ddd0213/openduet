// What an approval card shows (prompt L182, M8 brief §4), pure Foundation so it is host-tested:
// its phase (pending / busy / failed / done / declined / expired) and its fold. After a success
// the card plays the green check in place, then about 1.2 s later folds to one grey summary line
// ("✓ Run commands · Done ›"); Not now folds at once; a tap opens it again. Cards already done
// or declined when the thread loads start folded.
import Foundation

enum ApprovalPhase: Hashable, Sendable {
    case pending, busy, done, declined, expired
    /// The reason: a local tap's (already localized) or the server's result phrase.
    case failed(reason: String?, phrase: Phrase?)

    init(approval: Approval, request: CardRequest?, now: Date) {
        switch approval.status {
        case .approved:
            if let result = approval.result, !result.ok {
                self = .failed(reason: nil, phrase: result.error)
            } else {
                self = .done
            }
        case .declined:
            self = .declined
        case .expired:
            self = .expired
        case .pending:
            if let expiresAt = approval.expiresAt, expiresAt <= now {
                self = .expired
            } else {
                switch request {
                case .inFlight: self = .busy
                case .failed(let reason): self = .failed(reason: reason, phrase: nil)
                case nil:
                    if let result = approval.result, !result.ok {
                        self = .failed(reason: nil, phrase: result.error)
                    } else {
                        self = .pending
                    }
                }
            }
        }
    }

    /// Done or declined: the card can rest as one summary line.
    var isSettled: Bool { self == .done || self == .declined }

    var isFailed: Bool {
        if case .failed = self { true } else { false }
    }
}

enum ApprovalFold: Hashable, Sendable {
    /// the whole card
    case open
    /// just succeeded: the whole card with the drawn check, folding by itself soon
    case celebrating
    /// one grey summary line; a tap opens it
    case folded

    /// How long the success moment stays before the card folds.
    static let celebrationSeconds: Double = 1.2

    /// The fold of a card as it mounts (a thread load, a scroll back): settled cards rest folded.
    static func start(_ phase: ApprovalPhase) -> ApprovalFold {
        phase.isSettled ? .folded : .open
    }

    /// The phase changed while the card is on screen.
    func next(after phase: ApprovalPhase) -> ApprovalFold {
        switch phase {
        case .done: self == .folded ? .folded : .celebrating
        case .declined: .folded
        default: .open
        }
    }

    /// The celebration ran its time.
    var afterCelebration: ApprovalFold { self == .celebrating ? .folded : self }

    /// A tap on the summary line opens the card; a tap on an open settled card's outcome folds it.
    var toggled: ApprovalFold { self == .folded ? .open : .folded }

    var isFolded: Bool { self == .folded }
}
