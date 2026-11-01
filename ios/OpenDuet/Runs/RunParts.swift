// Shared pieces of the run records (M8 contract §1): the status capsule (black "Done", blue
// running, red failed), the step status icon (green ✓, red ✕, blue spinner, amber hand), glyphs
// by run kind and step, the monospaced Input / Output block with Copy, the rows' skeleton, and
// the day / time / duration words.
import SwiftUI
import UIKit

// MARK: - Status

extension RunStatus {
    var label: LocalizedStringResource {
        switch self {
        case .queued: "Queued"
        case .running: "Running"
        // "Done" for both: a chat turn completes, a task's run resolves it.
        case .completed, .resolved: "Done"
        case .skipped: "Skipped"
        case .failed: "Failed"
        }
    }
}

/// The detail's status capsule, like the reference: a black "已完成" capsule, blue while running,
/// red when failed, grey when skipped.
struct RunStatusBadge: View {
    var status: RunStatus

    @ScaledMetric(relativeTo: .caption) private var fontSize: CGFloat = 12.5

    var body: some View {
        HStack(spacing: 5) {
            if status.isOpen {
                SpinnerArc(size: fontSize * 0.8, color: foreground, lineWidth: 1.6)
            }
            Text(status.label)
                .font(.system(size: fontSize, weight: .semibold))
        }
        .foregroundStyle(foreground)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(Capsule().fill(background))
        .accessibilityElement(children: .combine)
    }

    private var foreground: Color {
        switch status {
        case .completed, .resolved: Palette.filledButtonText
        case .queued, .running: Palette.working
        case .failed: Palette.failure
        case .skipped: Palette.secondaryText
        }
    }

    private var background: Color {
        switch status {
        case .completed, .resolved: Palette.filledButton
        case .queued, .running: Palette.working.opacity(0.14)
        case .failed: Palette.failure.opacity(0.12)
        case .skipped: Palette.tile
        }
    }
}

/// A step's status at the head of its timeline row.
struct RunStepStatusIcon: View {
    var status: RunStep.Status
    var size: CGFloat

    var body: some View {
        Group {
            switch status {
            // M9: the hand-drawn set's line marks (DuetIcon), not filled SF circles.
            case .ok: DuetIcon(glyph: .done, size: size, tint: Palette.success)
            case .error: DuetIcon(glyph: .failed, size: size, tint: Palette.failure)
            case .denied: DuetIcon(glyph: .close, size: size, tint: Palette.secondaryText)
            case .awaitingApproval: DuetIcon(glyph: .approval, size: size, tint: Palette.needsInput)
            case .running:
                SpinnerArc(size: size * 0.78, color: Palette.working, lineWidth: 2)
            }
        }
        .frame(width: size, height: size)
        .background(Circle().fill(Palette.sheetBackground).padding(1))
        .accessibilityHidden(true)
    }

    /// What VoiceOver says after the step's title.
    var label: Text {
        switch status {
        case .ok: Text("Done")
        case .error: Text("Failed")
        case .denied: Text("Denied")
        case .awaitingApproval: Text("Waiting for approval")
        case .running: Text("Running")
        }
    }
}

// MARK: - Glyphs

enum RunGlyph {
    /// A run's tile by kind (the list rows fall back to it with no steps yet).
    static func kind(_ kind: RunKind) -> String {
        switch kind {
        case .chat: DuetGlyph.reply.symbol
        case .task: DuetGlyph.task.symbol
        case .brief: "sun.horizon"
        case .checkin: DuetGlyph.clock.symbol
        case .scan: DuetGlyph.search.symbol
        case .build: DuetGlyph.artifact.symbol
        case .routine: DuetGlyph.timer.symbol
        }
    }

    /// A step's tile by its title key (the tool family); Composio tools get the generic tool.
    static func step(titleKey key: String?, kind: RunStep.Kind? = nil) -> String {
        switch kind {
        case .thinking: return DuetGlyph.thinking.symbol
        case .text: return DuetGlyph.reply.symbol
        case .error: return DuetGlyph.error.symbol
        case .tool, nil: break
        }
        switch key {
        case "run.step.exec": return DuetGlyph.command.symbol
        case "run.step.navigate", "run.step.read_page", "run.step.web_fetch": return DuetGlyph.page.symbol
        case "run.step.browse", "run.step.screenshot": return DuetGlyph.browser.symbol
        case "run.step.files_list": return DuetGlyph.fileList.symbol
        case "run.step.files_read": return DuetGlyph.read.symbol
        case "run.step.files_write": return DuetGlyph.write.symbol
        case "run.step.send_file": return DuetGlyph.sent.symbol
        case "run.step.web_search", "run.step.past_chats": return DuetGlyph.search.symbol
        // M25: the built-in connectors, with their icons on Apps and connectors › Built in
        case "run.step.weather": return BuiltinConnectorCopy.symbol(.weather)
        case "run.step.exchange_rate": return BuiltinConnectorCopy.symbol(.exchangeRate)
        case "run.step.read_feed": return BuiltinConnectorCopy.symbol(.readFeed)
        case "run.step.memory", "run.step.remember": return DuetGlyph.memory.symbol
        case "run.step.task", "run.step.task_progress": return DuetGlyph.task.symbol
        case "run.step.make": return DuetGlyph.artifact.symbol
        case "run.step.approval": return DuetGlyph.approval.symbol
        case "run.step.thinking": return DuetGlyph.thinking.symbol
        case "run.step.text": return DuetGlyph.reply.symbol
        case "run.step.error": return DuetGlyph.error.symbol
        default: return DuetGlyph.tool.symbol
        }
    }

