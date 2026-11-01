// The Tasks tab's + sheet (the FAB itself is Components/PlusFAB.swift, placed by ShellChrome;
// prompt L120, L161): one text field, Start (TaskActions.create) and, M22, a secondary "Save for
// Up next" (TaskActions.saveForLater: POST /api/up-next, the suggestion heads Up next at once).
// The tapped button shows a spinner while its request (cardRequests[ShellState.createTaskRequest]
// / [RequestKey.saveForLater]) is in flight, the reason with Retry when it fails; the sheet
// closes once that request is gone without failing.
import SwiftUI

struct NewTaskSheet: View {
    var request: CardRequest?
    var saveRequest: CardRequest? = nil
    var onStart: (_ prompt: String) -> Void
    var onSave: (_ prompt: String) -> Void = { _ in }
    var onDone: () -> Void

    /// Which button was tapped last in this sheet (a failure left over from an earlier sheet
    /// stays hidden until its button is tapped here).
    private enum Tapped { case start, save }

    @State private var prompt = ""
    @State private var tapped: Tapped?
    @State private var starts = 0
    @State private var successes = 0
    @FocusState private var focused: Bool
    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 17

    private var trimmed: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var busy: Bool { request == .inFlight || saveRequest == .inFlight }

    private var failure: String? {
        switch tapped {
        case .start?: request?.failureReason
        case .save?: saveRequest?.failureReason
        case nil: nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            TextField(text: $prompt, axis: .vertical) {
                Text("What should OpenDuet work on?")
            }
            .font(.system(size: fontSize))
            .lineLimit(3...8)
            .focused($focused)
            .padding(14)
            .cardSurface(corner: 16)
            .disabled(busy)
            if let failure {
                InlineFailure(reason: failure) { tapped == .save ? save() : start() }
            }
            // Side by side while they fit (Save at its own width, Start takes the rest); stacked
            // full width at large text sizes, Start first.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    saveButton(fullWidth: false).fixedSize()
                    startButton
                }
                VStack(spacing: 8) {
                    startButton
                    saveButton(fullWidth: true)
                }
            }
        }
        .padding(20)
        .padding(.top, 8)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Palette.background.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(28)
        .animation(.easeInOut(duration: 0.2), value: request)
        .animation(.easeInOut(duration: 0.2), value: saveRequest)
        // Start / Save sends the prompt (light); created / saved = success, refused = warning.
        .sensoryFeedback(.impact(weight: .light), trigger: starts)
        .sensoryFeedback(.success, trigger: successes)
        .sensoryFeedback(.warning, trigger: failure) { _, new in new != nil }
        .onAppear { focused = true }
        .onChange(of: request) { old, new in
            // Created: the request entry goes away without failing.
            if tapped == .start, old == .inFlight, new == nil { finish() }
        }
        .onChange(of: saveRequest) { old, new in
            if tapped == .save, old == .inFlight, new == nil { finish() }
        }
    }

    private var startButton: some View {
        CapsuleButton(title: Text("Start"), style: .filled, busy: request == .inFlight) { start() }
            .disabled(trimmed.isEmpty || busy)
    }

    private func saveButton(fullWidth: Bool) -> some View {
        CapsuleButton(title: Text("Save for Up next"), style: .outline, busy: saveRequest == .inFlight, fullWidth: fullWidth) { save() }
            .disabled(trimmed.isEmpty || busy)
            .accessibilityHint(Text("Adds it to Up next without starting it"))
    }

    private func start() {
        guard !trimmed.isEmpty, !busy else { return }
        tapped = .start
        starts += 1
        onStart(trimmed)
    }

    private func save() {
        guard !trimmed.isEmpty, !busy else { return }
        tapped = .save
        starts += 1
        onSave(trimmed)
    }

    private func finish() {
        successes += 1
        onDone()
    }
}
