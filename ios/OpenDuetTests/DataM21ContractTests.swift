// M21 contract: a time read from the server goes back with the same millisecond (the unread badge
// that never cleared: ".601Z" was sent back as ".600Z"); the new event fields decode and an
// unknown run kind or resync reason doesn't fail the event.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M21 contract")
struct DataM21ContractTests {
    @Test("A parsed time re-encodes to the same millisecond", arguments: [
        "2026-10-28T09:41:01.601Z", "2026-10-28T09:41:01.600Z", "2026-10-28T09:41:01.999Z",
        "2026-10-28T09:41:01.000Z", "2026-12-31T23:59:59.001Z", "1970-01-01T00:00:00.007Z",
    ])
    func millisecondsSurvive(_ text: String) throws {
        let date = try #require(JSONCoding.parseDate(text))
        #expect(JSONCoding.formatDate(date) == text)
        let body = try JSONCoding.encoder().encode(MarkReadRequest(at: date, messageId: "msg_1"))
        let json = try #require(String(data: body, encoding: .utf8))
        #expect(json.contains("\"\(text)\""))
    }

    @Test("A time without milliseconds gets .000; one between milliseconds rounds to the nearest")
    func rounding() throws {
        let plain = try #require(JSONCoding.parseDate("2026-10-28T09:41:01Z"))
        #expect(JSONCoding.formatDate(plain) == "2026-10-28T09:41:01.000Z")
        let base = try #require(JSONCoding.parseDate("2026-10-28T09:41:01.601Z"))
        #expect(JSONCoding.formatDate(base.addingTimeInterval(0.0004)) == "2026-10-28T09:41:01.601Z")
        #expect(JSONCoding.formatDate(base.addingTimeInterval(0.0006)) == "2026-10-28T09:41:01.602Z")
        #expect(JSONCoding.formatDate(base.addingTimeInterval(0.399)) == "2026-10-28T09:41:02.000Z")
    }

    @Test("RunRef.kind, the artifact statuses and resync decode; unknown values read as nil")
    func events() throws {
        func event(_ json: String) throws -> DuetEvent {
            try JSONCoding.decoder().decode(DuetEvent.self, from: Data(json.utf8))
        }
        let done = try event(#"{"id":1,"type":"done","channelId":"c","createdAt":"2026-10-29T01:05:00.000Z","payload":{"runId":"r","taskId":null,"kind":"build","status":"completed","error":null}}"#)
        guard case let .done(run, outcome, _) = done.body else { Issue.record("not done"); return }
        #expect(run.kind == .build)
        #expect(outcome == .completed)
        let old = try event(#"{"id":2,"type":"typing","channelId":"c","createdAt":"2026-10-29T01:05:00.000Z","payload":{"runId":"r","taskId":null,"typing":true}}"#)
        guard case let .typing(oldRun, _) = old.body else { Issue.record("not typing"); return }
        #expect(oldRun.kind == nil)
        let future = try event(#"{"id":3,"type":"status","channelId":"c","createdAt":"2026-10-29T01:05:00.000Z","payload":{"runId":"r","taskId":null,"kind":"someday","status":null}}"#)
        guard case let .status(futureRun, _) = future.body else { Issue.record("not status"); return }
        #expect(futureRun.kind == nil)
        let resync = try event(#"{"id":4,"type":"resync","channelId":null,"createdAt":"2026-10-29T01:08:00.000Z","payload":{"reason":"replay_limit"}}"#)
        #expect(resync.body == .resync(.replayLimit))
        let newer = try event(#"{"id":5,"type":"resync","channelId":null,"createdAt":"2026-10-29T01:08:00.000Z","payload":{"reason":"later"}}"#)
        #expect(newer.body == .resync(nil))
    }
}
