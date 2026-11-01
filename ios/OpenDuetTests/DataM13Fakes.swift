// Voice call test doubles: a scripted provider socket (frames pushed by the test, the phone's
// frames recorded), a fake server (CallBackend), a clock whose waits return at once, and a
// speaker that only counts. No network and no audio.
import Foundation
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

struct ScriptedSocketClosed: Error {}

/// A provider socket the test drives: `push` a frame, `drop` it with a close code.
@MainActor
final class ScriptedSocket: LiveSocket {
    let request: URLRequest
    private(set) var sent: [String] = []
    private(set) var closedByPhone = false
    private(set) var closeCode = 0
    private(set) var closeReason = ""
    private var frames: [String] = []
    private var ended = false
    private var waiter: CheckedContinuation<String, any Error>?

    init(request: URLRequest) { self.request = request }

    /// Waiting for the next frame with none queued.
    var isWaiting: Bool { waiter != nil }
    var isOpen: Bool { !ended }

    func push(_ frame: String) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: frame)
        } else {
            frames.append(frame)
        }
    }

    func push(_ json: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])
        push(String(decoding: data, as: UTF8.self))
    }

    /// The provider closes the connection.
    func drop(code: Int, reason: String = "") {
        closeCode = code
        closeReason = reason
        finish()
    }

    func send(_ text: String) { sent.append(text) }

    /// Pings sent; answered at once unless `answersPings` is off (a dead network).
    private(set) var pings = 0
    var answersPings = true

    func ping(_ pong: @escaping @MainActor () -> Void) {
        pings += 1
        if answersPings { pong() }
    }

    func receive() async throws -> String {
        if !frames.isEmpty { return frames.removeFirst() }
        if ended { throw ScriptedSocketClosed() }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }

    func close() {
        closedByPhone = true
        finish()
    }

    private func finish() {
        ended = true
        if let waiter {
            self.waiter = nil
            waiter.resume(throwing: ScriptedSocketClosed())
        }
    }

    /// The phone's frames as JSON objects.
    var sentJSON: [[String: Any]] {
        sent.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
    }

    /// The `type` of each StepFun frame sent.
    var sentTypes: [String] { sentJSON.compactMap { $0["type"] as? String } }
}

/// Hands out the sockets a call opens, newest last. `dropAtOnce` closes each new one right away.
@MainActor
final class SocketLog {
    private(set) var sockets: [ScriptedSocket] = []
    var dropAtOnce: Int?

    var last: ScriptedSocket { sockets[sockets.count - 1] }

    var factory: LiveSocketFactory {
        { [unowned self] request in
            let socket = ScriptedSocket(request: request)
            sockets.append(socket)
            if let code = dropAtOnce { socket.drop(code: code) }
            return socket
        }
    }
}

struct FakeServerError: Error {}

/// The server's call routes, recorded.
@MainActor
final class FakeCallBackend: CallBackend {
    private(set) var starts: [StartCallRequest] = []
    private(set) var lineBatches: [[CallLine]] = []
    private(set) var tools: [CallToolRequest] = []
    private(set) var ends: [EndCallRequest] = []
    /// The answers to POST /api/calls, in order (the last repeats).
    var startAnswers: [StartCallResponse] = []
    /// POST /api/calls refuses (409, not_configured...).
    var startError: APIError?
    var duringStart: (() -> Void)?
    var toolAnswer: Result<String, APIError> = .success("Sent to Claude.")
    /// Awaited in each /tool before it answers (a test holds the answer back).
    var toolWait: (@MainActor () async -> Void)?
    var linesFail = false

    func startCall(_ body: StartCallRequest) async throws -> StartCallResponse {
        starts.append(body)
        // Something the user does while the request is out (a hang-up).
        duringStart?()
        if let startError { throw startError }
        guard !startAnswers.isEmpty else { throw APIError.unreachable }
        return startAnswers.count > 1 ? startAnswers.removeFirst() : startAnswers[0]
    }

