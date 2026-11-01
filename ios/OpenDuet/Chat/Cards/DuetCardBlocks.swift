// The info card's blocks (DuetCard.swift, contract §2): markdown text, icon rows with a trailing
// value, a 2-column metric grid with trend-coloured deltas, a progress bar, a checklist with the
// set's done / pending marks and a small Swift Charts bar chart; M22: a group of rows with a
// count (show_tasks); M24: a line chart (1-3 series, gaps for null) and checkable checklists
// (items with an id: check / uncheck, at once, put back on failure; rules in CardBlockRules). A
// block type from a newer server (`unsupported`) is skipped. Also the CardTint -> light / dark
// colour pairs.
import Charts
import SwiftUI

// MARK: - Tints

extension CardTint {
    /// The tint as a light / dark pair: the header tile's accent, bars, progress fill.
    var color: Color {
        switch self {
        case .orange: Color.dynamic(light: 0xD9730D, dark: 0xF0954A)
        case .blue: Color.dynamic(light: 0x2F6FD6, dark: 0x6EA4FF)
        case .green: Color.dynamic(light: 0x1F8A4C, dark: 0x3DC47A)
        case .purple: Color.dynamic(light: 0x7B5BD6, dark: 0xA48BF0)
        case .amber: Color.dynamic(light: 0xB7791F, dark: 0xF2B544)
        case .red: Color.dynamic(light: 0xD14343, dark: 0xF06A6A)
        case .grey: Color.dynamic(light: 0x6E6E6A, dark: 0xA4A4A0)
        }
    }

    /// The header icon's stroke: the set's neutral for grey, the tint otherwise.
    var tileGlyph: Color {
        self == .grey ? Palette.tileGlyph : color
    }
}

extension CardBlock {
    /// Block types this build can draw; the rest are skipped silently.
    var isSupported: Bool {
        if case .unsupported = self { return false }
        return true
    }
}

// MARK: - Blocks

struct DuetCardBlockView: View {
    var block: CardBlock
    var tint: CardTint
    /// M24: the card's message, for a checkable checklist's check / uncheck (nil: read-only).
    var messageId: String? = nil
    /// M24: POST /api/messages/:id/action {check | uncheck, itemId} (CardActions.action).
    var onCheck: ((_ itemId: String, _ done: Bool) -> Void)? = nil

    var body: some View {
        switch block {
        case .text(let text):
            MarkdownView(blocks: MarkdownCache.blocks(text), color: Palette.primaryText)
        case .rows(let rows):
            CardRowsBlock(rows: rows)
        case .metrics(let items):
            CardMetricsBlock(items: items)
        case .progress(let label, let value, let detail):
            CardProgressBlock(label: label, value: value, detail: detail, tint: tint)
        case .checklist(let items):
            CardChecklistBlock(items: items, messageId: messageId, onCheck: onCheck)
        case .bars(let bars, let unit):
            CardBarsBlock(bars: bars, unit: unit, tint: tint)
        // M22: show_tasks ("Needs you 2" and its rows).
        case .group(let group):
            CardGroupBlock(group: group)
        // M24: a trend (1-3 series, gaps for null).
        case .lineChart(let chart):
            CardLineChartBlock(chart: chart, tint: tint)
        case .unsupported:
            EmptyView()
        }
    }
}

/// M22 (show_tasks): the group's title with its count, the `empty` line when it has no rows, then
/// up to five rows (title, detail) that open their `route` through the thread's OpenURLAction:
/// duet://tasks/<id> opens the task; duet://suggestions/<id> starts it (a spinner meanwhile, a
/// grey line under the row when that fails; tapping again tries again).
private struct CardGroupBlock: View {
    var group: CardGroup

    @Environment(\.openURL) private var openURL
    @Environment(\.cardContext) private var context
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var detailSize: CGFloat = 14

