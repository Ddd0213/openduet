// Preview-only fixtures for M3's chat cards (prompt L3): one thread with a delegation chip, task
// suggestions, a proactive suggestion and every approval state, plus confirmation, alert and
// plate cards. The app never shows these; at runtime cards come from the backend. Names and
// addresses are placeholders. DEBUG only.
#if DEBUG
import Foundation

enum CardFixtures {
    static let now = ChatFixtures.now

    static func card(_ id: String, minutesAgo: Double, text: String = "", _ content: MessageContent) -> Message {
        ChatFixtures.message(id, .assistant, text, minutesAgo: minutesAgo, content: content)
    }

    static func task(
        _ id: String, _ title: String, _ status: TaskStatus, minutesAgo: Double = 5, updates: Int = 0,
        latest: String? = nil, source: TaskSummary.Source = .user, channel: String = "main"
    ) -> TaskSummary {
        let date = now.addingTimeInterval(-minutesAgo * 60)
        return TaskSummary(
            id: id, channelId: channel, title: title, status: status, source: source,
            latestUpdate: latest.map { TaskUpdate(text: Phrase(text: $0), source: "OpenDuet", at: date) },
            updateCount: updates, schedule: nil, archived: false,
            createdAt: date.addingTimeInterval(-3600), updatedAt: date
        )
    }

    static func approval(
        _ id: String, _ kind: ApprovalKind, _ preview: ApprovalPreview, status: ApprovalStatus = .pending,
        version: Int = 1, expiresInMinutes: Double? = nil, result: Approval.Outcome? = nil,
        why: Phrase? = nil, always: ApprovalAlways? = nil, message: String
    ) -> Approval {
        Approval(
            id: id, kind: kind, status: status, version: version, preview: preview,
            expiresAt: expiresInMinutes.map { now.addingTimeInterval($0 * 60) }, taskId: nil, messageId: message,
            result: result, changedFields: [], why: why, always: always, updatedAt: now
        )
    }

    static let emailBody = """
        Hi Jordan,

        Thanks for the proofs. The cover looks great; could you move the logo 5 mm up and send the final files by Thursday?

        Best,
        Alex
        """

    static func email(body: String = emailBody, subject: String = "Re: Catalog proofs") -> ApprovalPreview {
        .email(EmailPreview(
            app: "Gmail", to: ["jordan@example.com"], cc: ["studio@example.com"], subject: subject, body: body,
            attachments: [.init(name: "catalog-v3.pdf", mime: "application/pdf", fileId: "f9")]
        ))
    }
    static let spawnedTask = task("t1", "Reply to the printer about the catalog proofs", .working)

    /// Delegation, task suggestions and a proactive suggestion.
    static let taskMessages: [Message] = [
        ChatFixtures.message("u1", .user, "Can you reply to the printer about the catalog proofs?", minutesAgo: 40, status: .seen),
        card("c1", minutesAgo: 40, .taskSpawn(TaskSpawnPayload(task: spawnedTask, anchorMessageId: "u1"))),
        ChatFixtures.message("c2", .assistant, "On it", minutesAgo: 40),
        card("c3", minutesAgo: 35, text: "A few places I can start:", .taskSuggestions(TaskSuggestionsPayload(items: [
            .init(id: "s1", title: "Prep Thursday's client review", prompt: "Pull the open questions from the review thread into an agenda", app: "Google Calendar", taskId: nil),
            .init(id: "s2", title: "Chase the overdue invoice", prompt: "Draft a friendly reminder for invoice #1042", app: "Gmail", taskId: "t2"),
        ]))),
        card("c4", minutesAgo: 30, text: "A task I could help with:", .proactiveSuggestion(ProactiveSuggestionPayload(
            title: "Renew the domain before Friday", body: "The studio domain expires in four days and auto-renew is off.",
            prompt: "Renew the studio domain", state: .open, taskId: nil
        ))),
        card("c5", minutesAgo: 29, .proactiveSuggestion(ProactiveSuggestionPayload(
            title: "Archive last quarter's receipts", body: "", prompt: "", state: .started, taskId: "t3"
        ))),
    ]

