// Wire-shaped M3 fixtures (tasks, approvals, cards) for the data-layer tests, decoded with the
// app's JSONCoding like the server's JSON (see DataFixtures.swift).
import Foundation
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

extension Fx {
    // MARK: - Tasks

    static func taskJSON(_ id: String, status: String = "working", channel: String = main, updated: Int = 0,
                         archived: Bool = false, title: String? = nil) -> [String: Any] {
        [
            "id": id, "channelId": channel, "title": title ?? id, "status": status, "source": "user",
            "latestUpdate": NSNull(), "updateCount": 0, "schedule": NSNull(), "archived": archived,
            "createdAt": iso(0), "updatedAt": iso(updated),
        ]
    }

    static func task(_ id: String, status: String = "working", channel: String = main, updated: Int = 0,
                     archived: Bool = false, title: String? = nil) -> TaskSummary {
        decode(TaskSummary.self, taskJSON(id, status: status, channel: channel, updated: updated, archived: archived, title: title))
    }

    static func taskEvent(_ id: Int64, _ task: [String: Any]) -> DuetEvent {
        event(id, "task", channel: task["channelId"] as? String, ["task": task])
    }

    static func detail(_ id: String, status: String = "working", updated: Int = 0, steps: [String] = []) -> TaskDetail {
        var json = taskJSON(id, status: status, updated: updated)
        json["prompt"] = "Do the thing"
        json["description"] = "What Claude is doing"
        json["noticedAt"] = NSNull()
        json["steps"] = steps.enumerated().map { ["id": "st\($0.offset)", "text": $0.element, "state": "planned"] }
        json["updates"] = []
        json["resources"] = []
        return decode(TaskDetail.self, json)
    }

    static func typing(_ id: Int64, run: String, _ on: Bool, taskId: String?) -> DuetEvent {
        event(id, "typing", ["runId": run, "taskId": taskId ?? NSNull(), "typing": on])
    }

    static func done(_ id: Int64, run: String, taskId: String?) -> DuetEvent {
        event(id, "done", ["runId": run, "taskId": taskId ?? NSNull(), "status": "completed", "error": NSNull()])
    }

    static func suggestion(_ id: String) -> Suggestion {
        decode(Suggestion.self, [
            "id": id, "channelId": NSNull(), "title": id, "body": "", "app": "Gmail", "origin": "checkin", "createdAt": iso(0),
        ])
    }

    // MARK: - Approvals and cards

    static func approvalJSON(_ id: String = "apr_1", message: String = "msg_a", version: Int = 1, status: String = "pending",
                             changed: [String] = [], updated: Int = 0, task: String? = nil) -> [String: Any] {
        [
            "id": id, "kind": "email", "status": status, "version": version, "expiresAt": NSNull(),
            "taskId": task ?? NSNull(), "messageId": message,
            "preview": [
                "kind": "email", "app": "Gmail", "to": ["sam@example.com"], "cc": [], "subject": "Re: renewal",
                "body": "Hi Sam (v\(version))", "attachments": [],
            ],
            "result": status == "approved" ? ["ok": true, "error": NSNull()] as [String: Any] : NSNull() as Any,
            "changedFields": changed, "updatedAt": iso(updated),
        ]
    }

    static func approval(_ id: String = "apr_1", message: String = "msg_a", version: Int = 1, status: String = "pending",
                         changed: [String] = [], updated: Int = 0, task: String? = nil) -> Approval {
        decode(Approval.self, approvalJSON(id, message: message, version: version, status: status, changed: changed, updated: updated, task: task))
    }

    /// A card message: `kind` + `payload` replace the text fixture's.
    static func cardJSON(_ id: String, at t: Int, kind: String, payload: [String: Any], taskId: String? = nil, updated: Int? = nil) -> [String: Any] {
        var json = messageJSON(id, at: t, text: "", taskId: taskId, updated: updated)
        json["kind"] = kind
        json["payload"] = payload
        return json
    }

    static func approvalCardJSON(_ id: String = "msg_a", at t: Int = 10, approval: [String: Any], taskId: String? = nil, updated: Int? = nil) -> [String: Any] {
        cardJSON(id, at: t, kind: "approval", payload: ["approval": approval], taskId: taskId, updated: updated)
    }

    static func approvalCard(_ id: String = "msg_a", at t: Int = 10, approval: [String: Any], taskId: String? = nil, updated: Int? = nil) -> Message {
        decode(Message.self, approvalCardJSON(id, at: t, approval: approval, taskId: taskId, updated: updated))
    }

    static func approvalEvent(_ id: Int64, _ approval: [String: Any]) -> DuetEvent {
        event(id, "approval", ["approval": approval])
    }

    static func spendCard(_ id: String = "msg_s", approvalId: String = "apr_2", status: String = "pending") -> Message {
        decode(Message.self, cardJSON(id, at: 10, kind: "spend_request", payload: ["spendRequest": [
            "id": "spr_1", "approvalId": approvalId, "amount": 1649, "currency": "USD", "merchant": "Blue Bottle",
            "description": "Coffee", "item": "2 bags", "expiresAt": iso(600), "status": status, "testMode": true,
        ]]))
    }

    static func proactiveCard(_ id: String = "msg_p", state: String = "open", taskId: String? = nil, updated: Int = 10) -> Message {
        decode(Message.self, cardJSON(id, at: 10, kind: "proactive_suggestion", payload: [
            "title": "Prep for the 2 PM", "body": "Pull notes.", "prompt": "Prep me for the 2 PM", "state": state,
            "taskId": taskId ?? NSNull(),
        ], updated: updated))
    }

    /// The approval shown by a card message (nil for other kinds).
    static func shownApproval(_ message: Message?) -> Approval? {
        if case .approval(let approval)? = message?.content { approval } else { nil }
    }
}
