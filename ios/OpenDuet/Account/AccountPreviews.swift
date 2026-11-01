// Previews of the M4 screens with AccountFixtures (DEBUG only): side menu, New channel, the assistant
// sheet, connector detail, profile, the M9 Usage panel (loaded, today in dark Chinese, loading /
// empty / failed ranges) and the schedule sheet, in English and Chinese.
#if DEBUG
import SwiftUI

#Preview("Side menu") {
    SideMenuView(
        menu: AccountFixtures.shell().menu,
        requests: [ShellState.RequestKey.archive("c2"): .failed(reason: "Couldn't archive Hiring. Try again.")],
        actions: MenuActions(), onSelect: { _ in }, onNewChannel: {}
    )
    .frame(width: 320)
}

#Preview("Archived") {
    ArchivedChannelsView(
        archived: AccountFixtures.archived, error: nil,
        requests: [ShellState.RequestKey.archive("c9"): .inFlight],
        onLoad: {}, onUnarchive: { _ in }, onBack: {}
    )
    .background(Palette.sheetBackground)
}

#Preview("New channel") {
    NewChannelSheet(request: nil, onCreate: { _, _, _, _ in }, onCancel: {}, onCreated: {})
        .background(Palette.sheetBackground)
}

#Preview("OpenDuet sheet") {
    AssistantSheet(
        assistant: AccountFixtures.assistant, requests: [ShellState.RequestKey.connect("googledrive"): .inFlight],
        actions: ConnectorActions(), onClose: {}
    )
    .background(Palette.sheetBackground)
}

#Preview("OpenDuet sheet, zh") {
    AssistantSheet(assistant: AccountFixtures.assistant, requests: [:], actions: ConnectorActions(), onClose: {})
        .background(Palette.sheetBackground)
        .environment(\.locale, Locale(identifier: "zh-Hans"))
}

#Preview("Connector detail") {
    ConnectorDetailSheet(
        detail: AccountFixtures.detail,
        requests: [ShellState.RequestKey.policy("gmail", tool: "GMAIL_CREATE_DRAFT"): .failed(reason: "Couldn't save. Try again.")],
        actions: ConnectorActions()
    )
    .background(Palette.sheetBackground)
}

#Preview("Profile") {
    ProfileSheet(state: ProfileSheetState(AccountFixtures.shell()), actions: ShellActions(), onClose: {})
        .background(Palette.sheetBackground)
}

#Preview("Usage panel") {
    UsagePanelPreview(screen: UsagePreviewData.screen(.sevenDays))
}

#Preview("Usage panel, today, dark, zh") {
    UsagePanelPreview(screen: UsagePreviewData.screen(.today))
        .preferredColorScheme(.dark)
        .environment(\.locale, Locale(identifier: "zh-Hans"))
}

#Preview("Usage panel, loading / empty / failed") {
    var screen = UsagePreviewData.screen(.sevenDays)
    screen.stats[.sevenDays] = nil
    screen.statsPhase[.sevenDays] = .loading
    screen.stats[.thirtyDays] = UsagePreviewData.empty(.thirtyDays)
    screen.statsPhase[.all] = .failed(reason: "Can't reach your server.")
    return UsagePanelPreview(screen: screen)
}

/// The panel with a store stand-in: a picked range shows its cached stats.
private struct UsagePanelPreview: View {
    @State var screen: UsageScreenState

    var body: some View {
        UsageView(screen: screen, leading: .close, onLeading: {}) { range in screen.range = range }
            .background(Palette.sheetBackground)
    }
}

/// Usage stats for the previews (GET /api/usage/stats shapes). Model names are placeholders.
private enum UsagePreviewData {
    static func screen(_ range: UsageRange) -> UsageScreenState {
        var screen = UsageScreenState(phase: .loaded)
        screen.range = range
        for range in [UsageRange.today, .sevenDays] {
            screen.stats[range] = stats(range)
            screen.statsPhase[range] = .loaded
        }
        return screen
    }

    static func stats(_ range: UsageRange) -> UsageStats {
        let today = range == .today
        let calendar = Calendar.current
        let start = today ? calendar.startOfDay(for: AccountFixtures.now) : calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: AccountFixtures.now))!
        let inputs = today ? [0, 0, 0, 0, 0, 0, 0, 0, 42_000, 120_000, 86_000, 30_000, 12_000, 64_000] : [380_000, 910_000, 120_000, 640_000, 1_420_000, 260_000, 530_000]
        let series = inputs.enumerated().map { index, input in
            UsageStats.Point(
                start: calendar.date(byAdding: today ? .hour : .day, value: index, to: start)!,
                inputTokens: input, outputTokens: input / 4
            )
        }
        let input = inputs.reduce(0, +), output = input / 4
        return UsageStats(
            range: range, since: start, until: AccountFixtures.now,
            totals: .init(inputTokens: input, outputTokens: output, runs: today ? 14 : 182),
            estimated: !today,
            byModel: [
                .init(model: "fast-1", label: "Fast model", provider: "Gateway A", inputTokens: input / 5, outputTokens: output / 5, runs: 120),
                .init(model: "large-2", label: "Large model", provider: "Gateway B", inputTokens: input * 4 / 5, outputTokens: output * 4 / 5, runs: 62),
            ],
            byKind: [
                .init(kind: .chat, inputTokens: input / 2, outputTokens: output / 2, runs: 100),
                .init(kind: .task, inputTokens: input / 4, outputTokens: output / 4, runs: 40),
                .init(kind: .proactive, inputTokens: input / 4, outputTokens: output / 4, runs: 42),
            ],
            bucket: today ? .hour : .day, series: series
        )
    }

    static func empty(_ range: UsageRange) -> UsageStats {
        UsageStats(
            range: range, since: nil, until: AccountFixtures.now,
            totals: .init(inputTokens: 0, outputTokens: 0, runs: 0), estimated: false,
            byModel: [], byKind: [], bucket: .day, series: []
        )
    }
}

#Preview("Check-in sheet") {
    ScheduleSheet(kind: .checkin, info: AccountFixtures.schedule, request: nil, onRunNow: {}, onClose: {})
        .background(Palette.sheetBackground)
}

#Preview("Scheduled rows") {
    ScheduledRows(info: AccountFixtures.schedule, now: Date()) { _ in }
        .padding()
        .background(Palette.background)
}
#endif