    static let sign = ApprovalPreview.sign(RowsPreview(app: "DocuSign", title: "Studio lease renewal", rows: [
        DetailRow(label: "Document", value: "Lease renewal 2025.pdf"), DetailRow(label: "From", value: "Harbor Properties"),
    ]))
    static let delete = ApprovalPreview.delete(RowsPreview(app: "Google Drive", title: "Old drafts folder", rows: [
        DetailRow(label: "Folder", value: "Drafts / 2023"), DetailRow(label: "Items", value: "38 files"),
    ]))
    static let action = ApprovalPreview.action(ActionPreview(app: "Google Calendar", toolName: "Create calendar event", rows: [
        DetailRow(label: "Title", value: "Catalog sign-off"), DetailRow(label: "When", value: "Thu 2:00 – 2:30 PM"),
    ]))
    static let payment = ApprovalPreview.payment(PaymentPreview(
        amount: 64_000, currency: "USD", merchant: "Riverside Print Co.", description: "Catalog print run deposit", testMode: true
    ))

    static let runbook = """
        Go-live runbook for the marketing website. One line per item — tick as you go.

        ## Phase 1 — T-7 days: decide, freeze, prepare
        - [ ] Freeze scope — no new pages or features after today. *Verify: release branch cut; change log closed.*
        - [ ] Confirm registrar access. *Verify: you can log in and see the domain's DNS records.*
        - [ ] Lower DNS TTL to 300 s. *Verify: dig shows the new TTL.*

        ## Phase 2 — T-1 day: rehearse
        - [ ] Run the full deploy on staging. *Verify: staging serves the release build.*
        - [ ] Check every form posts to the right inbox. *Verify: test submissions arrive.*
        """

    /// A Notion page as the server's rows show it: the title first, the markdown content last.
    static let notionPage = ApprovalPreview.action(ActionPreview(app: "Notion", toolName: "Create pages", rows: [
        DetailRow(label: "Title", value: "Website launch"), DetailRow(label: "Parent", value: "Page id: 1f2e3d4c"),
        DetailRow(label: "Creation mode", value: "draft"), DetailRow(label: "Content", value: runbook),
    ]))

    /// Every approval state: pending email, payment with expiry, signed, declined, expired, failed;
    /// a pending Notion page with long markdown content.
    static let approvalMessages: [Message] = [
        card("a1", minutesAgo: 20, .approval(approval("ap1", .email, email(), message: "a1"))),
        card("a2", minutesAgo: 18, .approval(approval("ap2", .payment, payment, expiresInMinutes: 8, message: "a2"))),
        card("a3", minutesAgo: 16, .approval(approval("ap3", .sign, sign, status: .approved, result: .init(ok: true, error: nil), message: "a3"))),
        card("a4", minutesAgo: 14, .approval(approval("ap4", .delete, delete, status: .declined, message: "a4"))),
        card("a5", minutesAgo: 12, .approval(approval("ap5", .action, action, status: .expired, message: "a5"))),
        card("a6", minutesAgo: 10, .approval(approval(
            "ap6", .email, email(body: "Short note: the files are attached.", subject: "Final files"), status: .approved,
            result: .init(ok: false, error: Phrase(text: "Gmail rejected the address.")), message: "a6"
        ))),
        card("a7", minutesAgo: 9, .approval(approval("ap7", .action, notionPage, message: "a7"))),
    ]

    static let infoMessages: [Message] = [
        card("i1", minutesAgo: 8, .confirmation(ConfirmationPayload(title: "Client review booked", detail: "Thu, 1:45 – 2:30 PM with the Atlas team", app: "Google Calendar"))),
        card("i2", minutesAgo: 6, .alert(AlertPayload(
            title: Phrase(text: "One thing needs you"), body: Phrase(text: "Slack disconnected, so I can't post the launch update."),
            action: .init(label: Phrase(text: "Open Slack"), type: .openURL, url: "https://slack.com", toolkit: nil)
        ))),
        card("i3", minutesAgo: 4, text: "Here's what looks like it's on your plate:", .plate(PlatePayload(items: [
            .init(id: "p1", title: "Reply to the venue", detail: "They need the headcount by noon", action: .init(label: "Draft", prompt: "Draft a reply to the venue with the headcount"), done: false),
            .init(id: "p2", title: "Dentist", detail: "Overdue check-up", action: .init(label: "Book", prompt: "Book a dentist appointment"), done: true),
            .init(id: "p3", title: "Q4 budget", detail: "First pass due Friday", action: .init(label: "Start", prompt: "Start the Q4 budget"), done: false),
        ]))),
    ]

    // MARK: M9

