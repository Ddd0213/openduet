// Previews of the Tasks tab, Up next, the + sheet and task detail (prompt L3, L116-L121) with
// placeholder fixtures; the app never shows these. DEBUG only.
#if DEBUG
import SwiftUI

extension TaskDetail {
    /// Preview fixtures only (the app decodes TaskDetail from GET /api/tasks/:id).
    init(summary: TaskSummary, description: String, noticedAt: Date?, steps: [TaskStep], updates: [TaskUpdate], resources: [TaskResource]) {
        self.summary = summary
        self.prompt = summary.title
        self.description = description
        self.noticedAt = noticedAt
        self.steps = steps
        self.updates = updates
        self.resources = resources
    }
}

enum TasksFixtures {
    static let now = CardFixtures.now

    static let tasks: [TaskSummary] = [
        CardFixtures.task("t4", "Draft the launch announcement for the newsletter", .readyForReview, minutesAgo: 1, updates: 3, latest: "Drafted a version for you to review"),
        CardFixtures.task("t5", "Find a venue for the team offsite in March", .readyForReview, minutesAgo: 12, updates: 5, latest: "Shortlisted three venues", source: .proactive),
        CardFixtures.task("t6", "Confirm the headcount with the caterer", .needsInput, minutesAgo: 20, updates: 2, latest: "Waiting on the final headcount"),
        CardFixtures.spawnedTask,
        CardFixtures.task("t7", "Clean up the shared drive", .resolved, minutesAgo: 300, updates: 4, latest: "Moved 38 files to the archive"),
        CardFixtures.task("t8", "Summarise the user interviews", .working, minutesAgo: 3, updates: 1, latest: "Reading the interview notes", channel: "ch_research"),
    ]

    static let research = Channel(
        id: "ch_research", isMain: false, name: "research", icon: .magnifier, colorHex: .blue, purpose: "",
        archived: false, unreadCount: 0, lastReadAt: nil, lastMessageAt: nil, createdAt: now
    )

    static let suggestions: [Suggestion] = [
        Suggestion(id: "g1", channelId: nil, title: "Reply to the venue about dates", body: "They offered two weekends in March and asked which works.", app: "Gmail", origin: .checkin, createdAt: now),
        Suggestion(id: "g2", channelId: nil, title: "Prep the client review agenda", body: "Thursday's review has no agenda yet.", app: "Google Calendar", origin: .scan, createdAt: now),
    ]

    static var tasksState: TasksState {
        var state = TasksState()
        state.phase = .loaded
        state.tasks = tasks
        state.updatedAt = now.addingTimeInterval(-60)
        state.channelNames = ["main": "Everything", "ch_research": "research"]
        state.upNext = UpNextState(phase: .loaded, suggestions: suggestions, scanning: false)
        return state
    }

    static var shell: ShellState {
        var state = ShellState(userName: "Alex Rivera", tasksNeedingUser: 3)
        state.thread = ThreadState(phase: .loaded)
        state.tasks = tasksState
        state.menu.channels = [research]
        state.cardRequests = ["t6": .failed(reason: "Can't reach your server.")]
        return state
    }

    static let detail = TaskDetail(
        summary: CardFixtures.task("t5", "Find a venue for the team offsite in March", .working, minutesAgo: 2, updates: 2, source: .proactive),
        description: "Your team offsite has dates but no venue yet. I'm comparing places near the office that fit 14 people and the budget in the planning doc.",
        noticedAt: now.addingTimeInterval(-3 * 3600),
        steps: [
            TaskStep(id: "st1", text: "Read the offsite planning doc", state: .done),
            TaskStep(id: "st2", text: "Shortlist venues for 14 people", state: .current),
            TaskStep(id: "st3", text: "Draft an enquiry email for the top pick", state: .planned),
        ],
        updates: [
            TaskUpdate(text: Phrase(text: "Kept the budget under $3,000 as the doc says"), source: "Google Docs", at: now.addingTimeInterval(-50 * 60)),
            TaskUpdate(text: Phrase(text: "Ruled out two venues without parking"), source: "OpenDuet", at: now.addingTimeInterval(-10 * 60)),
        ],
        resources: [
            TaskResource(title: "Offsite planning", type: .doc, link: "https://docs.google.com/document/d/example", app: "Google Docs"),
            TaskResource(title: "Venue shortlist", type: .artifact, link: "duet://artifacts/art_2", app: nil),
        ]
    )

    static var detailShell: ShellState {
        var state = shell
        var open = TaskDetailState(taskId: "t5", phase: .loaded, task: detail, status: .searchingEmail)
        open.thread = ThreadState(phase: .loaded, messages: [
            ChatFixtures.message("d1", .assistant, "I found three venues that fit. Want me to ask the first one about March dates?", minutesAgo: 6),
            ChatFixtures.message("d2", .user, "Yes, ask about the second weekend.", minutesAgo: 5, status: .seen),
            CardFixtures.card("d3", minutesAgo: 4, .approval(CardFixtures.approval("ap9", .email, CardFixtures.email(
                body: "Hello,\n\nWe're planning a team offsite for 14 people on the second weekend of March. Is the main room free?\n\nThanks,\nAlex",
                subject: "Offsite enquiry"
            ), message: "d3"))),
        ], context: .task)
        state.taskDetail = open
        return state
    }
}

/// The list's other states side by side: skeleton, failed, empty, and Up next's empty state.
private struct TasksStatesPreview: View {
    private var states: [TasksState] {
        var loading = TasksState()
        loading.phase = .loading
        var failed = TasksState()
        failed.phase = .failed(reason: "Can't reach your server.")
        var empty = TasksState()
        empty.phase = .loaded
        return [loading, failed, empty]
    }

    var body: some View {
        TabView {
            ForEach(Array(states.enumerated()), id: \.offset) { index, state in
                TasksTabView(
                    state: state, requests: [:], actions: TaskActions(), rowActions: [:], searchFocused: .constant(false),
                    onMarkComplete: { _ in }, onArchive: { _ in }, onMessageAssistant: {}
                )
                .background(Palette.background)
                .tabItem { Text(verbatim: "\(index)") }
            }
            ScrollView {
                UpNextList(state: UpNextState(phase: .loaded), requests: [:], actions: TaskActions())
            }
            .background(Palette.background)
            .tabItem { Text(verbatim: "Up next") }
        }
    }
}

#Preview("Tasks – Active") {
    MainShellView(state: TasksFixtures.shell, actions: ShellActions(), initialTab: .tasks)
}

#Preview("Tasks – Active, dark, Chinese") {
    MainShellView(state: TasksFixtures.shell, actions: ShellActions(), initialTab: .tasks)
        .preferredColorScheme(.dark)
        .environment(\.locale, Locale(identifier: "zh-Hans"))
}

#Preview("Tasks – loading / failed / empty / Up next empty") {
    TasksStatesPreview()
}

#Preview("Task detail") {
    MainShellView(state: TasksFixtures.detailShell, actions: ShellActions())
}

#Preview("Task detail – dark, Chinese") {
    MainShellView(state: TasksFixtures.detailShell, actions: ShellActions())
        .preferredColorScheme(.dark)
        .environment(\.locale, Locale(identifier: "zh-Hans"))
}

#Preview("New task sheet") {
    Color.clear.sheet(isPresented: .constant(true)) {
        NewTaskSheet(request: nil, onStart: { _ in }, onDone: {})
    }
}
#endif
