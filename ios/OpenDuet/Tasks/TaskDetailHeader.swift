// The body of a task detail above its own conversation (prompt L121): the title (22 pt semibold)
// with ↻, the assistant's description, "Noticed 8:44 AM" for proactive tasks, a wavy grey divider,
// "What OpenDuet is doing" (current step: a blue spinning arc; pending: dashed circles; done:
// checks), "Decisions and updates" (↗, text, source, time) and "Resources" (icon tile, title,
// type; https opens the Safari sheet, duet:// goes to openRoute through the thread's openURL).
// M8: the current step's arc spins only while the task is working (else a still, muted arc);
// built-in sources ("OpenDuet's computer", "OpenDuet") are localized; files the assistant sent in the task
// are one "N files" row that opens the list (the cards themselves are in the run records).
import SwiftUI

struct TaskDetailHeader: View {
    var detail: TaskDetailState
    /// Files the assistant sent in this task (TaskThreadFilter), oldest first.
    var files: [ChannelFile] = []
    var onReload: () -> Void

    @State private var filesOpen = false
    /// M16: "Show N earlier" in Decisions and updates
    @State private var updatesExpanded = false
    /// M16: the rows whose folded detail (an approval's command) is open
    @State private var openDetails: Set<String> = []

    @Environment(\.locale) private var locale
    @Environment(\.openURL) private var openURL
    @ScaledMetric(relativeTo: .title2) private var titleSize: CGFloat = Metrics.taskDetailTitle
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 16
    @ScaledMetric(relativeTo: .headline) private var sectionSize: CGFloat = 17
    @ScaledMetric(relativeTo: .footnote) private var metaSize: CGFloat = 13

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let task = detail.task {
                content(task)
            } else if detail.phase == .gone {
                gone
            } else if case .failed(let reason) = detail.phase {
                InlineFailure(reason: reason, onRetry: onReload)
            } else {
                skeleton
            }
            WavyLine()
                .stroke(Palette.secondaryText.opacity(0.4), style: StrokeStyle(lineWidth: 1.2, lineCap: .round))
                .frame(height: 6)
                .padding(.vertical, 4)
                .accessibilityHidden(true)
        }
        .padding(.top, 8)
        .padding(.bottom, Metrics.groupSpacing)
        .animation(.easeInOut(duration: 0.25), value: detail.task)
    }

    /// M14: the link pointed at a task that was deleted (404): one quiet line, no Retry.
    private var gone: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            DuetIcon(glyph: .delete, size: bodySize, tint: Palette.secondaryText)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                .accessibilityHidden(true)
            Text("This task was deleted.")
                .font(.system(size: bodySize))
                .foregroundStyle(Palette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .transition(.opacity)
    }

    @ViewBuilder
    private func content(_ task: TaskDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(verbatim: task.summary.title)
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 4)
                Button(action: onReload) {
                    ZStack {
                        if detail.phase == .loading {
                            ProgressView().controlSize(.small)
                        } else {
                            DuetIcon(glyph: .refresh, size: 19, tint: Palette.secondaryText)
                        }
                    }
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle(scale: 0.9))
                .disabled(detail.phase == .loading)
                .accessibilityLabel(Text("Reload"))
            }
            if !task.description.isEmpty {
                Text(verbatim: task.description)
                    .font(.system(size: bodySize))
                    .foregroundStyle(Palette.primaryText.opacity(0.88))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if task.summary.source == .proactive, let noticed = task.noticedAt {
                Text("Noticed \(when(noticed))")
                    .font(.system(size: metaSize))
                    .foregroundStyle(Palette.secondaryText)
            }
        }
        if !task.steps.isEmpty {
            section(Text("What OpenDuet is doing")) {
                ForEach(task.steps) { step in
                    StepRow(step: step, working: task.summary.status == .working, fontSize: bodySize)
                }
            }
        }
        if !task.updates.isEmpty {
            section(Text("Decisions and updates")) {
                updates(task.updates)
            }
        }
        if !task.resources.isEmpty {
            section(Text("Resources")) {
                ForEach(Array(task.resources.enumerated()), id: \.offset) { _, resource in
                    resourceRow(resource)
                }
            }
        }
        if !files.isEmpty {
            section(Text("Files from OpenDuet")) {
                filesRow
            }
        }
    }

    /// "3 files ›": opens the list in place; each file opens the full-screen preview.
    private var filesRow: some View {
        VStack(spacing: 0) {
            Button { filesOpen.toggle() } label: {
                HStack(spacing: 12) {
                    IconTile(app: nil, systemImage: DuetGlyph.files.symbol, size: 32, tint: Palette.primaryText)
                    Group {
                        if files.count == 1 { Text("1 file") } else { Text("\(files.count) files") }
                    }
                    .font(.system(size: bodySize, weight: .medium))
                    .foregroundStyle(Palette.primaryText)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Palette.secondaryText.opacity(0.7))
                        .rotationEffect(.degrees(filesOpen ? 180 : 0))
                        .accessibilityHidden(true)
                }
                .padding(10)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle(scale: 0.98))
            .accessibilityHint(filesOpen ? Text("Show less") : Text("Show more"))
            if filesOpen {
                ForEach(files) { file in
                    Divider().overlay(Palette.cardBorder).padding(.leading, 10 + 32 + 12)
                    FileRow(file: file) {
                        // M26: an artifact's page opens the artifact, as in the Files page.
                        if let url = FileGroups.artifactLink(file) ?? URL(string: "duet://files/\(file.id)") { openURL(url) }
                    }
                }
                .transition(.opacity)
            }
        }
        .cardSurface(corner: 14)
        .animation(.easeInOut(duration: 0.25), value: filesOpen)
    }

    private func section<Rows: View>(_ title: Text, @ViewBuilder rows: () -> Rows) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            title
                .font(.system(size: sectionSize, weight: .semibold))
                .foregroundStyle(Palette.primaryText)
                .accessibilityAddTraits(.isHeader)
            rows()
        }
    }

    /// "8:44 AM" today, "Yesterday 8:44 AM" / "Oct 20, 8:44 AM" before (12/24-hour, L89).
    private func when(_ date: Date) -> String {
        let format = ChatDateFormat(locale: locale)
        return format.dayOffset(date) == 0 ? format.time(date) : format.separator(date)
    }

    /// M16 (decided by the user): the same failure in a row is one row with ×N, only the latest
    /// rows show until "Show N earlier", an approval's command is folded away and the assistant's own
    /// updates render as markdown.
    @ViewBuilder private func updates(_ all: [TaskUpdate]) -> some View {
        let merged = TaskUpdateRules.merged(all)
        let shown = TaskUpdateRules.shown(merged, expanded: updatesExpanded)
        if shown.hidden > 0 {
            Button {
                withAnimation(.easeInOut(duration: 0.25)) { updatesExpanded = true }
            } label: {
                Text("Show \(shown.hidden) earlier")
                    .font(.system(size: metaSize + 0.5, weight: .semibold))
                    .foregroundStyle(Palette.accent)
                    .padding(.leading, 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        ForEach(Array(shown.rows.enumerated()), id: \.offset) { _, update in
            updateRow(update, id: detailKey(update))
        }
    }

    private func updateRow(_ update: TaskUpdate, id: String) -> some View {
        // No text baseline of its own: the mark centres on the first line's capitals.
        let lift = bodySize * 0.36
        let approval = TaskUpdateRules.approval(update)
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            DuetIcon(glyph: .update, size: 14, tint: Palette.secondaryText)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + lift }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                VStack(alignment: .leading, spacing: 3) {
                    updateText(update, approval: approval)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(verbatim: meta(update))
                        .font(.system(size: metaSize))
                        .foregroundStyle(Palette.secondaryText)
                }
                // The assistant's markdown keeps its links reachable one by one; other rows read as one.
                .accessibilityElement(children: update.text.key == nil ? .contain : .combine)
                if let approval {
                    detailFold(approval.detail, id: id)
                }
            }
        }
    }

    /// The row's text: an approval as its one line ("Approved and done: OpenDuet's computer · Run
    /// commands", names through the catalog), the assistant's own text as markdown, anything else as
    /// its phrase; a merged row ends with "×N".
    @ViewBuilder private func updateText(_ update: TaskUpdate, approval: TaskUpdateRules.Approval?) -> some View {
        let color = TaskUpdateRules.isFailure(update) ? Palette.needsInput : Palette.primaryText
        let times = update.count.map { count in
            Text(verbatim: "  ×\(count)").foregroundStyle(Palette.secondaryText).accessibilityLabel(Text("\(count) times"))
        } ?? Text(verbatim: "")
        if update.text.key == nil, let text = update.text.text {
            MarkdownView(blocks: MarkdownCache.blocks(text), color: color)
        } else {
            (Text(verbatim: PhraseText.string(shownPhrase(update, approval: approval), locale: locale)).foregroundStyle(color) + times)
                .font(.system(size: bodySize))
        }
    }

    /// An approval's phrase with its summary cut to the line people read.
    private func shownPhrase(_ update: TaskUpdate, approval: TaskUpdateRules.Approval?) -> Phrase {
        guard let approval else { return update.text }
        var phrase = update.text
        phrase.params?["summary"] = .text(approval.parts.map { RunTexts.builtInName($0) }.joined(separator: " · "))
        return phrase
    }

    /// A row's key for its open detail: when it first happened and what it says, so it stays the
    /// same row when earlier ones unfold or the list grows.
    private func detailKey(_ update: TaskUpdate) -> String {
        "\((update.since ?? update.at).timeIntervalSince1970)|\(update.source)|\(update.text.key ?? "")|\(update.text.text ?? "")"
    }

    /// "Show details ⌄": the approval's arguments (a command, a path) in a monospaced block.
    @ViewBuilder private func detailFold(_ detail: String, id: String) -> some View {
        let open = openDetails.contains(id)
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                if open { openDetails.remove(id) } else { openDetails.insert(id) }
            }
        } label: {
            HStack(spacing: 4) {
                if open { Text("Hide details") } else { Text("Show details") }
                Image(systemName: "chevron.down")
                    .font(.system(size: metaSize - 2, weight: .semibold))
                    .rotationEffect(.degrees(open ? 180 : 0))
                    .accessibilityHidden(true)
            }
            .font(.system(size: metaSize + 0.5, weight: .semibold))
            .foregroundStyle(Palette.accent)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        if open {
            Text(verbatim: detail)
                .font(.system(size: metaSize, design: .monospaced))
                .foregroundStyle(Palette.primaryText)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.codeSurface))
                .transition(.opacity)
        }
    }

    /// "OpenDuet · Yesterday 11:30–11:52": built-in sources ("OpenDuet's computer") through the
    /// catalog, apps as sent; a merged row shows from its first time to its latest.
    private func meta(_ update: TaskUpdate) -> String {
        [RunTexts.builtInName(update.source), span(update)].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func span(_ update: TaskUpdate) -> String {
        guard let since = update.since, since < update.at else { return when(update.at) }
        let format = ChatDateFormat(locale: locale)
        // Same day: the day once ("Yesterday 11:30–11:52"); else both in full.
        if Calendar.current.isDate(since, inSameDayAs: update.at) {
            return when(since) + "–" + format.time(update.at)
        }
        return when(since) + " – " + when(update.at)
    }

    private func resourceRow(_ resource: TaskResource) -> some View {
        Button {
            if let url = URL(string: resource.link) { openURL(url) }
        } label: {
            HStack(spacing: 12) {
                IconTile(app: resource.app, systemImage: resource.type.glyph)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: resource.title)
                        .font(.system(size: bodySize, weight: .medium))
                        .foregroundStyle(Palette.primaryText)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Text(resource.type.label)
                        .font(.system(size: metaSize))
                        .foregroundStyle(Palette.secondaryText)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.secondaryText.opacity(0.7))
                    .accessibilityHidden(true)
            }
            .padding(10)
            .cardSurface(corner: 14)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("Opens it"))
    }

    private var skeleton: some View {
        VStack(alignment: .leading, spacing: 10) {
            RoundedRectangle(cornerRadius: 6).fill(Palette.skeleton).frame(height: 24).padding(.trailing, 60)
            RoundedRectangle(cornerRadius: 5).fill(Palette.skeleton).frame(height: 14)
            RoundedRectangle(cornerRadius: 5).fill(Palette.skeleton).frame(height: 14).padding(.trailing, 40)
            RoundedRectangle(cornerRadius: 5).fill(Palette.skeleton).frame(height: 14).padding(.trailing, 120)
        }
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading task"))
    }
}