    static let pickOne = FormField(id: "f_pick", label: "Pick one", required: true, kind: .single(options: [
        FormOption(id: "cup", label: "Coffee cup", detail: nil),
        FormOption(id: "plane", label: "Paper plane", detail: nil),
        FormOption(id: "cat", label: "Sleeping cat", detail: nil),
    ], allowOther: false))

    static func drawForm(_ state: FormPayload.State, answers: [FormAnswer]? = nil) -> FormPayload {
        FormPayload(title: "Which one should I draw?", description: nil, icon: .design, fields: [pickOne],
                    submitLabel: nil, state: state, answers: answers)
    }

    /// M9: a form with several fields (multi + Other, single, text), a one-tap form open /
    /// submitted / skipped, the info card with every block type, and suggestions with icons.
    static let m9Messages: [Message] = [
        card("f1", minutesAgo: 3, text: "Two quick questions so I set this up right:", .form(FormPayload(
            title: "Your morning brief", description: "Pick what goes in it and when it arrives.", icon: .calendar,
            fields: [
                FormField(id: "f_what", label: "What should it cover?", required: true, kind: .multi(options: [
                    FormOption(id: "cal", label: "Today's calendar", detail: nil),
                    FormOption(id: "mail", label: "Emails that need a reply", detail: "From the last 24 hours"),
                    FormOption(id: "tasks", label: "Open tasks", detail: nil),
                ], allowOther: true)),
                FormField(id: "f_when", label: "When should it arrive?", required: true, kind: .single(options: [
                    FormOption(id: "7", label: "7:00 AM", detail: nil),
                    FormOption(id: "8", label: "8:00 AM", detail: nil),
                ], allowOther: true)),
                FormField(id: "f_note", label: "Anything else?", required: false, kind: .text(placeholder: nil, multiline: true)),
            ],
            submitLabel: "Set it up", state: .open, answers: nil
        ))),
        card("f2", minutesAgo: 2.6, text: "Three ideas for the loop:", .form(drawForm(.open))),
        card("f3", minutesAgo: 2.3, .form(drawForm(.submitted, answers: [FormAnswer(fieldId: "f_pick", optionIds: ["plane"], text: nil)]))),
        card("f4", minutesAgo: 2.1, .form(drawForm(.dismissed))),
        card("d1", minutesAgo: 1, text: "Here's where the launch stands:", .card(CardPayload(
            icon: .dashboard, tint: .blue, title: "Launch status", subtitle: "Updated a minute ago",
            blocks: [
                .metrics([
                    .init(label: "Tasks done", value: "12/20", delta: "+3", trend: .up),
                    .init(label: "Open bugs", value: "4", delta: "-2", trend: .down),
                    .init(label: "Days left", value: "6", delta: nil, trend: nil),
                    .init(label: "Reviews", value: "3", delta: "0", trend: .flat),
                ]),
                .progress(label: "QA checklist", value: 0.6, detail: "12 of 20"),
                .rows([
                    .init(icon: .calendar, title: "Launch review", detail: "Tue 1:45 PM", value: nil),
                    .init(icon: .mail, title: "Press note", detail: "Waiting on Sam", value: "Draft"),
                ]),
                .checklist([.init(text: "Final copy", done: true), .init(text: "App Store screenshots", done: false)]),
                .bars([.init(label: "Mon", value: 3), .init(label: "Tue", value: 5), .init(label: "Wed", value: 2), .init(label: "Thu", value: 6)], unit: "tasks"),
                .text("Next up: **screenshots** by Thursday, then the press note."),
                .unsupported(type: "map"),
            ],
            actions: [
                CardAction(label: "Draft the press note", type: .send, value: "Draft the press note", style: .primary),
                CardAction(label: "Open the plan", type: .openURL, value: "https://example.com/plan", style: .secondary),
                CardAction(label: "Not shown", type: .openURL, value: "http://example.com", style: .secondary),
            ]
        ))),
        card("s9", minutesAgo: 0.5, text: "A few things I could take on:", .taskSuggestions(TaskSuggestionsPayload(items: [
            .init(id: "s91", title: "Weekly numbers report", prompt: "Pull this week's numbers into a short report", app: nil, taskId: nil, icon: .chart),
            .init(id: "s92", title: "Plan the Lisbon trip", prompt: "Draft a 3-day plan with flights and a hotel", app: nil, taskId: nil, icon: .plane),
            .init(id: "s93", title: "Tidy the inbox", prompt: "Archive newsletters older than a week", app: nil, taskId: nil),
        ]))),
    ]

    // MARK: M20