    func sendCallLines(callId: String, _ lines: [CallLine]) async throws {
        if linesFail { throw APIError.unreachable }
        lineBatches.append(lines)
    }

    func callTool(callId: String, _ body: CallToolRequest) async throws -> CallToolResponse {
        tools.append(body)
        if let toolWait { await toolWait() }
        return CallToolResponse(result: try toolAnswer.get())
    }

    func endCall(callId: String, _ body: EndCallRequest) async throws -> Message {
        ends.append(body)
        return M13Fx.callMessage(callId: callId, seconds: body.seconds, lineCount: body.lines.count)
    }

    /// Every line the server got, in order.
    var allLines: [CallLine] { lineBatches.flatMap { $0 } + tools.flatMap(\.lines) + ends.flatMap(\.lines) }
}

/// Time stands still until a wait (which returns at once and moves it on) or `advance`.
@MainActor
final class FakeCallClock: CallClock {
    private(set) var now = Date(timeIntervalSince1970: 1_793_000_000)
    private(set) var sleeps: [Double] = []

    func sleep(seconds: Double) async throws {
        sleeps.append(seconds)
        now = now.addingTimeInterval(seconds)
    }

    func advance(_ seconds: Double) { now = now.addingTimeInterval(seconds) }
}

/// The speaker: counts what it was given; `drain` plays it all.
@MainActor
final class FakePlayback: CallPlayback {
    private(set) var played: [Data] = []
    private(set) var flushes = 0
    /// Every duck(_:) call, in order.
    private(set) var ducks: [Bool] = []
    private var waiting: [@MainActor () -> Void] = []

    var ducked: Bool { ducks.last ?? false }

    var queued: Int { waiting.count }

    func play(_ pcm: Data, rate: Int, done: @escaping @MainActor () -> Void) {
        played.append(pcm)
        waiting.append(done)
    }

    func duck(_ on: Bool) { ducks.append(on) }

    func flush() {
        flushes += 1
        let dropped = waiting
        waiting = []
        dropped.forEach { $0() }
    }

    func drain() {
        let finished = waiting
        waiting = []
        finished.forEach { $0() }
    }
}

/// One call under test: the core with all its fakes.
@MainActor
final class CallRig {
    let backend = FakeCallBackend()
    let clock = FakeCallClock()
    let playback = FakePlayback()
    let sockets = SocketLog()
    let core: CallCore
    private(set) var readyCount = 0
    private(set) var ended: [Message?] = []

    init(_ codec: any VoiceCodec) {
        let counter = LineIds()
        core = CallCore(codec: codec, backend: backend, clock: clock, playback: playback,
                        makeLineId: { counter.next() }, openSocket: sockets.factory)
        core.onReady = { [unowned self] in
            readyCount += 1
            core.micStarted()
        }
        core.onEnded = { [unowned self] in ended.append($0) }
    }

    var socket: ScriptedSocket { sockets.last }

    func begin(_ started: StartCallResponse, channelId: String = "ch_shop") {
        core.begin(started, channelId: channelId, language: "en")
    }

    /// Lets the core take in everything pushed so far (and finish its requests).
    func settle() async {
        for _ in 0..<200 {
            await Task.yield()
            await core.settle()
            let busy = sockets.sockets.contains { $0.isOpen && !$0.isWaiting }
            if !busy { break }
            try? await Task.sleep(for: .milliseconds(1))
        }
        await Task.yield()
    }

    /// Waits (briefly, in real time) until `condition` holds.
    func until(_ condition: () -> Bool) async {
        for _ in 0..<500 where !condition() {
            await Task.yield()
            await core.settle()
            try? await Task.sleep(for: .milliseconds(2))
        }
    }
}

/// Stable line ids for the tests ("line-1", "line-2", …).
final class LineIds: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func next() -> String {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return "line-\(count)"
    }
}