    static let maxRows = 5

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: group.title)
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                Text(group.count, format: .number)
                    .font(.system(size: titleSize).monospacedDigit())
                    .foregroundStyle(Palette.secondaryText)
            }
            .padding(.bottom, 4)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            if group.rows.isEmpty {
                if let empty = group.empty, !empty.isEmpty {
                    Text(verbatim: empty)
                        .font(.system(size: detailSize))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, 6)
                }
            } else {
                ForEach(Array(group.rows.prefix(Self.maxRows).enumerated()), id: \.offset) { index, row in
                    if index > 0 { Divider().overlay(Palette.cardBorder) }
                    rowView(row)
                }
            }
        }
    }

    @ViewBuilder
    private func rowView(_ row: CardGroup.Row) -> some View {
        let url = row.route.flatMap(URL.init(string:)).flatMap { DuetRoute($0) != nil ? $0 : nil }
        let request = Self.suggestionId(url).flatMap { context.requests[ShellState.RequestKey.startSuggestion($0)] }
        VStack(alignment: .leading, spacing: 4) {
            Button {
                if let url, request != .inFlight { openURL(url) }
            } label: {
                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: row.title)
                            .font(.system(size: titleSize, weight: .medium))
                            .foregroundStyle(Palette.primaryText)
                            .lineLimit(2)
                        if let detail = row.detail, !detail.isEmpty {
                            Text(verbatim: detail)
                                .font(.system(size: detailSize))
                                .foregroundStyle(Palette.secondaryText)
                                .lineLimit(2)
                        }
                    }
                    Spacer(minLength: 8)
                    if request == .inFlight {
                        SpinnerArc(size: 14, lineWidth: 1.6)
                    } else if url != nil {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Palette.secondaryText.opacity(0.7))
                            .accessibilityHidden(true)
                    }
                }
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle(scale: 0.98))
            .disabled(url == nil)
            .accessibilityElement(children: .combine)
            .accessibilityValue(request == .inFlight ? Text("In progress") : Text(verbatim: ""))
            if case .failed(let reason) = request {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    DuetIcon(glyph: .warning, size: detailSize + 1, tint: Palette.failure)
                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                    Text(verbatim: reason)
                        .font(.system(size: detailSize - 1))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.bottom, 8)
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: request)
    }

    /// The suggestion a duet://suggestions/<id> row starts.
    private static func suggestionId(_ url: URL?) -> String? {
        guard let url, case .suggestion(let id)? = DuetRoute(url) else { return nil }
        return id
    }
}

/// Icon + title + detail, the value trailing; hairlines between rows.
private struct CardRowsBlock: View {
    var rows: [CardBlock.Row]

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var detailSize: CGFloat = 14
    @ScaledMetric(relativeTo: .body) private var iconSize: CGFloat = 20

    /// Rows line up: when any row has an icon, the others keep its column.
    private var hasIcons: Bool { rows.contains { $0.icon != nil } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                if index > 0 { Divider().overlay(Palette.cardBorder) }
                HStack(alignment: .center, spacing: 12) {
                    if hasIcons {
                        Group {
                            if let icon = row.icon { DuetIcon(icon, size: iconSize) } else { Color.clear }
                        }
                        .frame(width: iconSize, height: iconSize)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: row.title)
                            .font(.system(size: titleSize, weight: .medium))
                            .foregroundStyle(Palette.primaryText)
                            .fixedSize(horizontal: false, vertical: true)
                        if let detail = row.detail, !detail.isEmpty {
                            Text(verbatim: detail)
                                .font(.system(size: detailSize))
                                .foregroundStyle(Palette.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 8)
                    if let value = row.value, !value.isEmpty {
                        Text(verbatim: value)
                            .font(.system(size: detailSize, weight: .medium).monospacedDigit())
                            .foregroundStyle(Palette.primaryText.opacity(0.8))
                            .multilineTextAlignment(.trailing)
                    }
                }
                .padding(.vertical, 10)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// Two columns of soft tiles: the big number, its label, and the delta coloured by trend.
private struct CardMetricsBlock: View {
    var items: [CardBlock.Metric]

    @ScaledMetric(relativeTo: .title2) private var valueSize: CGFloat = 24
    @ScaledMetric(relativeTo: .footnote) private var labelSize: CGFloat = 13

    private let columns = [GridItem(.flexible(), spacing: 10, alignment: .top), GridItem(.flexible(), spacing: 10, alignment: .top)]

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 10) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: item.value)
                        .font(.system(size: valueSize, weight: .semibold).monospacedDigit())
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    Text(verbatim: item.label)
                        .font(.system(size: labelSize))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                    if let delta = item.delta, !delta.isEmpty {
                        HStack(spacing: 3) {
                            if let arrow = item.trend?.arrow {
                                Text(verbatim: arrow).accessibilityHidden(true)
                            }
                            Text(verbatim: delta)
                        }
                        .font(.system(size: labelSize, weight: .semibold).monospacedDigit())
                        .foregroundStyle(item.trend?.color ?? Palette.secondaryText)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.tile))
                .accessibilityElement(children: .combine)
            }
        }
    }
}