/// One checklist step: a blue spinning arc (current, while the task works; a still, muted arc
/// otherwise), a dashed circle (planned) or a check (done).
private struct StepRow: View {
    var step: TaskStep
    /// The task's status is working: only then does the current step's arc spin.
    var working: Bool
    var fontSize: CGFloat

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            glyph
                .frame(width: 18, height: 18)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
            Text(verbatim: step.text)
                .font(.system(size: fontSize, weight: step.state == .current ? .medium : .regular))
                .foregroundStyle(step.state == .done ? Palette.secondaryText : Palette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(stateLabel)
    }

    @ViewBuilder private var glyph: some View {
        switch step.state {
        case .current:
            if working {
                SpinnerArc(size: 14, lineWidth: 2)
            } else {
                // Paused (waiting on the user, or the run stopped): the arc rests, muted.
                Circle()
                    .trim(from: 0, to: 0.72)
                    .stroke(Palette.secondaryText.opacity(0.55), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .frame(width: 14, height: 14)
                    .padding(1)
                    .accessibilityHidden(true)
            }
        case .planned:
            DuetIcon(glyph: .pending, size: 17, tint: Palette.secondaryText.opacity(0.6))
        case .done:
            DuetIcon(glyph: .done, size: 17, tint: Palette.success)
        }
    }

    private var stateLabel: Text {
        switch step.state {
        case .current: Text("In progress")
        case .planned: Text("Not started")
        case .done: Text("Done")
        }
    }
}

extension TaskResource.Kind {
    var glyph: String {
        switch self {
        case .doc: "doc.text"
        case .email: "envelope"
        case .event: "calendar"
        case .link: "link"
        case .file: "doc"
        case .artifact: "square.and.pencil"
        case .browser: "safari"
        }
    }

    var label: LocalizedStringResource {
        switch self {
        case .doc: "Doc"
        case .email: "Email"
        case .event: "Event"
        case .link: "Link"
        case .file: "File"
        case .artifact: "Artifact"
        case .browser: "Browser"
        }
    }
}
