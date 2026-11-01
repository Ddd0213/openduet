// SSEParser against the WHATWG event-stream rules and the server's framing (docs/API.md "SSE").
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("SSE parser")
struct DataSSEParserTests {
    private func events(_ text: String, chunked size: Int = .max) -> [SSEParser.Output] {
        var parser = SSEParser()
        let bytes = Array(text.utf8)
        var out: [SSEParser.Output] = []
        var start = 0
        while start < bytes.count {
            let end = min(bytes.count, start + size)
            out += parser.push(contentsOf: bytes[start..<end])
            start = end
        }
        return out
    }

    @Test("id, event and data dispatch on a blank line")
    func dispatch() {
        let out = events("id: 104\nevent: message\ndata: {\"a\":1}\n\n")
        #expect(out == [.event(SSEEvent(id: "104", event: "message", data: "{\"a\":1}"))])
    }

    @Test("Multiple data lines join with a newline")
    func multiLineData() {
        #expect(events("data: one\ndata: two\ndata:\n\n") == [.event(SSEEvent(id: nil, event: "message", data: "one\ntwo\n"))])
    }

    @Test("Comment lines come out as heartbeats and never dispatch")
    func comments() {
        #expect(events(": ping\n\n:raw\n\n") == [.comment("ping"), .comment("raw")])
    }

    @Test("LF, CR and CRLF all end lines, also when CRLF is split across chunks", arguments: [1, 2, 3, 7, 1000])
    func lineEndings(chunk: Int) {
        // CRLF must count as one line ending, or "a" and "a2" would split into two events.
        let text = "id: 1\r\ndata: a\r\ndata: a2\r\n\r\nid: 2\rdata: b\r\rid: 3\ndata: c\n\n"
        let out = events(text, chunked: chunk)
        #expect(out == [
            .event(SSEEvent(id: "1", event: "message", data: "a\na2")),
            .event(SSEEvent(id: "2", event: "message", data: "b")),
            .event(SSEEvent(id: "3", event: "message", data: "c")),
        ])
    }

    @Test("The last id sticks for later events; an empty id clears it")
    func idPersistence() {
        let out = events("id: 7\ndata: a\n\ndata: b\n\nid\ndata: c\n\n")
        #expect(out.map { if case .event(let e) = $0 { e.id } else { "comment" } } == ["7", "7", nil])
    }

    @Test("A block without data dispatches nothing but keeps its id")
    func noData() {
        var parser = SSEParser()
        let out = parser.push(contentsOf: Array("id: 9\nevent: status\n\n".utf8))
        #expect(out.isEmpty)
        #expect(parser.lastEventId == "9")
        // The event type does not leak into the next event.
        #expect(parser.push(contentsOf: Array("data: x\n\n".utf8)) == [.event(SSEEvent(id: "9", event: "message", data: "x"))])
    }

    @Test("Only one leading space is removed; colons in values stay; a bare field name has an empty value")
    func fieldParsing() {
        #expect(events("data:  two spaces\n\n") == [.event(SSEEvent(id: nil, event: "message", data: " two spaces"))])
        #expect(events("data: a:b:c\n\n") == [.event(SSEEvent(id: nil, event: "message", data: "a:b:c"))])
        #expect(events("data\n\n") == [.event(SSEEvent(id: nil, event: "message", data: ""))])
    }

    @Test("Unknown fields and ids with NUL are ignored")
    func ignored() {
        var parser = SSEParser()
        let out = parser.push(contentsOf: Array("foo: bar\nid: 1\u{0}2\ndata: x\n\n".utf8))
        #expect(out == [.event(SSEEvent(id: nil, event: "message", data: "x"))])
    }

    @Test("retry: takes digits only")
    func retry() {
        var parser = SSEParser()
        _ = parser.push(contentsOf: Array("retry: 2500\n\nretry: 1s\n\n".utf8))
        #expect(parser.retryMilliseconds == 2500)
    }

    @Test("Multi-byte UTF-8 split across chunks decodes intact")
    func utf8Split() {
        #expect(events("data: 早上好，Claude 🎉\n\n", chunked: 1) == [.event(SSEEvent(id: nil, event: "message", data: "早上好，Claude 🎉"))])
    }

    @Test("A leading BOM is dropped")
    func bom() {
        #expect(events("\u{FEFF}data: x\n\n") == [.event(SSEEvent(id: nil, event: "message", data: "x"))])
    }

    @Test("An event cut off by the end of the stream is discarded")
    func truncated() {
        var parser = SSEParser()
        #expect(parser.push(contentsOf: Array("data: partial\n".utf8)).isEmpty)
        parser.finish()
        #expect(parser.push(contentsOf: Array("\n".utf8)).isEmpty)
    }

    @Test("A server frame decodes into a DuetEvent")
    func duetEvent() throws {
        let message = Fx.messageJSON("msg_1", at: 5, text: "On it.")
        let envelope: [String: Any] = ["id": 104, "type": "message", "channelId": "ch_main", "createdAt": Fx.iso(5), "payload": ["message": message]]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: envelope), as: UTF8.self)
        let out = events(": ping\n\nid: 104\nevent: message\ndata: \(json)\n\n")
        guard out.count == 2, case .event(let sse) = out[1] else {
            Issue.record("expected a comment and an event, got \(out)")
            return
        }
        let event = try JSONCoding.decoder().decode(DuetEvent.self, from: Data(sse.data.utf8))
        #expect(event.id == 104)
        guard case .message(let decoded) = event.body else {
            Issue.record("expected a message event")
            return
        }
        #expect(decoded.text == "On it.")
    }
}