extension CardBlock.Metric.Trend {
    var arrow: String? {
        switch self {
        case .up: "↑"
        case .down: "↓"
        case .flat: nil
        }
    }

    var color: Color {
        switch self {
        case .up: Palette.success
        case .down: Palette.failure
        case .flat: Palette.secondaryText
        }
    }
}

/// Label and percent, a rounded bar in the card's tint, the detail under it.
private struct CardProgressBlock: View {
    var label: String
    var value: Double
    var detail: String?
    var tint: CardTint

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .body) private var labelSize: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var detailSize: CGFloat = 13

    private var fraction: Double { min(max(value, 0), 1) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: label)
                    .font(.system(size: labelSize, weight: .medium))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Text(verbatim: UsageMath.percentText(fraction, locale: locale))
                    .font(.system(size: detailSize, weight: .medium).monospacedDigit())
                    .foregroundStyle(Palette.secondaryText)
            }
            TintBar(fraction: fraction, color: tint.color)
            if let detail, !detail.isEmpty {
                Text(verbatim: detail)
                    .font(.system(size: detailSize))
                    .foregroundStyle(Palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A thin rounded bar filled to `fraction` (info card progress, Usage share bars).
struct TintBar: View {
    var fraction: Double
    var color: Color
    var height: CGFloat = 8

    var body: some View {
        Capsule()
            .fill(Palette.usageTrack)
            .frame(height: height)
            .overlay(alignment: .leading) {
                GeometryReader { geo in
                    Capsule()
                        .fill(color)
                        .frame(width: fraction > 0 ? max(geo.size.width * min(fraction, 1), height) : 0)
                }
            }
            .clipShape(Capsule())
            .accessibilityHidden(true)
    }
}

/// The set's done / pending marks; done items read quieter. M24: items with an id are checkable:
/// a tap ticks or unticks at once (ChecklistTicks; one request at a time, later taps queue) and a
/// failed request puts the rows back with the reason under the list. Items without an id stay
/// read-only.
private struct CardChecklistBlock: View {
    var items: [CardBlock.CheckItem]
    var messageId: String?
    var onCheck: ((_ itemId: String, _ done: Bool) -> Void)?

    @Environment(\.cardContext) private var context
    @State private var ticks = ChecklistTicks()
    @State private var taps = 0
    @State private var failedTaps = 0
    @ScaledMetric(relativeTo: .body) private var textSize: CGFloat = 16
    @ScaledMetric(relativeTo: .body) private var markSize: CGFloat = 20
    @ScaledMetric(relativeTo: .subheadline) private var noteSize: CGFloat = 13

    /// The card's tap (cardContext.requests[messageId]).
    private var request: CardRequest? { messageId.flatMap { context.requests[$0] } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                if item.id != nil, messageId != nil, onCheck != nil {
                    Button { tap(item) } label: { row(item, done: ticks.isDone(item)) }
                        .buttonStyle(PressableButtonStyle(scale: 0.98))
                        .accessibilityAddTraits(.isToggle)
                } else {
                    row(item, done: item.done)
                }
            }
            if !ticks.isSending, case .failed(let reason)? = request {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    DuetIcon(glyph: .warning, size: noteSize + 2, tint: Palette.failure)
                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                    Text(verbatim: reason)
                        .font(.system(size: noteSize))
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: request)
        .sensoryFeedback(.selection, trigger: taps)
        .sensoryFeedback(.warning, trigger: failedTaps)
        .onChange(of: request) { old, new in
            guard ticks.isSending, old == .inFlight else { return }
            if new == nil {
                ticks.sent()
                sendNext()
            } else {
                ticks.failed()
                failedTaps += 1
            }
        }
        .onChange(of: items) { _, _ in sendNext() }
    }

    private func row(_ item: CardBlock.CheckItem, done: Bool) -> some View {
        // The mark's centre sits on the first line's x-height.
        let lift = textSize * 0.32
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            DuetIcon(glyph: done ? .done : .pending, size: markSize,
                     tint: done ? Palette.success : Palette.secondaryText.opacity(0.7))
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + lift }
                .contentTransition(.opacity)
            Text(verbatim: item.text)
                .font(.system(size: textSize))
                .foregroundStyle(done ? Palette.secondaryText : Palette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: done)
        .accessibilityElement(children: .combine)
        .accessibilityValue(done ? Text("Done") : Text("Not done"))
    }

    private func tap(_ item: CardBlock.CheckItem) {
        ticks.tap(item)
        taps += 1
        sendNext()
    }

    /// The next tick goes once the card's last action has answered.
    private func sendNext() {
        guard let onCheck, request != .inFlight, let tick = ticks.next(items) else { return }
        onCheck(tick.itemId, tick.done)
    }
}

