// Pieces of the Tasks tab's Active list (prompt L117, L185): a group header with its count
// ("Ready for review 8", "Updated 1 min. ago" on the right, a chevron on the folding groups),
// and a task row: rounded-square checkbox (tap = Mark complete, with undo), title ~20 pt up to two lines
// with the search match highlighted, the coloured status word + " · " + latest update (Working
// shimmers), and a channel tag line when the task is outside the tab's scope. M10: a trailing ⋯
// opens the long-press menu; the checkbox is hand-drawn (HandCheckbox) and draws its tick on.
// M22: title 17 pt medium, status line 15, check 22, group titles 17 regular grey; the next step
// replaces the latest update; a failed row says "Couldn't finish" with Try again; a resolved row's
// check reopens it; the tag line has the channel's colour dot (Everything) and the source label.
import SwiftUI

struct TaskGroupHeader: View {
    var kind: TaskGroupKind
    var count: Int
    /// "Updated 1 min. ago" next to Ready for review.
    var updatedAt: Date?
    var now: Date
    var collapsed: Bool
    var onToggle: () -> Void

    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .headline) private var fontSize: CGFloat = Metrics.taskGroupTitle

    /// M22: folded Done reads just "Done ›" (no number, as in the reference).
    private var showsCount: Bool { !(kind.isCollapsible && collapsed) }

    var body: some View {
        Button(action: onToggle) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                // M10: a quiet grey header, as in OpenDuet; the rows carry the status colours.
                // M22: 17 pt regular (was 15 medium).
                Text(kind.title)
                    .font(.system(size: fontSize, weight: .regular))
                    .foregroundStyle(Palette.secondaryText)
                if showsCount {
                    Text(verbatim: count.formatted())
                        .font(.system(size: fontSize, weight: .regular).monospacedDigit())
                        .foregroundStyle(Palette.secondaryText)
                        .contentTransition(.numericText(value: Double(count)))
                        .transition(.opacity)
                }
                if kind.isCollapsible {
                    Image(systemName: "chevron.right")
                        .font(.system(size: fontSize - 4, weight: .semibold))
                        .foregroundStyle(Palette.secondaryText)
                        .rotationEffect(.degrees(collapsed ? 0 : 90))
                        .accessibilityHidden(true)
                }
                Spacer(minLength: 8)
                if kind == .readyForReview, let updatedAt {
                    updatedLine(updatedAt)
                        .font(.system(size: fontSize - 2))
                        .foregroundStyle(Palette.secondaryText)
                        .lineLimit(1)
                }
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!kind.isCollapsible)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: count)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityValue(kind.isCollapsible ? (collapsed ? Text("Collapsed") : Text("Expanded")) : Text(verbatim: ""))
    }

    private func updatedLine(_ date: Date) -> Text {
        if let ago = CardFormat.ago(date, now: now, locale: locale) {
            return Text("Updated \(ago)")
        }
        return Text("Updated just now")
    }
}

extension TaskGroupKind {
    var title: LocalizedStringResource {
        switch self {
        case .pinned: "Pinned"
        case .readyForReview: "Ready for review"
        case .needsInput: "Waiting on you"
        case .failed: "Failed"
        case .working: "Working"
        case .comingUp: "Coming up"
        case .justDone: "Just done"
        case .done: "Done"
        }
    }
}

/// M9: what a task row's long-press offers (nil = no menu, e.g. previews). M10: the same menu
/// opens from the row's trailing ⋯ (TaskRowMenuModel): Discuss, Pin / Unpin, Mark complete (the
/// checkbox's undo toast), Rename (a small sheet), Archive, Copy link, Delete (asks in place).
struct TaskRowMenu {
    /// cardRequests[RequestKey.pinTask(id)] and [RequestKey.deleteTask(id)]
    var pinRequest: CardRequest?
    var deleteRequest: CardRequest?
    var onPin: (_ pinned: Bool) -> Void
    var onArchive: () -> Void
    var onDelete: () -> Void
    /// M10: cardRequests[RequestKey.renameTask(id)]; Rename opens the shell's rename sheet
    var renameRequest: CardRequest? = nil
    var onRename: () -> Void = {}
}