    /// A list row's tile: its latest step's family, else the run's kind.
    static func row(_ run: RunSummary) -> String {
        guard let latest = run.latest else { return kind(run.kind) }
        return step(titleKey: latest.title.key)
    }
}
// MARK: - Input / Output

/// A step's input or output: a small grey caption with Copy, the text monospaced on the code
/// surface (already redacted and capped by the server), folding past 12 lines behind "Show more".
struct RunMonoBlock: View {
    var title: Text
    var text: String

    @State private var copies = 0
    @State private var expanded = false
    @ScaledMetric(relativeTo: .footnote) private var captionSize: CGFloat = 12.5
    @ScaledMetric(relativeTo: .footnote) private var codeSize: CGFloat = 13

    static let foldLines = 12

    private var isLong: Bool {
        text.split(separator: "\n", omittingEmptySubsequences: false).count > Self.foldLines || text.count > 1_200
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                title
                    .font(.system(size: captionSize, weight: .semibold))
                    .foregroundStyle(Palette.secondaryText)
                Spacer(minLength: 8)
                Button {
                    UIPasteboard.general.string = text
                    copies += 1
                } label: {
                    Label {
                        if copies > 0 { Text("Copied") } else { Text("Copy") }
                    } icon: {
                        DuetIcon(glyph: copies > 0 ? .check : .copy, size: captionSize + 3, tint: Palette.secondaryText)
                            .contentTransition(.opacity)
                    }
                    .font(.system(size: captionSize, weight: .medium))
                    .foregroundStyle(Palette.secondaryText)
                    .frame(minHeight: 32)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle(scale: 0.92))
            }
            Text(verbatim: text)
                .font(.system(size: codeSize, design: .monospaced))
                .foregroundStyle(Palette.primaryText)
                .lineLimit(expanded || !isLong ? nil : Self.foldLines)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.codeSurface))
            if isLong {
                Button { expanded.toggle() } label: {
                    if expanded { Text("Show less") } else { Text("Show more") }
                }
                .font(.system(size: captionSize + 1, weight: .medium))
                .foregroundStyle(Palette.secondaryText)
                .buttonStyle(PressableButtonStyle())
            }
        }
        .animation(.easeInOut(duration: 0.25), value: expanded)
        .sensoryFeedback(.impact(weight: .light), trigger: copies)
        .task(id: copies) {
            guard copies > 0 else { return }
            try? await Task.sleep(for: .seconds(1.5))
            if !Task.isCancelled { copies = 0 }
        }
    }
}

// MARK: - Skeleton

/// Skeleton rows shaped like the run rows (L184): tile, title, latest step, time.
struct RunRowsSkeleton: View {
    var rows = 4

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<rows, id: \.self) { index in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Palette.skeleton)
                        .frame(width: 32, height: 32)
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton)
                            .frame(width: CGFloat(index % 2 == 0 ? 150 : 110), height: 13)
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton)
                            .frame(width: CGFloat(index % 2 == 0 ? 190 : 160), height: 10)
                    }
                    Spacer()
                    RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(width: 40, height: 10)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: Metrics.sheetRowMinHeight + 4)
            }
        }
        .cardSurface()
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading"))
    }
}

// MARK: - Words

struct RunFormat {
    var locale: Locale
    var calendar: Calendar = .autoupdatingCurrent
    var now = Date()

    private var dates: ChatDateFormat { ChatDateFormat(locale: locale, calendar: calendar, now: now) }

    /// A list's day header: "Today", "Yesterday", "Monday", "Oct 20" (with the year when older).
    func dayHeader(_ day: Date) -> Text {
        let offset = dates.dayOffset(day)
        var style = Date.FormatStyle(locale: locale, calendar: calendar)
        switch offset {
        case 0: return Text("Today")
        case -1: return Text("Yesterday")
        case -6 ... -2: style = style.weekday(.wide)
        default:
            let sameYear = calendar.component(.year, from: day) == calendar.component(.year, from: now)
            style = sameYear ? style.month(.wide).day() : style.year().month(.wide).day()
        }
        return Text(verbatim: day.formatted(style))
    }

    /// A row's time: "8:44 AM" today, else "Yesterday 8:44 AM" / "Oct 20, 8:44 AM".
    func rowTime(_ date: Date) -> String {
        dates.dayOffset(date) == 0 ? dates.time(date) : dates.separator(date)
    }

    /// How long the run took (or has taken so far): "42s", "3m 10s"; nil before it started.
    func duration(_ run: RunSummary) -> String? {
        guard let start = run.startedAt else { return nil }
        let end = run.finishedAt ?? (run.status.isOpen ? now : nil)
        guard let end, end >= start else { return nil }
        return PhraseFormatter.duration(end.timeIntervalSince(start), locale: locale)
    }

    /// "1 step" / "12 steps".
    static func steps(_ count: Int) -> Text {
        count == 1 ? Text("1 step") : Text("\(count) steps")
    }
}
