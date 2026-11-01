// M11 chat cards' state rules (pure Foundation, host-tested): the "Remembered · Undo" chip, the
// "Change how OpenDuet is?" card and the connection request card. Each phase comes from the card's
// own payload plus the tap in flight / failed in cardRequests[messageId] (and, for an app card,
// the Composio connect under RequestKey.connect(toolkit)), the same way the M6 cards read theirs.
import Foundation

// MARK: - memory_note

enum MemoryNotePhase: Hashable, Sendable {
    /// "Remembered · Undo" / "Forgot · Undo"
    case done
    /// Undo tapped: the chip reads "Undone" at once (optimistic) while the action is in flight
    case undoing
    case undone
    /// the undo failed: back to "… · Undo" with the reason under it
    case failed(reason: String)

    init(_ state: MemoryNotePayload.State, request: CardRequest?) {
        if state == .undone { self = .undone; return }
        switch request {
        case .inFlight: self = .undoing
        case .failed(let reason): self = .failed(reason: reason)
        case nil: self = .done
        }
    }

    /// The chip shows "Undone" (no Undo button).
    var readsUndone: Bool { self == .undoing || self == .undone }
    /// Undo can be tapped.
    var canUndo: Bool {
        switch self {
        case .done, .failed: true
        case .undoing, .undone: false
        }
    }
}

// MARK: - soul_proposal

enum SoulProposalPhase: Hashable, Sendable {
    case open
    case busy
    case failed(reason: String)
    case applied
    case dismissed

    init(_ state: SoulProposalPayload.State, request: CardRequest?) {
        switch state {
        case .applied: self = .applied
        case .dismissed: self = .dismissed
        case .open:
            switch request {
            case .inFlight: self = .busy
            case .failed(let reason): self = .failed(reason: reason)
            case nil: self = .open
            }
        }
    }

    /// Decided cards collapse to one line (tap shows the card again, read-only).
    var isDecided: Bool { self == .applied || self == .dismissed }
}

// MARK: - soul_setup (M22)

/// The "who OpenDuet is" card from the chat setup: the same phases as soul_proposal, plus
/// superseded (a newer card in the channel replaced it), which wins over any tap in flight.
enum SoulSetupPhase: Hashable, Sendable {
    case open
    case busy
    case failed(reason: String)
    case applied
    case dismissed
    case superseded

    /// M24: a state from a newer server (nil) shows read-only, like superseded.
    init(_ state: SoulSetupPayload.State?, request: CardRequest?) {
        switch state {
        case .superseded, nil: self = .superseded
        case .applied: self = .applied
        case .dismissed: self = .dismissed
        case .open:
            switch request {
            case .inFlight: self = .busy
            case .failed(let reason): self = .failed(reason: reason)
            case nil: self = .open
            }
        }
    }

    /// Applied / Not now fold to one line that shows the card again when tapped.
    var isDecided: Bool { self == .applied || self == .dismissed }
    /// Apply and Not now can be tapped.
    var canAct: Bool {
        switch self {
        case .open, .failed: true
        case .busy, .applied, .dismissed, .superseded: false
        }
    }
}

/// What a soul_setup row shows on each side of "now → new".
enum SoulSetupValue: Hashable, Sendable {
    /// the text as written
    case text(String)
    /// empty name: the assistant's own name
    case assistant
    /// empty "how to address you": the user's first name
    case firstName
    /// empty identity / persona / tone: the default
    case standard

    /// An empty (or blank) value reads as that field's default, as the server uses it.
    init(_ value: String, field: SoulProposalPayload.Field) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            self = .text(trimmed)
            return
        }
        switch field {
        case .name: self = .assistant
        case .addressAs: self = .firstName
        case .identity, .persona, .tone, .soulExtra: self = .standard
        }
    }
}

extension SoulSetupPayload {
    /// The card's rows: the global soul's fields in the payload's order (soulExtra is per channel
    /// and never set here; a row the server repeats shows once).
    var rows: [Field] {
        var seen = Set<SoulProposalPayload.Field>()
        return fields.filter { $0.field != .soulExtra && seen.insert($0.field).inserted }
    }
}

