// Task detail, full screen over the shell while ShellState.taskDetail is set (prompt L121): a back
// circle, the centre capsule (doc tile + truncated title + "Working · 2 updates", or the live
// status while its run works) and "⋯" (Mark complete, Archive, Copy link, Run details). Below, the task body
// and the task's own conversation in the chat's thread view (same bubbles and cards; approvals
// can be decided here), and the "Reply to OpenDuet" composer without a tab bar (M21: with "+",
// its files go with the reply).
// M8 (L121, decided by the user): the conversation shows only what matters (TaskThreadFilter:
// the user's replies, the assistant's first and last words per turn, cards still waiting); the rest is
// in ⋯ "Run details" (the run records). Files the assistant sent are one "N files" row in the body.
// The top bar and the composer sit in `duetBar`s; a swipe right on the assistant's bubble quotes it.
// M10: while the task's run replies, the empty composer's circle is ■ (stop this task's turn).
import SwiftUI
import UIKit

struct TaskDetailView: View {
    var detail: TaskDetailState
    var actions: ShellActions
    var onMarkComplete: (String) -> Void
    var onArchive: (String) -> Void
    var onClose: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// M9: the ⋯ menu's Pin and Delete states (cardRequests).
    @Environment(\.cardContext) private var context
    @State private var draft = ""
    @State private var composerFocused = false
    @State private var jumpRequest = 0
    @State private var showRuns = false
    /// Cards that were waiting for the user during this visit: they stay after being decided.
    @State private var keeping = Set<String>()

    var body: some View {
        // M21: a link's message (?message=) shows even when the filter would leave it out.
        let filtered = TaskThreadFilter.apply(detail.thread, keeping: keeping.union(detail.thread.focus.map { [$0.messageId] } ?? []))
        let taskActions = Self.taskActions(actions, taskId: detail.taskId)
        return ThreadView(
            thread: filtered.thread, status: detail.status, isActive: true,
            actions: taskActions, jumpRequest: jumpRequest
        ) {
            TaskDetailHeader(detail: detail, files: filtered.files) { actions.tasks.open(detail.taskId) }
        }
        .environment(\.cardHooks, CardHooks(focusComposer: { composerFocused = true }, showAllTasks: { onClose() }))
        .simultaneousGesture(TapGesture().onEnded { composerFocused = false })
        .duetBar(.top) {
            TaskTopBar(
                detail: detail,
                pinRequest: context.requests[ShellState.RequestKey.pinTask(detail.taskId)],
                deleteRequest: context.requests[ShellState.RequestKey.deleteTask(detail.taskId)],
                onBack: onClose,
                onMarkComplete: { onMarkComplete(detail.taskId) },
                onArchive: {
                    onArchive(detail.taskId)
                    onClose()
                },
                onRunDetails: { showRuns = true },
                onPin: { actions.tasks.setPinned(detail.taskId, $0) },
                // The detail closes (with "Task deleted") once the server answers.
                onDelete: { actions.tasks.delete(detail.taskId) }
            )
        }
        // fade 20 = the composer's old 20 pt gradient above it; duetBar keeps that gap.
        .duetBar(.bottom, fade: 20) {
            // M14: nothing to reply to once the task is gone (404).
            if detail.phase != .gone { composer(taskActions) }
        }
        .background(Palette.background.ignoresSafeArea())
        .onChange(of: TaskThreadFilter.awaitingUser(detail.thread.messages), initial: true) { _, waiting in
            if !waiting.isSubset(of: keeping) { keeping.formUnion(waiting) }
        }
        .onChange(of: detail.taskId) { _, _ in keeping = detail.thread.focus.map { [$0.messageId] } ?? [] }
        // ... and stays for the visit once the thread scrolled to it (the focus is gone then).
        .onChange(of: detail.thread.focus?.messageId, initial: true) { _, id in
            if let id, !keeping.contains(id) { keeping.insert(id) }
        }
        .sheet(isPresented: $showRuns) {
            RunsTaskSheet(taskId: detail.taskId) { showRuns = false }
                .duetSheetChrome()
                .presentationDetents([.large])
        }
    }

    private func composer(_ taskActions: ShellActions) -> some View {
        // M21 (review C19): "+" adds files to the reply once the task has loaded (they upload to
        // its channel).
        ComposerBar(
            draft: $draft, isFocused: $composerFocused, placeholder: "Reply to OpenDuet",
            composer: detail.composer, actions: taskActions, allowsAttachments: detail.task != nil
        ) { jumpRequest += 1 }
        .padding(.horizontal, Metrics.threadInset)
        .padding(.bottom, Metrics.composerAboveTabBar)
    }

    /// The shell's actions pointed at the task's own session: sends go to "Reply to OpenDuet",
    /// paging and reload hit the task's thread (reload = open the task again), chips that send
    /// text reply in the task, and the main thread's read marker is left alone.
    static func taskActions(_ actions: ShellActions, taskId: String) -> ShellActions {
        var task = actions
        let tasks = actions.tasks
        task.send = { text, ids in tasks.reply(text, ids) }
        task.reloadThread = { tasks.open(taskId) }
        task.loadOlder = { tasks.loadOlder() }
        task.markRead = {}
        // M21: the reply's own attachments (remove / retry keep the shell's: they find the file by id).
        task.addAttachments = { files in tasks.addAttachments(files) }
        task.cards.sendText = { text in tasks.reply(text, []) }
        // M8: the quote chip of the task's own composer (its next reply carries it).
        task.setReplyTo = { quote in tasks.setReplyTo(quote) }
        // M10: ■ in "Reply to OpenDuet" stops the task's own session (POST /api/tasks/:id/stop).
        task.stop = actions.stopTask
        return task
    }
}

