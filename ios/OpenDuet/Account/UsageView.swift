// M9 Usage panel (contract §5, 修改意见: "把用量页面改成一个面板"): no resets, limits or meters.
// A range control (Today / 7 days / 30 days / All), the hero total ("1.2M tokens") with the
// input / output split and the run count, a stacked Swift Charts trend by bucket (hour / day /
// month), "By model" rows with a share bar (most first), "By kind" tiles (Chat, Tasks, Make,
// Scheduled & proactive) and an "estimated" footnote. Each range loads through
// AccountActions.loadUsageStats and stays cached in UsageScreenState.stats; skeletons while the
// first answer runs, "No usage yet" for an empty range, the reason + Retry when it failed.
import Charts
import SwiftUI

struct UsageView: View {
    var screen: UsageScreenState
    var leading: SheetHeaderLeading
    var onLeading: () -> Void
    /// AccountActions.loadUsageStats: the panel appeared, a range was picked, or Retry.
    var onLoad: (_ range: UsageRange) -> Void

    init(screen: UsageScreenState, leading: SheetHeaderLeading, onLeading: @escaping () -> Void,
         onLoad: @escaping (_ range: UsageRange) -> Void) {
        self.screen = screen
        self.leading = leading
        self.onLeading = onLeading
        self.onLoad = onLoad
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The tapped range until the store's echo arrives (previews and a slow store still move).
    @State private var picked: UsageRange?
    @State private var picks = 0

    private var range: UsageRange { picked ?? screen.range }
    private var stats: UsageStats? { screen.stats[range] }
    private var phase: TasksState.Phase? { screen.statsPhase[range] }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Usage"), leading: leading, onLeading: onLeading) {
                InfoButton(
                    label: Text("About usage"),
                    message: Text("Usage counts the tokens OpenDuet reads and writes for you, the same way for every model: chats, tasks, Make and scheduled work."),
                    size: 17
                )
                .floatingCircle(Metrics.headerCircle)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    UsageRangePicker(selection: range) { pick($0) }
                    content
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.45, dampingFraction: 0.86), value: stats)
        .animation(.easeInOut(duration: 0.2), value: range)
        .sensoryFeedback(.selection, trigger: picks)
        .onAppear { onLoad(range) }
        .onChange(of: screen.range) { _, new in if new == picked { picked = nil } }
    }

    @ViewBuilder private var content: some View {
        if let stats {
            if UsageMath.isEmpty(stats) {
                UsageEmpty().transition(.opacity)
            } else {
                UsageDashboard(stats: stats).transition(.opacity)
            }
        } else if case .failed(let reason)? = phase {
            InlineRetryLine(reason: reason) { onLoad(range) }.transition(.opacity)
        } else {
            UsageSkeleton().transition(.opacity)
        }
    }

    private func pick(_ new: UsageRange) {
        guard new != range else { return }
        picks += 1
        picked = new
        onLoad(new)
    }
}

// MARK: - Range

/// Today / 7 days / 30 days / All: a capsule track with a pill that slides to the pick.
struct UsageRangePicker: View {
    var selection: UsageRange
    var onPick: (UsageRange) -> Void

    @Namespace private var pill
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 14

    var body: some View {
        HStack(spacing: 2) {
            ForEach(UsageRange.allCases, id: \.self) { range in
                let selected = range == selection
                Button { onPick(range) } label: {
                    range.pickerTitle
                        .font(.system(size: fontSize, weight: selected ? .semibold : .medium))
                        .foregroundStyle(selected ? Palette.primaryText : Palette.secondaryText)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity, minHeight: 34)
                        .background {
                            if selected {
                                Capsule()
                                    .fill(Palette.floatingSurface)
                                    .shadow(color: .black.opacity(0.08), radius: 3, y: 1)
                                    .matchedGeometryEffect(id: "pill", in: pill)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(PressableButtonStyle(scale: 0.96))
                .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
            }
        }
        .padding(3)
        .background(Capsule().fill(Palette.usageTrack))
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.35, dampingFraction: 0.82), value: selection)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Usage range"))
    }
}