/// A small bar chart in the card's tint, the unit above it.
private struct CardBarsBlock: View {
    var bars: [CardBlock.Bar]
    var unit: String?
    var tint: CardTint

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .body) private var chartHeight: CGFloat = 140
    @ScaledMetric(relativeTo: .footnote) private var unitSize: CGFloat = 12

    /// Plotted by index so two bars with the same label stay two bars.
    private struct Entry: Identifiable {
        var id: Int
        var label: String
        var value: Double
    }

    private var entries: [Entry] {
        bars.enumerated().map { Entry(id: $0.offset, label: $0.element.label, value: max($0.element.value, 0)) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let unit, !unit.isEmpty {
                Text(verbatim: unit)
                    .font(.system(size: unitSize, weight: .medium))
                    .foregroundStyle(Palette.secondaryText)
                    .accessibilityHidden(true)
            }
            Chart(entries) { entry in
                BarMark(
                    x: .value(Text(verbatim: "label"), String(entry.id)),
                    y: .value(Text(verbatim: unit ?? "value"), entry.value),
                    width: .ratio(0.62)
                )
                .foregroundStyle(tint.color.gradient)
                .cornerRadius(5)
                .accessibilityLabel(Text(verbatim: entry.label))
                .accessibilityValue(Text(verbatim: valueText(entry.value)))
            }
            .chartXAxis {
                AxisMarks { value in
                    AxisValueLabel {
                        if let key = value.as(String.self), let index = Int(key), entries.indices.contains(index) {
                            Text(verbatim: entries[index].label)
                        }
                    }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { _ in
                    AxisGridLine().foregroundStyle(Palette.cardBorder)
                    AxisValueLabel()
                }
            }
            .frame(height: chartHeight)
        }
    }

    private func valueText(_ value: Double) -> String {
        let number = value.formatted(.number.precision(.fractionLength(0...2)).locale(locale))
        guard let unit, !unit.isEmpty else { return number }
        return "\(number) \(unit)"
    }
}

