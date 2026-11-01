// The assistant's computer as the app sees it (backend/src/contract/computer.ts). The app never
// talks to the computer or sees its token: the backend proxies everything.
import Foundation

/// GET /api/computer and the "computer" event.
struct ComputerState: Decodable, Hashable, Sendable {
    enum Browser: String, Decodable, Sendable { case off, starting, ready }
    /// Who drives the browser: the assistant, or the user after Take over.
    enum Controller: String, AssistantValue, Sendable { case assistant, user }
    enum Blocker: String, Decodable, Sendable { case humanCheck = "human_check" }
    var available: Bool
    var browser: Browser
    var controller: Controller
    var url: String?
    var domain: String?
    var blocked: Blocker?
}

/// POST /api/computer/take, /release and M20's /sleep (409 computer_busy while in use).
struct ComputerControlResponse: Decodable, Sendable {
    var computer: ComputerState
}

/// POST /api/computer/sign-in/:requestId. Never logged, stored or kept after sending.
struct SignInCardRequest: Codable, Hashable, Sendable {
    var email: String
    var password: String
}

/// M20: which form a pending sign-in card shows; the code field comes only after the site asks.
enum SignInStep: String, Decodable, Hashable, Sendable {
    case credentials, code
    /// An unknown step from a newer server keeps the card on its first form.
    init(from decoder: Decoder) throws {
        self = SignInStep(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .credentials
    }
}

/// M20: how a card the user took over ("Take control instead") or dismissed ("Not now") ended.
enum SignInCardOutcome: String, Decodable, Hashable, Sendable {
    case takenOver = "taken_over"
    case dismissed
}

/// POST /api/computer/sign-in/:requestId/code: the verification code the site asked for.
/// Like the password, it lives only in this request body and is never stored or logged.
struct SignInCodeRequest: Codable, Hashable, Sendable {
    var code: String
}

/// Answer of every sign-in card action: submit, /code, /take-over and /dismiss (M20).
struct SignInCardResponse: Decodable, Hashable, Sendable {
    enum State: String, Decodable, Sendable { case sent, failed, expired }
    var requestId: ID
    var state: State
    /// M20: "sent" with step .code = the site wants a verification code next.
    var step: SignInStep = .credentials
    /// M20: why it failed (wrong page, the sign-in moved to another site, the code was refused).
    var reason: Phrase?
    /// M20: set by /take-over and /dismiss (state .expired).
    var outcome: SignInCardOutcome?
    /// M20: /take-over answers with the computer, now in the user's hands.
    var computer: ComputerState?
}

extension SignInCardResponse {
    private enum CodingKeys: String, CodingKey { case requestId, state, step, reason, outcome, computer }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(ID.self, forKey: .requestId)
        state = try c.decode(State.self, forKey: .state)
        step = try c.decodeIfPresent(SignInStep.self, forKey: .step) ?? .credentials
        reason = try c.decodeIfPresent(Phrase.self, forKey: .reason)
        outcome = try? c.decodeIfPresent(SignInCardOutcome.self, forKey: .outcome)
        computer = try c.decodeIfPresent(ComputerState.self, forKey: .computer)
    }
}

/// App -> server over WebSocket /api/computer/stream while the user is in control.
/// Coordinates are 0...1 fractions of the frame.
enum ComputerClientMessage: Codable, Hashable, Sendable {
    struct Point: Codable, Hashable, Sendable {
        var x: Double
        var y: Double
    }
    enum Key: String, Codable, Sendable {
        case enter = "Enter", backspace = "Backspace", tab = "Tab", escape = "Escape"
        case arrowUp = "ArrowUp", arrowDown = "ArrowDown", arrowLeft = "ArrowLeft", arrowRight = "ArrowRight"
    }

    case tap(Point)
    case drag(from: Point, to: Point)
    case scroll(dx: Double, dy: Double)
    case text(String)
    case key(Key)

    private enum CodingKeys: String, CodingKey { case type, x, y, from, to, dx, dy, text, key }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "tap": self = .tap(try Point(from: decoder))
        case "drag": self = .drag(from: try c.decode(Point.self, forKey: .from), to: try c.decode(Point.self, forKey: .to))
        case "scroll": self = .scroll(dx: try c.decode(Double.self, forKey: .dx), dy: try c.decode(Double.self, forKey: .dy))
        case "text": self = .text(try c.decode(String.self, forKey: .text))
        case "key": self = .key(try c.decode(Key.self, forKey: .key))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown client message \(other)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .tap(point):
            try c.encode("tap", forKey: .type)
            try c.encode(point.x, forKey: .x)
            try c.encode(point.y, forKey: .y)
        case let .drag(from, to):
            try c.encode("drag", forKey: .type)
            try c.encode(from, forKey: .from)
            try c.encode(to, forKey: .to)
        case let .scroll(dx, dy):
            try c.encode("scroll", forKey: .type)
            try c.encode(dx, forKey: .dx)
            try c.encode(dy, forKey: .dy)
        case let .text(text):
            try c.encode("text", forKey: .type)
            try c.encode(text, forKey: .text)
        case let .key(key):
            try c.encode("key", forKey: .type)
            try c.encode(key, forKey: .key)
        }
    }
}

/// Server -> app JSON text frames on the stream (binary frames are JPEG screen frames).
enum ComputerServerMessage: Decodable, Hashable, Sendable {
    case state(ComputerState)
    case frameMeta(width: Int, height: Int)
    /// M27 browser: the full-screen view's tab strip and address bar, when they changed.
    case browserBar(BrowserBar)

    private enum CodingKeys: String, CodingKey { case type, computer, width, height, bar }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "state": self = .state(try c.decode(ComputerState.self, forKey: .computer))
        case "frame_meta": self = .frameMeta(width: try c.decode(Int.self, forKey: .width), height: try c.decode(Int.self, forKey: .height))
        case "browser_bar": self = .browserBar(try c.decode(BrowserBar.self, forKey: .bar))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown server message \(other)")
        }
    }
}
