// Wire-shaped M4 fixtures (channels, connectors, usage, schedule, the user) for the data-layer
// tests, decoded with the app's JSONCoding like the server's JSON (see DataFixtures.swift).
import Foundation
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

extension Fx {
    // MARK: - Channels

    static func chan(_ id: String, isMain: Bool = false, unread: Int = 0, archived: Bool = false) -> Channel {
        decode(Channel.self, channel(id, isMain: isMain, unread: unread, archived: archived))
    }

    static func channelEvent(_ id: Int64, _ json: [String: Any]) -> DuetEvent {
        event(id, "channel", channel: json["id"] as? String, ["channel": json])
    }

    // MARK: - Connectors

    static func connectorJSON(_ toolkit: String, category: String?, connected: Bool = false) -> [String: Any] {
        let accounts: [[String: Any]] = connected
            ? [["id": "ca_\(toolkit)", "label": "alex@example.com", "status": "active", "connectedAt": iso(0)]]
            : []
        return [
            "toolkit": toolkit, "name": toolkit.capitalized, "description": "", "logoUrl": "/api/connectors/\(toolkit)/logo",
            "category": category ?? NSNull(), "accounts": accounts,
        ]
    }

    static func connectors(_ items: [[String: Any]], configured: Bool = true) -> ConnectorList {
        decode(ConnectorList.self, ["configured": configured, "connectors": items])
    }

    static func toolJSON(_ slug: String, access: String, common: Bool, mode: String = "ask") -> [String: Any] {
        ["slug": slug, "name": slug, "description": "", "access": access, "mode": mode, "common": common]
    }

    static func connectorDetail(_ toolkit: String, tools: [[String: Any]]) -> ConnectorDetail {
        decode(ConnectorDetail.self, ["connector": connectorJSON(toolkit, category: "mail", connected: true), "tools": tools])
    }

    static func connectResponse() -> ConnectResponse {
        decode(ConnectResponse.self, ["url": "https://connect.composio.dev/link/lk_1", "callbackScheme": "duet"])
    }

    // MARK: - Usage, schedule, Up next

    static func usage(sessionUsed: Int = 0, resetAvailable: Bool = true) -> UsageState {
        decode(UsageState.self, usageJSON(sessionUsed: sessionUsed, resetAvailable: resetAvailable))
    }

    static func usageJSON(sessionUsed: Int = 0, resetAvailable: Bool = true) -> [String: Any] {
        [
            "session": ["used": sessionUsed, "limit": 3_000_000, "resetsAt": NSNull()],
            "weekly": ["used": sessionUsed, "limit": 30_000_000, "resetsAt": NSNull()],
            "fullReset": ["available": resetAvailable, "expiresAt": iso(86_400)],
            "limited": false, "resumesAt": NSNull(),
        ]
    }

    /// Next runs `briefNext` / `checkinNext` seconds after the base; history statuses for the check-in.
    static func schedule(briefNext: Int, checkinNext: Int, checkinHistory: [String] = ["completed"]) -> ScheduleInfo {
        let history: [[String: Any]] = checkinHistory.enumerated().map { index, status in
            ["id": "run_\(index)", "kind": "checkin", "scheduledFor": iso(index), "startedAt": iso(index), "status": status]
        }
        return decode(ScheduleInfo.self, [
            "weekendsOn": false,
            "brief": ["time": ["hour": 8, "minute": 19], "nextRunAt": iso(briefNext), "history": []],
            "checkin": ["times": [["hour": 10, "minute": 49]], "nextRunAt": iso(checkinNext), "history": history],
        ])
    }

    static func upNext(scanning: Bool) -> UpNext {
        decode(UpNext.self, ["suggestions": [], "scanning": scanning])
    }

    // MARK: - The user

    static func user(briefHour: Int = 8, weekendsOn: Bool = false, onboardedAt: Int? = nil) -> CurrentUser {
        decode(CurrentUser.self, [
            "id": "u_1", "username": "alex", "name": "Alex Doe", "firstName": "Alex", "email": NSNull(),
            "timezone": "UTC", "language": "en", "briefTime": ["hour": briefHour, "minute": 19], "checkinMinute": 49,
            "weekendsOn": weekendsOn, "onboardedAt": onboardedAt.map { iso($0) as Any } ?? NSNull(), "mainChannelId": main,
            "features": ["connectors": true, "webSearch": false, "push": NSNull(), "computer": false],
            "createdAt": iso(0),
        ])
    }
}
