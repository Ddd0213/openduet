// M22 contract: the new task fields, the card's group block, soul_setup, Needs you and Setup
// decode; payloads from before M22 still decode with the defaults; an unknown value from a newer
// server drops only that value.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M22 contract")
struct DataM22ContractTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.decoder().decode(T.self, from: Data(json.utf8))
    }

    private let oldTask = #"{"id":"t","channelId":"c","title":"Old","status":"resolved","source":"user","latestUpdate":null,"updateCount":0,"schedule":null,"archived":false,"createdAt":"2026-10-01T00:00:00.000Z","updatedAt":"2026-10-01T00:00:00.000Z"}"#

    @Test("A task from before M22 decodes with no next step, failure or resolvedAt; a list with olderResolved 0")
    func olderPayloads() throws {
        let task = try decode(TaskSummary.self, oldTask)
        #expect(task.nextStep == nil && task.failure == nil && task.resolvedAt == nil)
        let list = try decode(TaskList.self, #"{"tasks":[\#(oldTask)]}"#)
        #expect(list.tasks.count == 1 && list.olderResolved == 0 && list.nextCursor == nil)
        let routine = try decode(Routine.self, #"{"paused":true,"quiet":false,"nextRunAt":null,"lastRunAt":null,"lastRunStatus":"failed"}"#)
        #expect(routine.failStreak == 0 && routine.pausedBy == nil)
    }

    @Test("The new fields decode; an unknown next-step kind keeps its text, an unknown pause reason reads nil")
    func newFields() throws {
        let json = oldTask.replacingOccurrences(of: #""archived":false"#, with: #""archived":false,"nextStep":{"kind":"later","text":{"key":"task.next.reply"},"messageId":null},"failure":{"reason":{"key":"system.model_timeout"},"retryable":true,"at":"2026-10-30T09:00:00.000Z"},"resolvedAt":"2026-10-30T10:00:00.000Z""#)
        let task = try decode(TaskSummary.self, json)
        #expect(task.nextStep?.kind == nil)
        #expect(task.nextStep?.text.key == "task.next.reply")
        #expect(task.failure?.retryable == true)
        #expect(task.resolvedAt != nil)
        let routine = try decode(Routine.self, #"{"paused":true,"quiet":false,"nextRunAt":null,"lastRunAt":null,"lastRunStatus":"failed","failStreak":3,"pausedBy":"someone"}"#)
        #expect(routine.failStreak == 3 && routine.pausedBy == nil)
    }

    @Test("A group block decodes; a newer block type is skipped")
    func groupBlock() throws {
        let block = try decode(CardBlock.self, #"{"type":"group","title":"Needs you","count":2,"empty":null,"rows":[{"title":"Book","detail":null,"route":"duet://tasks/t"}]}"#)
        guard case let .group(group) = block else { Issue.record("not a group"); return }
        #expect(group.count == 2 && group.rows.first?.route == "duet://tasks/t")
        let newer = try decode(CardBlock.self, #"{"type":"banner","text":"x"}"#)
        #expect(newer == .unsupported(type: "banner"))
    }

    @Test("Needs you: tasks, cards and a newer kind; Setup: an unknown status or fix doesn't fail the row")
    func needsYouAndSetup() throws {
        let needs = try decode(NeedsYou.self, #"{"count":3,"items":[{"kind":"task","task":\#(oldTask)},{"kind":"form","messageId":"m","channelId":"c","title":"Pick","detail":{"key":"task.next.form"},"route":"duet://channels/c?message=m","at":"2026-10-30T09:00:00.000Z"},{"kind":"someday"}]}"#)
        #expect(needs.items.count == 3)
        #expect(needs.items.last == .unsupported(kind: "someday"))
        let setup = try decode(SetupInfo.self, #"{"items":[{"id":"later","status":"maybe","required":false,"title":{"text":"X"},"detail":{"text":"Y"},"fix":{"kind":"script"},"checkedAt":null}]}"#)
        #expect(setup.items.first?.status == nil)
        #expect(setup.items.first?.fix == .unsupported)
    }
}