/// M10: a row's quiet trailing ⋯ (44 pt hit area) opening `menu` (the same items as the
/// long-press). Task rows and routine rows both use it.
struct RowMoreButton<Items: View>: View {
    @ViewBuilder var items: () -> Items

    @ScaledMetric(relativeTo: .body) private var glyph: CGFloat = 19

    var body: some View {
        Menu {
            items()
        } label: {
            DuetIcon(glyph: .more, size: glyph, tint: Palette.secondaryText)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .menuOrder(.fixed)
        .accessibilityLabel(Text("More"))
    }
}

struct TaskRow: View {
    var task: TaskSummary
    /// "#name" when the task lives outside the tab's scope (L117).
    var channelTag: String?
    var query: String
    var request: CardRequest?
    var now: Date
    var onOpen: () -> Void
    var onComplete: () -> Void
    var onRetry: () -> Void
    /// M9: the long-press menu
    var menu: TaskRowMenu? = nil
    /// M22: the 6 pt dot before the channel label (Everything only), in the channel's colour
    var channelColor: ChannelColor? = nil
    /// M22: "Try again" under a failed row (cardRequests[RequestKey.retryTask(id)]); nil = none
    var tryAgainRequest: CardRequest? = nil
    var onTryAgain: (() -> Void)? = nil
    /// M22: a resolved row's check reopens it (cardRequests[RequestKey.reopenTask(id)]); nil = it can't
    var reopenRequest: CardRequest? = nil
    var onReopen: (() -> Void)? = nil

    @Environment(\.locale) private var locale
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = Metrics.taskRowTitle
    @ScaledMetric(relativeTo: .subheadline) private var lineSize: CGFloat = Metrics.taskStatusLine
    @ScaledMetric(relativeTo: .body) private var box: CGFloat = Metrics.taskCheckbox
    @State private var completions = 0
    @State private var copies = 0
    @State private var confirmingDelete = false

    private var resolved: Bool { task.status == .resolved }
    /// M22: a Mark complete / Archive or a Reopen is out.
    private var busy: Bool { request == .inFlight || reopenRequest == .inFlight }
    private var offersTryAgain: Bool { onTryAgain != nil && TaskRowRules.canRetry(task) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            mainRow
            if let menu {
                if let reason = menu.pinRequest?.failureReason {
                    InlineFailure(reason: reason) { menu.onPin(!task.pinned) }
                        .padding(.leading, box + 12)
                        .transition(.opacity)
                }
                // M10: a rename that didn't go through (the old title is back); Retry reopens it.
                if let reason = menu.renameRequest?.failureReason {
                    InlineFailure(reason: reason, onRetry: menu.onRename)
                        .padding(.leading, box + 12)
                        .transition(.opacity)
                }
                if confirmingDelete || menu.deleteRequest == .inFlight {
                    DeleteConfirmStrip(
                        question: Text("Delete this task? Its conversation goes too."),
                        busy: menu.deleteRequest == .inFlight, failure: menu.deleteRequest?.failureReason,
                        onConfirm: menu.onDelete,
                        onCancel: { confirmingDelete = false }
                    )
                    .padding(.top, 4)
                    .transition(.confirmReveal(reduceMotion: reduceMotion))
                }
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.36, dampingFraction: 0.86), value: confirmingDelete)
        .animation(.easeInOut(duration: 0.2), value: menu?.pinRequest)
        .animation(.easeInOut(duration: 0.2), value: menu?.renameRequest)
        .sensoryFeedback(.impact(weight: .light), trigger: copies)
    }