extension UsageRange {
    var pickerTitle: Text {
        switch self {
        case .today: Text("Today")
        case .sevenDays: Text("7 days")
        case .thirtyDays: Text("30 days")
        case .all: Text("All")
        }
    }

    /// The hero's label. 7d is a rolling window, so "Last 7 days" (not a calendar week).
    var heroTitle: Text {
        switch self {
        case .today: Text("Today")
        case .sevenDays: Text("Last 7 days")
        case .thirtyDays: Text("Last 30 days")
        case .all: Text("All time")
        }
    }
}

extension Palette {
    /// The panel's input / output inks (chart, split bar, legend dots).
    static let usageInput = Color.dynamic(light: 0x3B7DDD, dark: 0x5E9BF0)
    static let usageOutput = Color.dynamic(light: 0xC7604A, dark: 0xE07A63)
}

// MARK: - Dashboard

private struct UsageDashboard: View {
    var stats: UsageStats

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            UsageHero(stats: stats)
            if stats.series.contains(where: { $0.total > 0 }) {
                UsageTrend(stats: stats)
            }
            let models = UsageMath.modelsByUse(stats.byModel).filter { $0.total > 0 }
            if !models.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    SheetSectionTitle(text: Text("By model"))
                    CardSection {
                        ForEach(Array(models.enumerated()), id: \.element.id) { index, row in
                            UsageModelRow(row: row, total: stats.totals.total, tint: CardTint.allCases[index % CardTint.allCases.count].color)
                        }
                    }
                }
            }
            VStack(alignment: .leading, spacing: 0) {
                SheetSectionTitle(text: Text("By kind"))
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                    ForEach(UsageMath.kindTiles(stats.byKind)) { row in
                        UsageKindTile(row: row, total: stats.totals.total)
                    }
                }
            }
            if stats.estimated {
                HStack(alignment: .top, spacing: 6) {
                    DuetIcon(glyph: .info, size: 16, tint: Palette.secondaryText)
                    Text("Some counts are estimated: the model gateway didn't report them, so they were counted from the text.")
                        .font(.footnote)
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 6)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// "Last 7 days" · "1.2M tokens" · the input / output split bar · Input, Output, Runs.
private struct UsageHero: View {
    var stats: UsageStats

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .largeTitle) private var totalSize: CGFloat = 40
    @ScaledMetric(relativeTo: .subheadline) private var labelSize: CGFloat = 14

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                stats.range.heroTitle
                    .font(.system(size: labelSize, weight: .medium))
                    .foregroundStyle(Palette.secondaryText)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verbatim: UsageMath.tokens(stats.totals.total, locale: locale))
                        .font(.system(size: totalSize, weight: .semibold).monospacedDigit())
                        .foregroundStyle(Palette.primaryText)
                        .contentTransition(.numericText(value: Double(stats.totals.total)))
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    Text("tokens")
                        .font(.system(size: labelSize + 2, weight: .medium))
                        .foregroundStyle(Palette.secondaryText)
                }
            }
            UsageSplitBar(input: stats.totals.inputTokens, output: stats.totals.outputTokens)
            HStack(alignment: .top, spacing: 12) {
                stat(Text("Input"), UsageMath.tokens(stats.totals.inputTokens, locale: locale), dot: Palette.usageInput)
                stat(Text("Output"), UsageMath.tokens(stats.totals.outputTokens, locale: locale), dot: Palette.usageOutput)
                stat(Text("Runs"), stats.totals.runs.formatted(.number.locale(locale)), dot: nil)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
        .accessibilityElement(children: .combine)
    }

    private func stat(_ label: Text, _ value: String, dot: Color?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                if let dot { Circle().fill(dot).frame(width: 7, height: 7).accessibilityHidden(true) }
                label
                    .font(.system(size: labelSize - 1))
                    .foregroundStyle(Palette.secondaryText)
                    .lineLimit(1)
            }
            Text(verbatim: value)
                .font(.system(size: labelSize + 3, weight: .semibold).monospacedDigit())
                .foregroundStyle(Palette.primaryText)
                .contentTransition(.numericText())
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Input then output, one rounded bar split by their shares.
private struct UsageSplitBar: View {
    var input: Int
    var output: Int

