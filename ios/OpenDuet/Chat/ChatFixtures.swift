// Preview-only fixtures (prompt L3): the app never shows these; at runtime the main thread
// comes from the backend through ShellState. Fixture texts are plain Strings (data, not UI copy).
#if DEBUG
import Foundation

enum ChatFixtures {
    static let now = Date()

    static func message(
        _ id: String, _ role: Message.Role, _ text: String, minutesAgo: Double,
        status: Message.Status = .sent, content: MessageContent? = nil
    ) -> Message {
        let date = now.addingTimeInterval(-minutesAgo * 60)
        return Message(
            id: id, channelId: "main", taskId: nil, role: role, text: text, status: status, clientId: nil,
            reactions: [], createdAt: date, updatedAt: date,
            content: content ?? .text(TextPayload(skill: nil, attachments: []))
        )
    }

    static let welcome = "Hi Chris, welcome! Today's our first day working together. I'm going to help you stay on top of your work and life."
    static let summary = """
        You run a small product studio juggling **two client launches**, your own apps and a newsletter.

        **How I'll help:**
        - Keep this week's three deadlines in view and flag a slip early
        - Take drafting and prep off your plate
        - Park new ideas in [Draft the launch brief](duet://tasks/t1) so they don't derail a launch

        ```swift
        let deadlines = ["Mon", "Wed", "Fri"]
        ```

        | Launch | Due |
        |---|--:|
        | Atlas | Fri |
        | Nimbus | Oct 30 |
        """

    static let file = ChannelFile(
        id: "f1", channelId: "main", messageId: "m6", name: "Q4 plan.pdf", mime: "application/pdf",
        size: 482_000, source: .assistant, url: "/api/files/f1/content", createdAt: now
    )

    static let messages: [Message] = [
        message("m1", .assistant, welcome, minutesAgo: 90),
        message("m2", .assistant, summary, minutesAgo: 89),
        message("m3", .user, "Sounds right. Can you also watch the Atlas budget?", minutesAgo: 30, status: .seen),
        message("m4", .assistant, "Want me to check it every morning?", minutesAgo: 29,
                content: .quickReplies(QuickRepliesPayload(options: ["Yes, every morning", "Only on weekdays", "Not now"], chosen: nil))),
        message("m5", .system, "", minutesAgo: 28,
                content: .system(Phrase(key: "system.reminder_set", params: ["at": .datetime(now.addingTimeInterval(86_400))]))),
        message("m6", .assistant, "", minutesAgo: 20, content: .file(FilePayload(file: file, caption: ""))),
        message("m7", .assistant, "", minutesAgo: 10, content: .usageLimit(resumesAt: now.addingTimeInterval(3 * 86_400))),
        message("m8", .assistant, "", minutesAgo: 9, content: .unsupported(kind: "hologram")),
    ]

    static var loaded: ShellState {
        var state = ShellState(userName: "Chris Flores", status: .checkingCalendar, tasksNeedingUser: 2)
        state.unreadChannels = 3
        state.thread = ThreadState(phase: .loaded, messages: messages, typing: true, lastReadAt: now.addingTimeInterval(-29.5 * 60))
        state.thread.pending = [
            PendingMessage(clientId: "c1", text: "And book the review room for Thursday", attachments: [], createdAt: now, state: .failed),
        ]
        return state
    }

    static var offline: ShellState {
        var state = loaded
        state.connection = .offline
        state.status = nil
        state.thread.typing = false
        state.thread.pending = [PendingMessage(clientId: "c2", text: "Typed while offline", attachments: [], createdAt: now, state: .waiting)]
        state.composer.attachments = [
            ComposerAttachment(id: UUID(), name: "receipt.jpg", mime: "image/jpeg", thumbnail: nil, upload: .uploading(progress: 0.4)),
            ComposerAttachment(id: UUID(), name: "huge.mov", mime: "video/quicktime", thumbnail: nil, upload: .failed(reason: "Too large (25 MB max)")),
        ]
        return state
    }

    static var loading: ShellState { ShellState(userName: "林晓") }

    static var failed: ShellState {
        var state = ShellState(userName: "Chris Flores")
        state.thread.phase = .failed(reason: "Can't reach your server.")
        return state
    }

    static var empty: ShellState {
        var state = ShellState(userName: "Chris Flores")
        state.thread.phase = .loaded
        return state
    }
}
#endif