    @ViewBuilder private var mainRow: some View {
        if let menu {
            HStack(alignment: .top, spacing: 0) {
                rowContent
                    .cleanContextPreview()
                    .contextMenu { menuItems(menu) }
                    .accessibilityAction(named: Text("Discuss")) { onOpen() }
                    .accessibilityAction(named: task.pinned ? Text("Unpin") : Text("Pin")) { menu.onPin(!task.pinned) }
                    .accessibilityAction(named: Text("Rename")) { menu.onRename() }
                    .accessibilityAction(named: Text("Archive")) { menu.onArchive() }
                    .accessibilityAction(named: Text("Copy link")) { copyLink() }
                    .accessibilityAction(named: Text("Delete")) { confirmingDelete = true }
                // M10: the same menu from a quiet ⋯ next to the title.
                RowMoreButton { menuItems(menu) }
                    .padding(.top, 2)
                    .padding(.trailing, -10)
            }
        } else {
            rowContent
        }
    }

    private func menuModel(_ menu: TaskRowMenu) -> TaskRowMenuModel {
        TaskRowMenuModel(
            pinned: task.pinned, resolved: resolved, updating: request == .inFlight,
            pinning: menu.pinRequest == .inFlight, renaming: menu.renameRequest == .inFlight,
            deleting: menu.deleteRequest == .inFlight
        )
    }

    /// One builder for the ⋯ button and the long-press (TaskRowMenuModel decides order and state).
    @ViewBuilder private func menuItems(_ menu: TaskRowMenu) -> some View {
        let model = menuModel(menu)
        ForEach(model.items, id: \.self) { item in
            if model.startsGroup(item) { Divider() }
            menuButton(item, menu: menu)
                .disabled(model.isDisabled(item))
        }
    }

    @ViewBuilder private func menuButton(_ item: TaskRowMenuItem, menu: TaskRowMenu) -> some View {
        switch item {
        case .discuss:
            Button(action: onOpen) {
                Label { Text("Discuss") } icon: { Image(systemName: DuetGlyph.chat.symbol) }
            }
        case .pin:
            Button { menu.onPin(!task.pinned) } label: {
                if task.pinned {
                    Label { Text("Unpin") } icon: { Image(systemName: "pin.slash") }
                } else {
                    Label { Text("Pin") } icon: { Image(systemName: DuetGlyph.pin.symbol) }
                }
            }
        case .markComplete:
            Button { toggle() } label: {
                Label { Text("Mark complete") } icon: { Image(systemName: DuetGlyph.done.symbol) }
            }
        case .rename:
            Button(action: menu.onRename) {
                Label { Text("Rename") } icon: { Image(systemName: DuetGlyph.edit.symbol) }
            }
        case .archive:
            Button(action: menu.onArchive) {
                Label { Text("Archive") } icon: { Image(systemName: DuetGlyph.archive.symbol) }
            }
        case .copyLink:
            Button { copyLink() } label: {
                Label { Text("Copy link") } icon: { Image(systemName: DuetGlyph.link.symbol) }
            }
        case .delete:
            Button(role: .destructive) { confirmingDelete = true } label: {
                Label { Text("Delete") } icon: { Image(systemName: DuetGlyph.delete.symbol) }
            }
        }
    }

    private func copyLink() {
        UIPasteboard.general.string = "duet://tasks/\(task.id)"
        copies += 1
    }