enum M13Fx {
    static var tools: [[String: Any]] {[
        ["name": "send_to_assistant", "description": "Pass the user's request to OpenDuet, which does the work.",
         "parameters": ["type": "object", "properties": ["text": ["type": "string", "description": "What to ask OpenDuet, in full sentences."]], "required": ["text"]]],
        ["name": "assistant_status", "description": "Check whether OpenDuet is working on something in this channel.",
         "parameters": ["type": "object", "properties": [String: Any]()]],
    ]}

    static func started(_ engine: VoiceEngineKind, secret: String, callId: String = "call_1") -> StartCallResponse {
        let gemini = engine == .gemini
        let credential: [String: Any] = gemini
            ? ["kind": "token", "value": secret, "expiresAt": "2026-11-02T18:30:00.000Z"]
            : ["kind": "key", "value": secret]
        let json: [String: Any] = [
            "call": [
                "id": callId, "channelId": "ch_shop", "engine": engine.rawValue, "modelEntryId": "mdl_1",
                "modelId": gemini ? "gemini-live-2.5-flash-preview" : "step-audio-2",
                "voice": gemini ? "Puck" : "qingchunshaonv", "status": "open",
                "startedAt": "2026-11-02T18:00:00.000Z", "endedAt": NSNull(), "seconds": 0, "title": "",
            ],
            "model": gemini ? "gemini-live-2.5-flash-preview" : "step-audio-2",
            "url": gemini
                ? "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained"
                : "wss://api.stepfun.com/v1/realtime?model=step-audio-2",
            "credential": credential,
            "instructions": "You relay for Claude.",
            "tools": tools,
        ]
        return Fx.decode(StartCallResponse.self, json)
    }

    static func callMessage(callId: String, seconds: Int, lineCount: Int, title: String = "") -> Message {
        Fx.decode(Message.self, [
            "id": "msg_\(callId)", "channelId": "ch_shop", "taskId": NSNull(), "status": "sent", "clientId": NSNull(),
            "reactions": [], "stopped": false, "role": "system", "kind": "call", "text": "",
            "payload": ["callId": callId, "seconds": seconds, "title": title, "lineCount": lineCount],
            "callId": NSNull(), "createdAt": "2026-11-02T18:03:12.000Z", "updatedAt": "2026-11-02T18:03:12.000Z",
        ])
    }

    static func cue(_ kind: String, _ text: String, seq: Int64, callId: String = "call_1") -> CallCue {
        Fx.decode(CallCue.self, ["callId": callId, "kind": kind, "text": text, "seq": seq])
    }

    /// Whether `secret` can be found anywhere in `value`'s stored properties (through enums,
    /// structs, optionals, collections and the classes it holds, such as its socket). The
    /// injected server (`backend`: in the app the API client, which keeps no answers; here the
    /// fake that scripts them) isn't the call's memory and is skipped.
    @MainActor
    static func holds(_ secret: String, in value: Any) -> Bool {
        var seen = Set<ObjectIdentifier>()
        return search(secret, value, depth: 0, seen: &seen)
    }

    private static let skipped: Set<String> = ["backend"]

    @MainActor
    private static func search(_ secret: String, _ value: Any, depth: Int, seen: inout Set<ObjectIdentifier>) -> Bool {
        guard depth < 24 else { return false }
        switch value {
        case let credential as VoiceCredential: return credential.secret.contains(secret)
        case let text as String: return text.contains(secret)
        case let request as URLRequest:
            if request.url?.absoluteString.contains(secret) == true { return true }
            return (request.allHTTPHeaderFields ?? [:]).values.contains { $0.contains(secret) }
        case let url as URL: return url.absoluteString.contains(secret)
        default: break
        }
        let mirror = Mirror(reflecting: value)
        if mirror.displayStyle == .class {
            let id = ObjectIdentifier(value as AnyObject)
            guard seen.insert(id).inserted else { return false }
        }
        var current: Mirror? = mirror
        while let level = current {
            for child in level.children where !skipped.contains(child.label ?? "") {
                if search(secret, child.value, depth: depth + 1, seen: &seen) { return true }
            }
            current = level.superclassMirror
        }
        return false
    }
}