/// M24: a small Swift Charts line chart: the unit above it, 1-3 series (the first in the card's
/// tint, the others grey like the bar chart's set), a break at each null and a dot for a value
/// alone between two; a legend when there is more than one series; the x axis names as many
/// labels as fit (always the newest).
private struct CardLineChartBlock: View {
    var chart: CardLineChart
    var tint: CardTint

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .body) private var chartHeight: CGFloat = 140
    @ScaledMetric(relativeTo: .footnote) private var unitSize: CGFloat = 12

    private struct Line: Identifiable {
        var id: Int
        var name: String
        var runs: [LineChartRules.Run]
    }

    private var lines: [Line] {
        chart.series.prefix(3).enumerated().map { Line(id: $0.offset, name: $0.element.name, runs: LineChartRules.runs($0.element.values)) }
    }

    private func color(_ index: Int) -> Color {
        index == 0 ? tint.color : Palette.secondaryText.opacity(index == 1 ? 0.75 : 0.45)
    }

    var body: some View {
        let lines = lines
        if lines.contains(where: { !$0.runs.isEmpty }) {
            VStack(alignment: .leading, spacing: 6) {
                if let unit = chart.unit, !unit.isEmpty {
                    Text(verbatim: unit)
                        .font(.system(size: unitSize, weight: .medium))
                        .foregroundStyle(Palette.secondaryText)
                        .accessibilityHidden(true)
                }
                plot(lines)
                if lines.count > 1 { legend(lines) }
            }
        }
    }

    private func plot(_ lines: [Line]) -> some View {
        let shown = Set(LineChartRules.labelIndices(chart.labels))
        return Chart {
            ForEach(lines) { line in
                ForEach(Array(line.runs.enumerated()), id: \.offset) { runIndex, run in
                    marks(line, run: run, key: "\(line.id)-\(runIndex)")
                }
            }
        }
        .chartXScale(domain: 0...max(chart.labels.count - 1, 1))
        .chartXAxis {
            AxisMarks(values: Array(shown).sorted()) { value in
                AxisValueLabel {
                    if let index = value.as(Int.self), chart.labels.indices.contains(index) {
                        Text(verbatim: chart.labels[index]).lineLimit(1)
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { _ in
                AxisGridLine().foregroundStyle(Palette.cardBorder)
                AxisValueLabel()
            }
        }
        .frame(height: chartHeight)
    }

    @ChartContentBuilder
    private func marks(_ line: Line, run: LineChartRules.Run, key: String) -> some ChartContent {
        if run.isDot {
            ForEach(run.points, id: \.index) { point in
                PointMark(x: .value(Text(verbatim: "label"), point.index), y: .value(Text(verbatim: line.name), point.value))
                    .foregroundStyle(color(line.id))
                    .symbolSize(30)
                    .accessibilityLabel(Text(verbatim: "\(line.name), \(label(point.index))"))
                    .accessibilityValue(Text(verbatim: valueText(point.value)))
            }
        } else {
            ForEach(run.points, id: \.index) { point in
                LineMark(
                    x: .value(Text(verbatim: "label"), point.index),
                    y: .value(Text(verbatim: line.name), point.value),
                    series: .value(Text(verbatim: "series"), key)
                )
                    .foregroundStyle(color(line.id))
                    .lineStyle(StrokeStyle(lineWidth: line.id == 0 ? 2.5 : 2, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.monotone)
                    .accessibilityLabel(Text(verbatim: "\(line.name), \(label(point.index))"))
                    .accessibilityValue(Text(verbatim: valueText(point.value)))
            }
        }
    }

    private func legend(_ lines: [Line]) -> some View {
        HStack(spacing: 14) {
            ForEach(lines) { line in
                HStack(spacing: 5) {
                    Capsule().fill(color(line.id)).frame(width: 14, height: 3)
                    Text(verbatim: line.name)
                        .font(.system(size: unitSize))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityHidden(true)
    }

    private func label(_ index: Int) -> String {
        chart.labels.indices.contains(index) ? chart.labels[index] : ""
    }

    private func valueText(_ value: Double) -> String {
        MakeCopy(format: ChatDateFormat(locale: locale)).metric(value, unit: chart.unit)
    }
}
