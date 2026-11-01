// M10: a task row's Rename (⋯ or long-press): a small sheet with the title in a text field. Save
// sends the trimmed title (1-200 characters, TaskTitleRule) through TaskActions.rename; the row
// shows it at once. Save shows a spinner while cardRequests[RequestKey.renameTask(id)] is in
// flight, the reason with Retry when it fails (the row went back to the old title); the sheet
// closes once the request is gone without failing.
import SwiftUI

struct RenameTaskSheet: View {
    var task: TaskSummary
    var request: CardRequest?
    /// Another change of this task (Pin) is still in flight: Save waits for it.
    var busyElsewhere: Bool
    var onSave: (_ title: String) -> Void
    var onClose: () -> Void

    @State private var draft = ""
    @State private var saved = false
    @State private var saves = 0
    @State private var successes = 0
    @FocusState private var focused: Bool
    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 17
    @ScaledMetric(relativeTo: .footnote) private var noteSize: CGFloat = 13

    private var canSave: Bool {
        TaskTitleRule.canSave(draft, current: task.title) && request != .inFlight && !busyElsewhere
    }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Rename task"), leading: .close, onLeading: onClose)
            VStack(alignment: .leading, spacing: 14) {
                TextField(text: $draft, axis: .vertical) { Text("Task name") }
                    .font(.system(size: fontSize))
                    .lineLimit(1...4)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit(save)
                    .padding(14)
                    .cardSurface(corner: 16)
                    .disabled(request == .inFlight)
                    .accessibilityLabel(Text("Task name"))
                if TaskTitleRule.isTooLong(draft) {
                    Label {
                        Text("Use 200 characters or fewer.")
                    } icon: {
                        DuetIcon(glyph: .warning, size: noteSize + 2, tint: Palette.failure)
                    }
                    .font(.system(size: noteSize))
                    .foregroundStyle(Palette.secondaryText)
                    .transition(.opacity)
                }
                // A failure left over from earlier stays hidden until Save is tapped here.
                if saved, let reason = request?.failureReason {
                    InlineFailure(reason: reason) { save() }
                }
                CapsuleButton(title: Text("Save"), style: .filled, busy: request == .inFlight, action: save)
                    .disabled(!canSave)
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            Spacer(minLength: 0)
        }
        .background(Palette.sheetBackground.ignoresSafeArea())
        .animation(.easeInOut(duration: 0.2), value: request)
        .animation(.easeInOut(duration: 0.2), value: TaskTitleRule.isTooLong(draft))
        // Save is the user's own change (light); renamed = success, refused = warning.
        .sensoryFeedback(.impact(weight: .light), trigger: saves)
        .sensoryFeedback(.success, trigger: successes)
        .sensoryFeedback(.warning, trigger: request) { _, new in saved && new?.failureReason != nil }
        .onAppear {
            draft = task.title
            focused = true
        }
        .onChange(of: request) { old, new in
            // Renamed: the request entry goes away without failing.
            if saved, old == .inFlight, new == nil {
                successes += 1
                onClose()
            }
        }
    }

    private func save() {
        guard canSave, let title = TaskTitleRule.cleaned(draft) else { return }
        saved = true
        saves += 1
        onSave(title)
    }
}
