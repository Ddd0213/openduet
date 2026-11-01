// Run lists (M8 brief §7): the OpenDuet sheet's "Activity" section (the 5 newest runs and "See
// all ›"), and the full list grouped by day (paged with ?before=, a skeleton row while the
// next page loads). Each row: a tile by step / kind, the title, the latest step, the time. A
// row pushes the run's detail inside the list's own page. Skeletons and empty states per L184.
import SwiftUI

/// One run in a list.
struct RunRow: View {
    var run: RunSummary
    var onOpen: () -> Void

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var detailSize: CGFloat = 13.5
    @ScaledMetric(relativeTo: .caption) private var timeSize: CGFloat = 12.5

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .center, spacing: 12) {
                IconTile(app: nil, systemImage: RunGlyph.row(run), size: 32, tint: Palette.primaryText)
                VStack(alignment: .leading, spacing: 2) {
                    Text(runTitle: run.title)
                        .font(.system(size: titleSize, weight: .medium))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    if let latest = run.latest {
                        HStack(spacing: 4) {
                            Text(runTitle: latest.title)
                                .layoutPriority(1)
                            if !latest.detail.isEmpty {
                                Text(verbatim: "· " + latest.detail)
                            }
                        }
                        .font(.system(size: detailSize))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing, spacing: 4) {
                    Text(verbatim: RunFormat(locale: locale).rowTime(run.createdAt))
                        .font(.system(size: timeSize).monospacedDigit())
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(1)
                    statusMark
                }
                .fixedSize()
                RowChevron()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(minHeight: Metrics.sheetRowMinHeight + 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("Run details"))
    }

    /// Only what needs noticing: a spinner while it runs, a red ✕ when it failed.
    @ViewBuilder private var statusMark: some View {
        if run.status.isOpen {
            SpinnerArc(size: 11, color: Palette.working, lineWidth: 1.6)
                .accessibilityLabel(Text("Running"))
        } else if run.status == .failed {
            // M9: the set's failed mark (a line drawing, not a filled SF circle).
            DuetIcon(glyph: .failed, size: 15, tint: Palette.failure)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text("Failed"))
        }
    }
}

/// The full list of one scope (all runs, or one task's), grouped by day, paged.
struct RunsListPage: View {
    var scope: RunScope
    var title: Text
    var leading: SheetHeaderLeading
    var onLeading: () -> Void

    @Environment(\.runs) private var runs
    @Environment(\.locale) private var locale
    @State private var openRunId: String?

    private var list: RunListState { runs.state.list(scope) }

    var body: some View {
        PushContainer(page: $openRunId) {
            VStack(spacing: 0) {
                SheetHeader(title: title, leading: leading, onLeading: onLeading)
                ScrollView {
                    content
                        .padding(.horizontal, 16)
                        .padding(.bottom, 32)
                }
                .scrollIndicators(.hidden)
                .refreshable { runs.actions.loadList(scope) }
            }
        } destination: { runId in
            RunDetailPage(runId: runId, leading: .back) { openRunId = nil }
        }
        .onAppear { runs.actions.loadList(scope) }
    }

    @ViewBuilder private var content: some View {
        switch TaskRunsChoice(list) {
        case .loading:
            RunRowsSkeleton(rows: 6).padding(.top, 8)
        case .failed(let reason):
            InlineRetryLine(reason: reason) { runs.actions.loadList(scope) }
                .cardSurface()
                .padding(.top, 8)
        case .empty:
            EmptyStateView(systemImage: DuetGlyph.clock.symbol, message: "Nothing here yet")
                .frame(maxWidth: .infinity)
                .padding(.top, 80)
        case .single, .list:
            days
        }
    }

    private var days: some View {
        let format = RunFormat(locale: locale)
        return LazyVStack(alignment: .leading, spacing: 18) {
            ForEach(RunDay.group(list.runs)) { day in
                VStack(alignment: .leading, spacing: 0) {
                    SheetSectionTitle(text: format.dayHeader(day.day))
                    CardSection(dividerInset: 16 + 32 + 12) {
                        ForEach(day.runs) { run in
                            RunRow(run: run) { openRunId = run.id }
                        }
                    }
                }
            }
            pageEnd
        }
        .padding(.top, 8)
        .animation(.easeInOut(duration: 0.2), value: list.runs.map(\.id))
    }

    /// The end of the list: the next page's skeleton, its failure with Retry, or the trigger.
    @ViewBuilder private var pageEnd: some View {
        if list.loadingMore {
            RunRowsSkeleton(rows: 1)
        } else if let reason = list.moreError {
            InlineRetryLine(reason: reason) { runs.actions.loadMore(scope) }
                .cardSurface()
        } else if list.hasMore {
            Color.clear
                .frame(height: 1)
                .onAppear { runs.actions.loadMore(scope) }
        }
    }
}

/// The OpenDuet sheet's "Activity" (under "What OpenDuet has access to"): the 5 newest runs and
/// "See all ›".
struct RunsActivitySection: View {
    var onOpenRun: (String) -> Void
    var onSeeAll: () -> Void

    @Environment(\.runs) private var runs

    static let limit = 5

    private var list: RunListState { runs.state.list(.all) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Activity"))
            switch TaskRunsChoice(list) {
            case .loading:
                RunRowsSkeleton(rows: 3)
            case .failed(let reason):
                InlineRetryLine(reason: reason) { runs.actions.loadList(.all) }
                    .cardSurface()
            case .empty:
                Text("Nothing here yet")
                    .font(.system(size: 15))
                    .foregroundStyle(Palette.secondaryText)
                    .frame(maxWidth: .infinity, minHeight: Metrics.sheetRowMinHeight)
                    .cardSurface()
            case .single, .list:
                CardSection(dividerInset: 16 + 32 + 12) {
                    ForEach(list.runs.prefix(Self.limit)) { run in
                        RunRow(run: run) { onOpenRun(run.id) }
                    }
                    SheetRow(title: Text("See all"), action: onSeeAll) {
                        RowSymbol(systemImage: DuetGlyph.contents.symbol, tint: Palette.secondaryText)
                    } trailing: {
                        RowChevron()
                    }
                }
            }
        }
        .animation(.easeInOut(duration: 0.25), value: list.phase)
        .onAppear { runs.actions.loadList(.all) }
    }
}
