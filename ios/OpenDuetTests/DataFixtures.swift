// Wire-shaped fixtures for the data-layer tests: events and messages are built as JSON and
// decoded with the app's own JSONCoding, so they go through the same path as the server's.
import Foundation
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

enum Fx {
    static let main = "ch_main"
    private static let base = Date(timeIntervalSince1970: 1_793_000_000)

    /// An ISO 8601 timestamp `seconds` after a fixed base.
    static func iso(_ seconds: Int) -> String {
        base.addingTimeInterval(TimeInterval(seconds)).formatted(.iso8601)
    }

    static func date(_ seconds: Int) -> Date {
        base.addingTimeInterval(TimeInterval(seconds))
    }

    static func messageJSON(_ id: String, at t: Int, text: String = "hi", role: String = "assistant", channel: String = main,
                            clientId: String? = nil, taskId: String? = nil, updated: Int? = nil) -> [String: Any] {
        [
            "id": id, "channelId": channel, "taskId": taskId ?? NSNull(), "role": role, "kind": "text",
            "text": text, "status": "sent", "clientId": clientId ?? NSNull(), "reactions": [],
            "createdAt": iso(t), "updatedAt": iso(updated ?? t),
            "payload": ["skill": NSNull(), "attachments": []],
        ]
    }

    static func message(_ id: String, at t: Int, text: String = "hi", role: String = "assistant", channel: String = main,
                        clientId: String? = nil, taskId: String? = nil, updated: Int? = nil) -> Message {
        decode(Message.self, messageJSON(id, at: t, text: text, role: role, channel: channel, clientId: clientId, taskId: taskId, updated: updated))
    }

    static func event(_ id: Int64, _ type: String, channel: String? = main, _ payload: [String: Any]) -> DuetEvent {
        decode(DuetEvent.self, ["id": id, "type": type, "channelId": channel ?? NSNull(), "createdAt": iso(Int(id)), "payload": payload])
    }

    static func messageEvent(_ id: Int64, _ message: [String: Any]) -> DuetEvent {
        event(id, "message", channel: message["channelId"] as? String, ["message": message])
    }

    static func status(_ id: Int64, run: String, _ key: String?, taskId: String? = nil) -> DuetEvent {
        event(id, "status", ["runId": run, "taskId": taskId ?? NSNull(), "status": key ?? NSNull()])
    }

    static func typing(_ id: Int64, run: String, _ on: Bool) -> DuetEvent {
        event(id, "typing", ["runId": run, "taskId": NSNull(), "typing": on])
    }

    static func done(_ id: Int64, run: String) -> DuetEvent {
        event(id, "done", ["runId": run, "taskId": NSNull(), "status": "completed", "error": NSNull()])
    }

    static func deleted(_ id: Int64, _ messageId: String) -> DuetEvent {
        event(id, "message_deleted", ["messageId": messageId])
    }

    static func channel(_ id: String, isMain: Bool = false, unread: Int = 0, archived: Bool = false) -> [String: Any] {
        [
            "id": id, "isMain": isMain, "name": id, "icon": "chart", "colorHex": "#6290C2", "purpose": "",
            "archived": archived, "unreadCount": unread, "lastReadAt": NSNull(), "lastMessageAt": NSNull(),
            "createdAt": iso(0),
        ]
    }

    static func page(_ messages: [Message], hasMore: Bool = false) -> MessagePage {
        MessagePage(messages: messages, hasMore: hasMore)
    }

    static func pending(_ clientId: String, _ text: String = "queued", at t: Int = 0) -> PendingMessage {
        PendingMessage(clientId: clientId, text: text, attachments: [], createdAt: date(t), state: .waiting)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ object: [String: Any]) -> T {
        do {
            let data = try JSONSerialization.data(withJSONObject: object)
            return try JSONCoding.decoder().decode(T.self, from: data)
        } catch {
            fatalError("fixture \(T.self) didn't decode: \(error)")
        }
    }
}
