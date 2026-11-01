// SwiftUI Preview fixtures for the M4 screens, shaped like docs/api-samples/{account,channels}.json
// with placeholder names. DEBUG only: the app never shows them (L66, NOTHING IS FAKED).
#if DEBUG
import Foundation

enum AccountFixtures {
    static let now = Date()

    static func channel(
        _ id: String, _ name: String, _ icon: ChannelIcon, _ color: ChannelColor,
        purpose: String, unread: Int = 0, archived: Bool = false
    ) -> Channel {
        Channel(
            id: id, isMain: false, name: name, icon: icon, colorHex: color, purpose: purpose, archived: archived,
            unreadCount: unread, lastReadAt: nil, lastMessageAt: now, createdAt: now.addingTimeInterval(-86_400 * 10)
        )
    }

    static let channels: [Channel] = [
        channel("c1", "Q4 planning", .chart, .blue, purpose: "Roadmap, budget and the launch review", unread: 2),
        channel("c2", "Hiring", .people, .green, purpose: "Interview loops and candidate notes"),
        channel("c3", "Home renovation", .house, .sand, purpose: "Contractors, quotes and the kitchen timeline"),
    ]

    static let archived: [Channel] = [
        channel("c9", "Conference 2026", .plane, .lavender, purpose: "Travel and talk prep", archived: true),
    ]

    static let user = CurrentUser(
        id: "u1", username: "alex", name: "Alex Rivera", firstName: "Alex", email: "alex@example.com",
        timezone: "America/Los_Angeles", language: .en, briefTime: LocalTime(hour: 8, minute: 19), checkinMinute: 49,
        weekendsOn: false, onboardedAt: now, mainChannelId: "main",
        features: Features(connectors: true, webSearch: true, push: nil, computer: false), createdAt: now
    )

    static func connector(_ toolkit: String, _ name: String, _ category: AccessCategory?, description: String, accounts: [String] = []) -> Connector {
        Connector(
            toolkit: toolkit, name: name, description: description, logoUrl: nil, category: category,
            accounts: accounts.enumerated().map { ConnectedAccount(id: "\(toolkit)-\($0.offset)", label: $0.element, status: .active, connectedAt: now) }
        )
    }

    static let catalog: [Connector] = [
        connector("gmail", "Gmail", .mail, description: "Read, draft and send email.", accounts: ["alex@example.com"]),
        connector("googlecalendar", "Google Calendar", .calendar, description: "See and schedule events.", accounts: ["alex@example.com"]),
        connector("googledrive", "Google Drive", .files, description: "Find and read files and docs."),
        connector("slack", "Slack", .teamChat, description: "Read channels and send messages."),
        connector("github", "GitHub", nil, description: "Issues, pull requests and code."),
    ]

    static var assistant: AssistantAccessState {
        AssistantAccessState(configured: true, phase: .loaded, rows: AccessLayout.rows(catalog), catalog: catalog, query: "")
    }

    static let tools: [ConnectorTool] = [
        ConnectorTool(slug: "GMAIL_FETCH_EMAILS", name: "Fetch emails", description: "Search and read messages.", access: .read, mode: .always, common: true),
        ConnectorTool(slug: "GMAIL_GET_THREAD", name: "Get thread", description: "Read a whole conversation.", access: .read, mode: .always, common: true),
        ConnectorTool(slug: "GMAIL_SEND_EMAIL", name: "Send email", description: "Send a message from your account.", access: .write, mode: .ask, common: true),
        ConnectorTool(slug: "GMAIL_CREATE_DRAFT", name: "Create draft", description: "Save a draft reply.", access: .write, mode: .always, common: false),
    ]

    static var detail: ConnectorDetailState {
        ConnectorDetailState(toolkit: "gmail", phase: .loaded, connector: catalog[0], tools: tools)
    }

    static var endOfMonth: Date { Calendar.current.dateInterval(of: .month, for: now)?.end ?? now }

    static func usage(session: Int, weekly: Int, limit: Int = 3_000_000, available: Bool = true) -> UsageState {
        UsageState(
            session: .init(used: session, limit: limit, resetsAt: session > 0 ? now.addingTimeInterval(3 * 3600 + 120) : nil),
            weekly: .init(used: weekly, limit: limit * 10, resetsAt: now.addingTimeInterval(13 * 3600 + 120)),
            fullReset: .init(available: available, expiresAt: endOfMonth),
            limited: false, resumesAt: nil
        )
    }

    private static func at(_ dayOffset: Int, _ hour: Int, _ minute: Int) -> Date {
        let calendar = Calendar.current
        let day = calendar.date(byAdding: .day, value: dayOffset, to: now) ?? now
        return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? now
    }

    static var schedule: ScheduleInfo {
        ScheduleInfo(
            weekendsOn: false,
            brief: .init(time: LocalTime(hour: 8, minute: 19), nextRunAt: at(1, 8, 19), history: [
                RunRecord(id: "r1", kind: .brief, scheduledFor: at(0, 8, 19), startedAt: at(0, 8, 19), status: .completed),
            ]),
            checkin: .init(times: [10, 13, 16, 19, 22].map { LocalTime(hour: $0, minute: 49) }, nextRunAt: at(0, 16, 49), history: [
                RunRecord(id: "r3", kind: .checkin, scheduledFor: at(0, 13, 49), startedAt: at(0, 13, 49), status: .resolved),
                RunRecord(id: "r2", kind: .checkin, scheduledFor: at(0, 10, 49), startedAt: nil, status: .skipped),
                RunRecord(id: "r0", kind: .checkin, scheduledFor: at(-1, 22, 49), startedAt: at(-1, 22, 49), status: .resolved),
            ])
        )
    }

    static func shell() -> ShellState {
        var state = ShellState()
        state.userName = user.name
        state.unreadChannels = 1
        state.menu = MenuState(channels: channels, archived: archived, selectedChannelId: "c1")
        state.assistant = assistant
        state.profile = ProfileState(
            user: user, notificationsAllowed: false, memoryPhase: .loaded,
            memory: MemoryState(document: "Alex leads product at a small design studio. Prefers short replies and morning meetings.", facts: [], updatedAt: now.addingTimeInterval(-3600))
        )
        state.usageScreen = UsageScreenState(phase: .loaded, usage: usage(session: 420_000, weekly: 30_000_000))
        state.thread.phase = .loaded
        state.tasks.phase = .loaded
        state.tasks.upNext.phase = .loaded
        state.tasks.schedule = ScheduleState(phase: .loaded, info: schedule)
        return state
    }
}
#endif