// MARK: - connection_request

enum ConnectionRequestPhase: Hashable, Sendable {
    case open
    /// Connect (or Not now) in flight; for an app card also while Composio's page is up
    case busy
    /// the reason under the fields (a 400 keeps the card open)
    case failed(reason: String)
    case connected
    case dismissed

    /// `connect`: an app card's cardRequests[RequestKey.connect(toolkit)] (nil for mcp / api_key).
    init(_ state: ConnectionRequestPayload.State, request: CardRequest?, connect: CardRequest? = nil) {
        switch state {
        case .connected: self = .connected
        case .dismissed: self = .dismissed
        case .open:
            if request == .inFlight || connect == .inFlight {
                self = .busy
            } else if case .failed(let reason) = request {
                self = .failed(reason: reason)
            } else if case .failed(let reason) = connect {
                self = .failed(reason: reason)
            } else {
                self = .open
            }
        }
    }

    /// The form shows (open, busy or failed): fields stay on screen through a failure.
    var showsForm: Bool {
        switch self {
        case .open, .busy, .failed: true
        case .connected, .dismissed: false
        }
    }
}

/// What the user typed into a connection card, until Connect. Secrets are dropped the moment
/// Connect is tapped (they live only in the one request) and everything is cleared once the card
/// connects; non-secret values stay so a 400 keeps the form filled.
struct ConnectionDraft: Hashable, Sendable {
    /// field key -> typed value
    var values: [String: String] = [:]
    /// mcp cards without a URL: the server address the user types
    var url = ""
    /// api_key cards without a domain: the domain the key is bound to
    var domain = ""

    /// The card asks for the server URL (an mcp card the assistant didn't fill in).
    static func needsURL(_ card: ConnectionRequestPayload) -> Bool {
        card.type == .mcp && (card.url ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The card asks for the domain (an api_key card the assistant didn't fill in).
    static func needsDomain(_ card: ConnectionRequestPayload) -> Bool {
        card.type == .apiKey && (card.domain ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func value(_ key: String) -> String { values[key] ?? "" }

    /// Connect is enabled: every field has a value (the server's create needs each header and the
    /// key), plus the URL / domain when the card asks for them. App cards connect through OAuth.
    func canSubmit(_ card: ConnectionRequestPayload) -> Bool {
        guard card.type != .app else { return true }
        if Self.needsURL(card), Self.trimmed(url).isEmpty { return false }
        if Self.needsDomain(card), Self.trimmed(domain).isEmpty { return false }
        return card.fields.allSatisfy { !Self.trimmed(value($0.key)).isEmpty }
    }

    /// The POST /api/messages/:id/connect body. Values are trimmed of surrounding whitespace (a
    /// pasted key often brings a newline); name / url / domain are sent only when the user typed them.
    func submission(for card: ConnectionRequestPayload) -> ConnectRequestSubmit {
        var typed: [String: String] = [:]
        for field in card.fields { typed[field.key] = Self.trimmed(value(field.key)) }
        return ConnectRequestSubmit(
            name: nil,
            url: Self.needsURL(card) ? Self.trimmed(url) : nil,
            domain: Self.needsDomain(card) ? Self.trimmed(domain) : nil,
            values: typed
        )
    }

    /// Connect was tapped: the secret values go (non-secret ones stay for a 400).
    mutating func dropSecrets(of card: ConnectionRequestPayload) {
        for field in card.fields where field.secret { values[field.key] = nil }
    }

    static func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The quiet line under a connection card's name: the server URL (mcp), the bound domain
/// (api_key), nothing for app cards (their logo says it).
enum ConnectionCardCopy {
    static func addressLine(_ card: ConnectionRequestPayload) -> String? {
        let raw: String? = switch card.type {
        case .mcp: card.url
        case .apiKey: card.domain
        case .app: nil
        }
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        // "https://mcp.example.com/mcp" reads as "mcp.example.com/mcp".
        for scheme in ["https://", "http://"] where trimmed.lowercased().hasPrefix(scheme) {
            return String(trimmed.dropFirst(scheme.count))
        }
        return trimmed
    }
}