    private var rowContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 12) {
                checkbox
                Button(action: onOpen) {
                    VStack(alignment: .leading, spacing: 3) {
                        title
                        statusLine
                        tagLine
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle(scale: 0.99))
            }
            if case .failed(let reason) = request {
                InlineFailure(reason: reason, onRetry: onRetry)
                    .padding(.leading, box + 12)
            }
            // M22: a Reopen that didn't go through (the row is resolved again).
            if case .failed(let reason) = reopenRequest, let onReopen {
                InlineFailure(reason: reason, onRetry: onReopen)
                    .padding(.leading, box + 12)
            }
            // M22 (review-ux §2): Try again right on a failed row; its own failure has Retry.
            if offersTryAgain, let onTryAgain {
                if case .failed(let reason) = tryAgainRequest {
                    InlineFailure(reason: reason, onRetry: onTryAgain)
                        .padding(.leading, box + 12)
                } else {
                    CapsuleButton(title: Text("Try again"), style: .outline, busy: tryAgainRequest == .inFlight, fullWidth: false, action: onTryAgain)
                        .disabled(tryAgainRequest == .inFlight)
                        .padding(.leading, box + 12)
                }
            }
        }
        .padding(.vertical, 10)
        .opacity(busy ? 0.6 : 1)
        .animation(.easeInOut(duration: 0.2), value: request)
        .animation(.easeInOut(duration: 0.2), value: reopenRequest)
        .animation(.easeInOut(duration: 0.2), value: tryAgainRequest)
        .animation(.easeInOut(duration: 0.25), value: task.status)
        .sensoryFeedback(.impact(weight: .light), trigger: completions)
        .sensoryFeedback(.warning, trigger: request) { _, new in new?.failureReason != nil }
        .accessibilityElement(children: .combine)
        .accessibilityActions {
            if resolved {
                if onReopen != nil && TaskRowRules.canReopen(task) { Button { toggle() } label: { Text("Reopen") } }
            } else {
                Button { toggle() } label: { Text("Mark complete") }
            }
            if offersTryAgain, let onTryAgain { Button(action: onTryAgain) { Text("Try again") } }
        }
    }

    private var checkbox: some View {
        Button { toggle() } label: {
            // M10: drawn by hand; the tick draws itself on when the task resolves.
            HandCheckbox(checked: resolved, size: box)
                .padding(.top, 1)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.88))
        // M22: a resolved row's check can be tapped again (Reopen).
        .disabled(busy || (resolved && (onReopen == nil || !TaskRowRules.canReopen(task))))
        // The row is one VoiceOver element whose double-tap opens the task; Mark complete is
        // its named action, so the checkbox doesn't compete with Open inside the combined row.
        .accessibilityHidden(true)
    }

    private var title: some View {
        let ranges = TaskGrouping.matches(in: task.title, query: query)
        return Group {
            if ranges.isEmpty {
                Text(verbatim: task.title)
            } else {
                Text(HighlightedText.make(task.title, ranges: ranges))
            }
        }
        // M22: 17 pt medium (was 20 regular).
        .font(.system(size: titleSize, weight: .medium))
        .foregroundStyle(resolved ? Palette.secondaryText : Palette.primaryText)
        .lineLimit(2)
        .multilineTextAlignment(.leading)
        .fixedSize(horizontal: false, vertical: true)
    }

    /// "Working · Just started", "Ready for review · Check what OpenDuet changed", "Needs input ·
    /// Answer: …" (M22: the next step in place of the latest update), "Couldn't finish · <why>".
    private var statusLine: some View {
        let text = TaskStatusText(task)
        let failed: Bool = if case .failed = text { true } else { false }
        return HStack(alignment: .firstTextBaseline, spacing: 0) {
            Group {
                if failed { Text("Couldn't finish") } else { Text(task.status.word) }
            }
            .foregroundStyle(failed ? Palette.failure : task.status.color)
            .shimmer(!failed && task.status == .working)
            .fixedSize()
            .layoutPriority(1)
            Text(verbatim: " · ")
                .foregroundStyle(Palette.secondaryText)
                .accessibilityHidden(true)
            detail(text)
                .foregroundStyle(Palette.secondaryText)
                .lineLimit(1)
        }
        .font(.system(size: lineSize))
    }

    private func detail(_ text: TaskStatusText) -> Text {
        switch text {
        case .failed(let phrase), .nextStep(let phrase), .update(let phrase):
            return Text(verbatim: PhraseText.string(phrase, locale: locale))
        case .justStarted:
            return Text("Just started")
        case .updated(let date):
            if let ago = CardFormat.ago(date, now: now, locale: locale) { return Text("Updated \(ago)") }
            return Text("Updated just now")
        }
    }

    /// M22: the small grey line under the status: the channel (with its colour dot in
    /// Everything) when it's outside the tab's scope, then where the task came from.
    private var tagLine: some View {
        HStack(alignment: .center, spacing: 5) {
            if let channelTag {
                if let channelColor {
                    Circle()
                        .fill(channelColor.glyph(in: colorScheme))
                        .frame(width: Metrics.taskChannelDot, height: Metrics.taskChannelDot)
                        .accessibilityHidden(true)
                }
                Text(verbatim: "#\(channelTag)")
                Text(verbatim: "·").accessibilityHidden(true)
            }
            source
        }
        .font(.system(size: lineSize - 2))
        .foregroundStyle(Palette.secondaryText)
        .lineLimit(1)
    }

    private var source: Text {
        switch TaskSourceLabel(task) {
        case .youAsked: Text("You asked")
        case .fromApp(let app): Text("From \(app)")
        case .assistantSuggested: Text("OpenDuet suggested")
        }
    }

    /// The check: Mark complete, or (M22) Reopen on a resolved row.
    private func toggle() {
        guard !busy else { return }
        if resolved {
            guard let onReopen, TaskRowRules.canReopen(task) else { return }
            completions += 1
            onReopen()
        } else {
            completions += 1
            onComplete()
        }
    }
}