    var body: some View {
        GeometryReader { geo in
            let share = UsageMath.share(input, of: input + output)
            let gap: CGFloat = input > 0 && output > 0 ? 3 : 0
            HStack(spacing: gap) {
                if input > 0 {
                    Capsule().fill(Palette.usageInput).frame(width: max((geo.size.width - gap) * share, 6))
                }
                if output > 0 {
                    Capsule().fill(Palette.usageOutput)
                }
            }
        }
        .frame(height: 8)
        .background(Capsule().fill(Palette.usageTrack))
        .accessibilityHidden(true)
    }
}

// MARK: - Trend

/// Input + output stacked per bucket (hour today, day for 7 / 30 days, month for all).
private struct UsageTrend: View {
    var stats: UsageStats

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .body) private var chartHeight: CGFloat = 170
    @ScaledMetric(relativeTo: .footnote) private var legendSize: CGFloat = 13

    var body: some View {
        let unit = stats.bucket.calendarUnit
        let format = stats.bucket.axisFormat
        let ticks = stats.bucket == .day && stats.series.count <= 8 ? stats.series.count : 5
        let locale = locale
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 14) {
                legend(Text("Input"), Palette.usageInput)
                legend(Text("Output"), Palette.usageOutput)
                Spacer(minLength: 0)
            }
            Chart(stats.series) { point in
                BarMark(
                    x: .value(Text(verbatim: "start"), point.start, unit: unit),
                    y: .value(Text("Input"), point.inputTokens)
                )
                .foregroundStyle(Palette.usageInput)
                .accessibilityLabel(Text(point.start, format: format))
                .accessibilityValue(Text("Input \(UsageMath.tokens(point.inputTokens, locale: locale))"))
                BarMark(
                    x: .value(Text(verbatim: "start"), point.start, unit: unit),
                    y: .value(Text("Output"), point.outputTokens)
                )
                .foregroundStyle(Palette.usageOutput)
                .accessibilityLabel(Text(point.start, format: format))
                .accessibilityValue(Text("Output \(UsageMath.tokens(point.outputTokens, locale: locale))"))
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: ticks)) { _ in
                    AxisValueLabel(format: format)
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { value in
                    AxisGridLine().foregroundStyle(Palette.cardBorder)
                    AxisValueLabel {
                        if let tokens = value.as(Int.self) {
                            Text(verbatim: UsageMath.tokens(tokens, locale: locale))
                        }
                    }
                }
            }
            .frame(height: chartHeight)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
    }

    private func legend(_ title: Text, _ color: Color) -> some View {
        HStack(spacing: 5) {
            RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 9, height: 9).accessibilityHidden(true)
            title.font(.system(size: legendSize)).foregroundStyle(Palette.secondaryText)
        }
    }
}

extension UsageStats.Bucket {
    var calendarUnit: Calendar.Component {
        switch self {
        case .hour: .hour
        case .day: .day
        case .month: .month
        }
    }

    /// "9 AM" / "Mon 3" / "Nov" in the app's locale.
    var axisFormat: Date.FormatStyle {
        switch self {
        case .hour: .dateTime.hour()
        case .day: .dateTime.month(.abbreviated).day()
        case .month: .dateTime.month(.abbreviated)
        }
    }
}

// MARK: - By model, by kind

