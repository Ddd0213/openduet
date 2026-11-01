// Server-sent events, parsed per the WHATWG event-stream rules: lines end in LF, CR or CRLF;
// "field: value" lines build an event that a blank line dispatches; lines starting with ":"
// are comments (the server's ": ping" heartbeat). Bytes are pushed one at a time so it works
// on URLSession.AsyncBytes and in the Mac host tests alike. Foundation only.
import Foundation

struct SSEEvent: Hashable, Sendable {
    /// The `id:` in effect when the event was dispatched (the stream's last event id).
    var id: String?
    /// `event:`; "message" when the stream didn't name it.
    var event: String
    /// The `data:` lines joined with "\n".
    var data: String
}

struct SSEParser: Sendable {
    enum Output: Hashable, Sendable {
        case event(SSEEvent)
        /// A comment line such as ": ping"; text after the colon, one leading space removed.
        case comment(String)
    }

    /// The last `id:` seen; it sticks for later events until changed (or cleared by an empty id).
    private(set) var lastEventId: String?
    /// The server's `retry:` reconnection time in milliseconds, if it sent one.
    private(set) var retryMilliseconds: Int?

    private var buffer: [UInt8] = []
    private var afterCR = false
    private var atStreamStart = true
    private var eventType = ""
    private var dataLines: [String] = []
    private var hasData = false

    init() {}

    /// Feeds one byte; returns what a completed line produced, if anything.
    mutating func push(_ byte: UInt8) -> Output? {
        if afterCR {
            afterCR = false
            if byte == 0x0A { return nil }
        }
        switch byte {
        case 0x0D:
            afterCR = true
            return endLine()
        case 0x0A:
            return endLine()
        default:
            buffer.append(byte)
            return nil
        }
    }

    /// Feeds a chunk; returns everything it completed, in order.
    mutating func push<S: Sequence>(contentsOf bytes: S) -> [Output] where S.Element == UInt8 {
        var out: [Output] = []
        for byte in bytes { if let o = push(byte) { out.append(o) } }
        return out
    }

    private mutating func endLine() -> Output? {
        var bytes = buffer
        buffer.removeAll(keepingCapacity: true)
        if atStreamStart {
            atStreamStart = false
            if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes.removeFirst(3) }
        }
        return feed(line: String(decoding: bytes, as: UTF8.self))
    }

    /// Processes one complete line (without its line ending).
    mutating func feed(line: String) -> Output? {
        if line.isEmpty { return dispatch() }
        if line.hasPrefix(":") { return .comment(Self.dropLeadingSpace(line.dropFirst())) }

        let field: Substring
        let value: String
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = Self.dropLeadingSpace(line[line.index(after: colon)...])
        } else {
            field = line[...]
            value = ""
        }
        switch field {
        case "event": eventType = value
        case "data":
            dataLines.append(value)
            hasData = true
        case "id":
            if !value.contains("\0") { lastEventId = value.isEmpty ? nil : value }
        case "retry":
            if !value.isEmpty, value.utf8.allSatisfy({ (0x30...0x39).contains($0) }), let ms = Int(value) {
                retryMilliseconds = ms
            }
        default: break
        }
        return nil
    }

    /// End of the stream: an event without its closing blank line is discarded (per spec).
    mutating func finish() {
        buffer.removeAll()
        eventType = ""
        dataLines.removeAll()
        hasData = false
    }

    private mutating func dispatch() -> Output? {
        defer {
            eventType = ""
            dataLines.removeAll()
            hasData = false
        }
        guard hasData else { return nil }
        return .event(SSEEvent(id: lastEventId, event: eventType.isEmpty ? "message" : eventType, data: dataLines.joined(separator: "\n")))
    }

    private static func dropLeadingSpace(_ s: Substring) -> String {
        String(s.hasPrefix(" ") ? s.dropFirst() : s)
    }
}