/// M8: after a checkbox tap, "Marked complete · Undo" floats at the bottom for ~4 s; the PATCH
/// goes out only when it expires (the store's timer), Undo puts the row back.
struct CompletionUndoToast: View {
    var onUndo: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 15

    var body: some View {
        HStack(spacing: 14) {
            Label {
                Text("Marked complete")
            } icon: {
                DuetIcon(glyph: .done, size: fontSize + 3, tint: Palette.success)
            }
            .foregroundStyle(Palette.primaryText)
            Button(action: onUndo) {
                Text("Undo")
                    .fontWeight(.semibold)
                    .foregroundStyle(Palette.accent)
                    .frame(minHeight: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle(scale: 0.92))
        }
        .font(.system(size: fontSize))
        .padding(.leading, 16)
        .padding(.trailing, 14)
        .padding(.vertical, 8)
        .background(
            Capsule()
                .fill(Palette.floatingSurface)
                .strokeBorder(Palette.hairline, lineWidth: Metrics.hairline)
                .floatingShadow()
        )
        .accessibilityElement(children: .contain)
        .onAppear {
            AccessibilityNotification.Announcement(String(localized: "Marked complete")).post()
        }
    }
}

/// Skeleton task rows while the first list loads (L184).
struct TaskRowsSkeleton: View {
    var rows = 4

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton).frame(width: 140, height: 14)
            ForEach(0..<rows, id: \.self) { index in
                HStack(alignment: .top, spacing: 12) {
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(Palette.skeleton)
                        .frame(width: Metrics.taskCheckbox, height: Metrics.taskCheckbox)
                    VStack(alignment: .leading, spacing: 8) {
                        RoundedRectangle(cornerRadius: 5).fill(Palette.skeleton)
                            .frame(height: 18)
                            .padding(.trailing, CGFloat(index % 2 == 0 ? 40 : 90))
                        RoundedRectangle(cornerRadius: 4).fill(Palette.skeleton)
                            .frame(width: 160, height: 12)
                    }
                }
            }
        }
        .skeletonPulse()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading tasks"))
    }
}

/// The grey reason line with Retry for a list that failed to load (L184).
struct InlineRetryLine: View {
    var reason: String
    var onRetry: () -> Void

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 15

    var body: some View {
        VStack(spacing: 12) {
            Text(verbatim: reason)
                .font(.system(size: fontSize))
                .foregroundStyle(Palette.secondaryText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            CapsuleButton(title: Text("Retry"), style: .outline, fullWidth: false, action: onRetry)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32)
    }
}