    static func browser(_ site: String, _ button: String, _ category: BrowserAction.Category) -> ApprovalPreview {
        .action(ActionPreview(
            app: "OpenDuet's computer", toolName: "Click in the browser",
            rows: [DetailRow(label: "Site", value: site), DetailRow(label: "Button", value: button)],
            browser: BrowserAction(site: site, button: button, category: category, via: .click)
        ))
    }

    static let gmailSend = ApprovalPreview.email(EmailPreview(
        app: "Gmail", to: ["sam@example.com"], cc: [], subject: "Launch notes",
        body: "Hi Sam,\n\nNotes attached.\n\nAlex", attachments: []
    ))

    static let floorAction = ApprovalPreview.action(ActionPreview(app: "Gmail", toolName: "Update security settings", rows: [
        DetailRow(label: "Setting", value: "Two-step verification"), DetailRow(label: "Change", value: "Turn off"),
    ]))

    static func signIn(_ id: String, _ state: SignInPayload.State, step: SignInStep = .credentials, reason: String? = nil, outcome: SignInCardOutcome? = nil) -> MessageContent {
        .signIn(SignInPayload(
            requestId: "sir_\(id)", domain: "shop.example.com", state: state, step: step,
            reason: reason.map { Phrase(key: $0) }, outcome: outcome
        ))
    }

    /// M20: browser purchase (no Always), browser send with a site Always, Gmail send with a
    /// recipient Always, a safety-floor connector card with its why; the sign-in card's steps.
    static let m20Messages: [Message] = [
        card("b1", minutesAgo: 9, .approval(approval(
            "apb1", .action, browser("shop.example.com", "Place your order", .purchase),
            why: Phrase(key: "approval.why_purchase"), message: "b1"
        ))),
        card("b2", minutesAgo: 8, .approval(approval(
            "apb2", .action, browser("forum.example.org", "发布", .send), why: Phrase(key: "approval.why_send"),
            always: ApprovalAlways(scope: .site, value: "forum.example.org", category: .send), message: "b2"
        ))),
        card("b3", minutesAgo: 7, .approval(approval(
            "apb3", .email, gmailSend,
            always: ApprovalAlways(scope: .recipient, value: "sam@example.com", category: nil), message: "b3"
        ))),
        card("b4", minutesAgo: 6, .approval(approval(
            "apb4", .action, floorAction, why: Phrase(key: "approval.why_floor"), message: "b4"
        ))),
        card("g1", minutesAgo: 5, signIn("1", .pending)),
        card("g2", minutesAgo: 4, signIn("2", .pending, step: .code)),
        card("g3", minutesAgo: 3, signIn("3", .pending, step: .code, reason: "signin.code_rejected")),
        card("g4", minutesAgo: 2, signIn("4", .failed, reason: "signin.moved")),
        card("g5", minutesAgo: 1.5, signIn("5", .expired, outcome: .takenOver)),
        card("g6", minutesAgo: 1, signIn("6", .expired, outcome: .dismissed)),
    ]

    static var m20: ShellState {
        var state = ShellState(userName: "Alex Rivera")
        state.thread = ThreadState(phase: .loaded, messages: m20Messages)
        return state
    }

    /// The site card's tap in flight (both buttons and the Always row disabled), the purchase's
    /// Approve refused (reason with Retry).
    static var m20Busy: ShellState {
        var state = m20
        state.cardRequests = ["b2": .inFlight, "b1": .failed(reason: "Can't reach your server.")]
        return state
    }

    static var m9: ShellState {
        var state = ShellState(userName: "Alex Rivera")
        state.thread = ThreadState(phase: .loaded, messages: m9Messages)
        return state
    }

    /// The one-tap form sending, the brief form's Send refused by the server.
    static var m9Busy: ShellState {
        var state = m9
        state.cardRequests = ["f2": .inFlight, "f1": .failed(reason: "This form was already answered.")]
        return state
    }

    static var thread: ShellState {
        var state = ShellState(userName: "Alex Rivera", tasksNeedingUser: 3)
        state.thread = ThreadState(phase: .loaded, messages: taskMessages + approvalMessages + infoMessages)
        state.tasks.tasks = [spawnedTask]
        return state
    }

    /// Taps in flight and failed: Send spinning, a suggestion start failed.
    static var busy: ShellState {
        var state = thread
        state.cardRequests = ["a1": .inFlight, "c4": .failed(reason: "Can't reach your server.")]
        return state
    }
}
#endif
