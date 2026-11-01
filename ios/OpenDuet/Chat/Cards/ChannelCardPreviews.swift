// Previews of the M11 chat cards in the real thread: the memory chip (remembered, forgot, undo in
// flight, undone, failed), the soul proposal (open, applying, failed, applied, Not now) and the
// connection request (api_key, mcp without a URL, app, connecting, a 400, connected, Not now),
// plus the New channel sheet's access step. Placeholder data only; the app never shows it. DEBUG only.
#if DEBUG
import SwiftUI

enum ChannelCardSamples {
    static func card(_ id: String, minutesAgo: Double, text: String = "", _ content: MessageContent) -> Message {
        ChatFixtures.message(id, .assistant, text, minutesAgo: minutesAgo, content: content)
    }

    static func memory(_ op: MemoryNotePayload.Op, _ scope: MemoryNotePayload.Scope, _ state: MemoryNotePayload.State = .done) -> MessageContent {
        .memoryNote(MemoryNotePayload(op: op, factId: "fact_1", text: "Prefers invoices as PDF", scope: scope, state: state))
    }

    static func soul(_ state: SoulProposalPayload.State, field: SoulProposalPayload.Field = .tone, current: String = "") -> MessageContent {
        .soulProposal(SoulProposalPayload(
            field: field, current: current, proposed: "Warm and brief. No exclamation marks.",
            reason: "You asked me twice to keep it shorter.", state: state
        ))
    }

    static let keyField = ConnectionRequestPayload.Field(key: "key", label: "API key", secret: true, placeholder: nil)
    static let headerField = ConnectionRequestPayload.Field(key: "Authorization", label: "Authorization header", secret: true, placeholder: "Bearer …")

    static func apiKey(_ state: ConnectionRequestPayload.State = .open) -> MessageContent {
        .connectionRequest(ConnectionRequestPayload(
            type: .apiKey, name: "Weather", purpose: "To check tomorrow's rain before the delivery run.",
            url: nil, domain: "api.example.com", toolkit: nil, headerName: "X-Api-Key", valuePrefix: "",
            fields: [keyField], state: state, connectorId: state == .connected ? "cc_1" : nil
        ))
    }

    static func mcp(url: String? = nil, _ state: ConnectionRequestPayload.State = .open) -> MessageContent {
        .connectionRequest(ConnectionRequestPayload(
            type: .mcp, name: "Shop inventory", purpose: "To read stock levels.",
            url: url, domain: nil, toolkit: nil, headerName: nil, valuePrefix: nil,
            fields: [headerField], state: state, connectorId: nil
        ))
    }

    static func app(_ state: ConnectionRequestPayload.State = .open) -> MessageContent {
        .connectionRequest(ConnectionRequestPayload(
            type: .app, name: "Google Calendar", purpose: "To put the delivery runs in your calendar.",
            url: nil, domain: nil, toolkit: "googlecalendar", headerName: nil, valuePrefix: nil,
            fields: [], state: state, connectorId: nil
        ))
    }

    static let messages: [Message] = [
        ChatFixtures.message("u1", .user, "Invoices as PDF from now on, please.", minutesAgo: 30),
        card("r1", minutesAgo: 29.9, text: "Got it, PDFs from now on.", .text(TextPayload(skill: nil, attachments: [], replyTo: nil))),
        card("m1", minutesAgo: 29.8, memory(.remembered, .channel)),
        card("m2", minutesAgo: 29.7, memory(.forgot, .shared)),
        card("m3", minutesAgo: 29.6, memory(.remembered, .shared, .undone)),
        card("s1", minutesAgo: 20, text: "One thing about how I write to you:", soul(.open)),
        card("s2", minutesAgo: 19, soul(.applied, field: .name, current: "OpenDuet")),
        card("s3", minutesAgo: 18, soul(.dismissed, field: .soulExtra, current: "Numbers first.")),
        card("c1", minutesAgo: 10, text: "I need a key for the weather service.", apiKey()),
        card("c2", minutesAgo: 9, mcp()),
        card("c3", minutesAgo: 8, app()),
        card("c4", minutesAgo: 7, apiKey(.connected)),
        card("c5", minutesAgo: 6, mcp(url: "https://mcp.example.com/mcp", .dismissed)),
    ]

    static var thread: ShellState {
        var state = ShellState(userName: "Alex Rivera")
        state.thread = ThreadState(phase: .loaded, messages: messages)
        return state
    }

    /// Undo and Apply in flight, a connection refused by the server, a failed undo.
    static var busy: ShellState {
        var state = thread
        state.cardRequests = [
            "m1": .inFlight,
            "m2": .failed(reason: "Can't reach your server."),
            "s1": .inFlight,
            "c1": .failed(reason: "api.example.com doesn't resolve to a public address."),
            ShellState.RequestKey.connect("googlecalendar"): .inFlight,
        ]
        return state
    }

    static func item(_ kind: AccessKind, _ id: String, _ name: String, _ description: String, _ scope: AccessScope) -> ChannelAccess.Item {
        ChannelAccess.Item(kind: kind, id: id, name: name, description: description, scope: scope, enabled: true)
    }

    static let access = NewChannelAccess(items: [
        item(.skill, "skill_1", "weekly-numbers", "Pull the week's sales into one table.", .all),
        item(.skill, "skill_2", "supplier-mail", "Draft an order email to a supplier.", .channels),
        item(.connector, "cc_1", "Shop inventory", "Stock levels and orders.", .channels),
        item(.app, "gmail", "Gmail", "", .all),
        item(.app, "googlecalendar", "Google Calendar", "", .all),
    ])
}

#Preview("M11 cards – every state") {
    MainShellView(state: ChannelCardSamples.thread, actions: ShellActions())
}

#Preview("M11 cards – in flight / failed") {
    MainShellView(state: ChannelCardSamples.busy, actions: ShellActions())
}

#Preview("M11 cards – dark, Chinese") {
    MainShellView(state: ChannelCardSamples.thread, actions: ShellActions())
        .preferredColorScheme(.dark)
        .environment(\.locale, Locale(identifier: "zh-Hans"))
}

#Preview("New channel – What can OpenDuet use here?") {
    @Previewable @State var access = ChannelCardSamples.access
    ScrollView {
        NewChannelAccessStep(
            access: access, load: .loaded, request: nil,
            onToggle: { access.toggle($0) }, onRetryLoad: {}, onRetryCreate: {}
        )
        .padding(16)
    }
    .background(Palette.sheetBackground)
}

#Preview("New channel – access loading / failed") {
    ScrollView {
        VStack(spacing: 32) {
            NewChannelAccessStep(access: NewChannelAccess(), load: .loading, request: nil, onToggle: { _ in }, onRetryLoad: {}, onRetryCreate: {})
            NewChannelAccessStep(
                access: NewChannelAccess(), load: .failed(reason: "Can't reach your server."),
                request: .failed(reason: "access: unknown skill skill_9"), onToggle: { _ in }, onRetryLoad: {}, onRetryCreate: {}
            )
        }
        .padding(16)
    }
    .background(Palette.sheetBackground)
    .preferredColorScheme(.dark)
}
#endif