/// A model's label and provider, its tokens and share, and a share bar.
private struct UsageModelRow: View {
    var row: UsageStats.ModelRow
    var total: Int
    var tint: Color

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .footnote) private var detailSize: CGFloat = 13

    var body: some View {
        let share = UsageMath.share(row.total, of: total)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: row.label)
                        .font(.system(size: titleSize, weight: .medium))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(2)
                    if let provider = row.provider, !provider.isEmpty {
                        Text(verbatim: provider)
                            .font(.system(size: detailSize))
                            .foregroundStyle(Palette.secondaryText)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(verbatim: UsageMath.tokens(row.total, locale: locale))
                        .font(.system(size: titleSize, weight: .semibold).monospacedDigit())
                        .foregroundStyle(Palette.primaryText)
                        .contentTransition(.numericText())
                    Text(verbatim: UsageMath.percentText(share, locale: locale))
                        .font(.system(size: detailSize).monospacedDigit())
                        .foregroundStyle(Palette.secondaryText)
                }
            }
            TintBar(fraction: share, color: tint, height: 6)
        }
        .padding(16)
        .accessibilityElement(children: .combine)
    }
}

/// One kind's tile: its glyph, name, tokens and share.
private struct UsageKindTile: View {
    var row: UsageStats.KindRow
    var total: Int

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .subheadline) private var titleSize: CGFloat = 14
    @ScaledMetric(relativeTo: .title3) private var valueSize: CGFloat = 20

    var body: some View {
        let share = UsageMath.share(row.total, of: total)
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                DuetIconTile(glyph: row.kind.glyph, size: 30)
                row.kind.title
                    .font(.system(size: titleSize, weight: .medium))
                    .foregroundStyle(Palette.primaryText)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
            }
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: UsageMath.tokens(row.total, locale: locale))
                    .font(.system(size: valueSize, weight: .semibold).monospacedDigit())
                    .foregroundStyle(row.total > 0 ? Palette.primaryText : Palette.secondaryText)
                    .contentTransition(.numericText())
                Spacer(minLength: 4)
                Text(verbatim: UsageMath.percentText(share, locale: locale))
                    .font(.system(size: titleSize - 1).monospacedDigit())
                    .foregroundStyle(Palette.secondaryText)
            }
            TintBar(fraction: share, color: Palette.primaryText.opacity(0.75), height: 5)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
        .accessibilityElement(children: .combine)
    }
}

extension UsageStats.KindRow.Kind {
    var title: Text {
        switch self {
        case .chat: Text("Chat")
        case .task: Text("Tasks")
        case .build: Text("Make")
        case .proactive: Text("Scheduled & proactive")
        }
    }

    var glyph: DuetGlyph {
        switch self {
        case .chat: .chat
        case .task: .tasks
        case .build: .make
        case .proactive: .clock
        }
    }
}

// MARK: - Empty, loading

private struct UsageEmpty: View {
    var body: some View {
        EmptyStateView(systemImage: "chart.bar.xaxis", message: "No usage yet")
            .frame(maxWidth: .infinity)
            .padding(.top, 48)
    }
}

/// The panel's shape while a range's first answer runs: hero, chart, model rows.
private struct UsageSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 12) {
                RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(width: 90, height: 12)
                RoundedRectangle(cornerRadius: 6).fill(Palette.skeleton).frame(width: 170, height: 34)
                Capsule().fill(Palette.skeleton).frame(height: 8)
                HStack(spacing: 12) {
                    ForEach(0..<3, id: \.self) { _ in
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(height: 28)
                    }
                }
            }
            .padding(16)
            .cardSurface()
            HStack(alignment: .bottom, spacing: 8) {
                ForEach([0.4, 0.7, 0.3, 0.9, 0.55, 0.65, 0.2], id: \.self) { height in
                    RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(height: 120 * height)
                }
            }
            .frame(height: 120, alignment: .bottom)
            .padding(16)
            .cardSurface()
            VStack(spacing: 0) {
                ForEach(0..<2, id: \.self) { _ in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(width: 130, height: 14)
                            Spacer()
                            RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(width: 50, height: 14)
                        }
                        Capsule().fill(Palette.skeleton).frame(height: 6)
                    }
                    .padding(16)
                }
            }
            .cardSurface()
        }
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading usage"))
    }
}
