// M18 data and rules (backend/src/contract/m18.ts, docs/api-samples/m18.json): a text message's
// taskResult (a done task's result in the chat) and forwarded ("From chat" in a task's thread)
// decode; older payloads without them and shapes this app doesn't know leave them nil; when a
// task result bubble folds (TaskResultFold).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private func textPayload(_ json: String) throws -> TextPayload {
    try JSONCoding.decoder().decode(TextPayload.self, from: Data(json.utf8))
}

private func textPayload(of message: Message?) -> TextPayload? {
    guard let message, case .text(let payload) = message.content else { return nil }
    return payload
}

@Suite("M18 task results and forwarded messages")
struct DataM18Tests {
    @Test("the TaskResult samples decode")
    func taskResultSamples() throws {
        let results = try M9Samples.decode(TaskResultInfo.self, "m18", "TaskResult")
        #expect(results.count == 2)
        guard results.count == 2 else { return }
        #expect(results[0].taskId == "task_11")
        #expect(results[0].title == "Singles' Day watch · trial run")
        #expect(results[0].status == .resolved)
        #expect(results[0].sourceCount == 2)
        #expect(results[1].status == .readyForReview)
        #expect(results[1].sourceCount == 0)
    }

    @Test("the m18 MessagePage: result, failed line, forwarded and old payloads")
    func messagePage() throws {
        let page = try #require(try M9Samples.decode(MessagePage.self, "m18", "MessagePage").first)
        let byId = Dictionary(uniqueKeysWithValues: page.messages.map { ($0.id, $0) })

        guard let result = textPayload(of: byId["msg_result"]) else {
            Issue.record("msg_result is not a text message"); return
        }
        #expect(result.taskResult?.taskId == "task_11")
        #expect(result.taskResult?.status == .resolved)
        #expect(result.taskResult?.sourceCount == 2)
        #expect(result.forwarded == nil)
        #expect(!result.isForwardedFromChat)

        guard let failed = textPayload(of: byId["msg_task_failed"]) else {
            Issue.record("msg_task_failed is not a text message"); return
        }
        #expect(failed.taskResult == nil)
        #expect(failed.forwarded == nil)

        guard let forwarded = textPayload(of: byId["msg_forwarded"]) else {
            Issue.record("msg_forwarded is not a text message"); return
        }
        #expect(forwarded.forwarded == "chat")
        #expect(forwarded.isForwardedFromChat)
        #expect(forwarded.taskResult == nil)
        #expect(byId["msg_forwarded"]?.role == .user)
        #expect(byId["msg_forwarded"]?.taskId == "task_14")

        guard let old = textPayload(of: byId["msg_old"]) else {
            Issue.record("msg_old is not a text message"); return
        }
        #expect(old.taskResult == nil)
        #expect(old.forwarded == nil)
        #expect(old.attachments.isEmpty)
    }

    @Test("an old payload without the M18 fields decodes with them nil")
    func oldPayload() throws {
        let payload = try textPayload(#"{"skill":"brief","attachments":[],"replyTo":null}"#)
        #expect(payload.skill == "brief")
        #expect(payload.taskResult == nil)
        #expect(payload.forwarded == nil)
        #expect(!payload.isForwardedFromChat)
    }

    @Test("a task result this app doesn't know drops the footer, not the message")
    func unknownShapes() throws {
        let newerStatus = try textPayload(#"""
        {"skill":null,"attachments":[],"replyTo":null,
         "taskResult":{"taskId":"t1","title":"T","status":"archived","sourceCount":1},"forwarded":null}
        """#)
        #expect(newerStatus.taskResult == nil)
        #expect(newerStatus.attachments.isEmpty)

        let otherOrigin = try textPayload(#"{"skill":null,"attachments":[],"replyTo":null,"taskResult":null,"forwarded":"call"}"#)
        #expect(otherOrigin.forwarded == "call")
        #expect(!otherOrigin.isForwardedFromChat)
    }

    @Test("short results don't fold; about 12 lines plus a few more do")
    func longRule() {
        #expect(!TaskResultFold.isLong(""))
        #expect(!TaskResultFold.isLong("Done. Two sources agree."))
        // 14 short lines: only two would hide, so it shows whole.
        let fourteen = Array(repeating: "- a short point", count: 14).joined(separator: "\n")
        #expect(TaskResultFold.estimatedLines(fourteen) == 14)
        #expect(!TaskResultFold.isLong(fourteen))
        let fifteen = Array(repeating: "- a short point", count: 15).joined(separator: "\n")
        #expect(TaskResultFold.isLong(fifteen))
    }

    @Test("long paragraphs wrap; CJK counts double; blank lines count half")
    func estimatedLines() {
        let paragraph = String(repeating: "a", count: TaskResultFold.lineUnits * 3 + 1)
        #expect(TaskResultFold.estimatedLines(paragraph) == 4)
        let chinese = String(repeating: "双", count: TaskResultFold.lineUnits)
        #expect(TaskResultFold.estimatedLines(chinese) == 2)
        #expect(TaskResultFold.estimatedLines("one\n\ntwo") == 2.5)
        // Five Chinese paragraphs of 120 characters (~8 lines each) fold.
        let chineseResult = Array(repeating: String(repeating: "京", count: 120), count: 5).joined(separator: "\n\n")
        #expect(TaskResultFold.isLong(chineseResult))
    }

    @Test("measured: folds past 15 lines, shows 12")
    func measuredRule() {
        #expect(!TaskResultFold.folds(height: 0, lineHeight: 23))
        #expect(!TaskResultFold.folds(height: 300, lineHeight: 0))
        #expect(!TaskResultFold.folds(height: 23 * 15, lineHeight: 23))
        #expect(TaskResultFold.folds(height: 23 * 15 + 1, lineHeight: 23))
        #expect(TaskResultFold.collapsedHeight(lineHeight: 23) == 276)
    }
}