/// The detail's floating top bar: back circle, centre capsule, ⋯ menu.
private struct TaskTopBar: View {
    var detail: TaskDetailState
    /// M9: cardRequests[RequestKey.pinTask(id)] / [RequestKey.deleteTask(id)]
    var pinRequest: CardRequest?
    var deleteRequest: CardRequest?
    var onBack: () -> Void
    var onMarkComplete: () -> Void
    var onArchive: () -> Void
    var onRunDetails: () -> Void
    var onPin: (_ pinned: Bool) -> Void
    var onDelete: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var copies = 0
    @State private var confirmingDelete = false
    @ScaledMetric(relativeTo: .subheadline) private var titleSize: CGFloat = 15
    @ScaledMetric(relativeTo: .caption) private var lineSize: CGFloat = 12

    private var summary: TaskSummary? { detail.task?.summary }
    private var pinned: Bool { summary?.pinned ?? false }

    var body: some View {
        VStack(spacing: 6) {
            bar
            // The task's live run status, like the chat header's pill under the mascot.
            StatusPill(status: detail.status)
            if let reason = pinRequest?.failureReason {
                InlineFailure(reason: reason) { onPin(!pinned) }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(Palette.floatingSurface))
                    .transition(.opacity)
            }
            // M9: ⋯ Delete asks here, under the bar, before anything goes.
            if confirmingDelete || deleteRequest == .inFlight {
                DeleteConfirmStrip(
                    question: Text("Delete this task? Its conversation goes too."),
                    busy: deleteRequest == .inFlight, failure: deleteRequest?.failureReason,
                    onConfirm: onDelete,
                    onCancel: { confirmingDelete = false }
                )
                .floatingShadow()
                .transition(.confirmReveal(reduceMotion: reduceMotion))
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        // duetBar's fade continues below the bar.
        .padding(.bottom, 6)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.36, dampingFraction: 0.86), value: confirmingDelete)
        .animation(.easeInOut(duration: 0.2), value: pinRequest)
        .sensoryFeedback(.impact(weight: .light), trigger: copies)
    }

    private var bar: some View {
        HStack(spacing: 10) {
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                    .floatingCircle(Metrics.headerCircle)
            }
            .buttonStyle(PressableButtonStyle(scale: 0.92))
            .accessibilityLabel(Text("Back"))

            capsule
                .frame(maxWidth: .infinity)

            Menu {
                // M9: Pin / Unpin (not on a scheduled task: it lives in Scheduled).
                if summary?.routine == nil {
                    Button { onPin(!pinned) } label: {
                        if pinned {
                            Label { Text("Unpin") } icon: { Image(systemName: "pin.slash") }
                        } else {
                            Label { Text("Pin") } icon: { Image(systemName: DuetGlyph.pin.symbol) }
                        }
                    }
                    .disabled(summary == nil || pinRequest == .inFlight)
                }
                Button { onMarkComplete() } label: {
                    Label { Text("Mark complete") } icon: { Image(systemName: DuetGlyph.done.symbol) }
                }
                .disabled(summary?.status == .resolved || summary?.routine != nil)
                Button { onArchive() } label: {
                    Label { Text("Archive") } icon: { Image(systemName: DuetGlyph.archive.symbol) }
                }
                Button { copyLink() } label: {
                    Label { Text("Copy link") } icon: { Image(systemName: DuetGlyph.link.symbol) }
                }
                // M8: what the assistant did for this task, step by step (run records).
                Button { onRunDetails() } label: {
                    Label { Text("Run details") } icon: { Image(systemName: DuetGlyph.contents.symbol) }
                }
                Divider()
                Button(role: .destructive) { confirmingDelete = true } label: {
                    Label { Text("Delete") } icon: { Image(systemName: DuetGlyph.delete.symbol) }
                }
                .disabled(deleteRequest == .inFlight)
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                    .floatingCircle(Metrics.headerCircle)
            }
            // M14: a deleted task has nothing left to pin, archive or delete.
            .disabled(detail.phase == .gone)
            .opacity(detail.phase == .gone ? 0.4 : 1)
            .accessibilityLabel(Text("More"))
        }
    }

    private var capsule: some View {
        HStack(spacing: 8) {
            IconTile(app: nil, systemImage: "doc.text", size: 30, tint: Palette.primaryText)
            VStack(alignment: .leading, spacing: 1) {
                Group {
                    if let summary {
                        Text(verbatim: summary.title)
                    } else {
                        Text("Task")
                    }
                }
                .font(.system(size: titleSize, weight: .semibold))
                .foregroundStyle(Palette.primaryText)
                .lineLimit(1)
                .truncationMode(.tail)
                statusLine
                    .font(.system(size: lineSize))
                    .lineLimit(1)
                    .contentTransition(.opacity)
            }
        }
        .padding(.leading, 6)
        .padding(.trailing, 14)
        .padding(.vertical, 6)
        .chromeSurface(Capsule())
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
        .animation(.easeInOut(duration: 0.3), value: summary?.status)
        .animation(.easeInOut(duration: 0.3), value: summary?.updateCount)
    }

    /// "Working · 2 updates" (the live run status shows in the pill below the bar).
    @ViewBuilder
    private var statusLine: some View {
        if let summary {
            HStack(spacing: 0) {
                Text(summary.status.word)
                    .foregroundStyle(summary.status.color)
                    .shimmer(summary.status == .working)
                if summary.updateCount > 0 {
                    Text(verbatim: " · ").foregroundStyle(Palette.secondaryText)
                    Text("\(summary.updateCount) updates").foregroundStyle(Palette.secondaryText)
                }
            }
        }
    }

    /// Copies duet://tasks/<id>.
    private func copyLink() {
        UIPasteboard.general.string = "duet://tasks/\(detail.taskId)"
        copies += 1
    }
}
