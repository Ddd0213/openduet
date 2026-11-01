// M23 W5 (#29, review-ux §6, plan §6 W5): the newest open Up next suggestion floats above the
// composer: the lightbulb tile, its title and why, where it came from ("From Gmail · Re: Q4
// budget", "You asked"), Hide / Start. Swipe right starts it, left hides it, with the thread
// card's blur and wash (SuggestionSwipeCard). Several stack: the next ones peek out under it, a
// little smaller, and the next one rises and grows into place as the top one leaves. Start / Hide
// are Up next's own (TaskActions.addSuggestion / hideSuggestion), so answering it here answers it
// in Tasks, and a card answered elsewhere takes it away (the store, UpNextRefresh). The last one
// started leaves "✓ Started" in its place for a moment. The composer hides all of it while the
// user writes (ComposerSuggestionRules.isVisible). Reduce Motion: no movement, fades only.
import Accessibility
import SwiftUI

struct ComposerSuggestionStack: View {
    var upNext: ComposerUpNext
    var tasks: TaskActions

    @Environment(\.cardContext) private var context
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drag: CGFloat = 0
    @State private var width: CGFloat = 320
    /// The last answer per suggestion, so a failure's Retry repeats it.
    @State private var lastTap: [String: SuggestionSwipe.Outcome] = [:]
    /// The last card started here (it was the only one): "Started" shows in its place.
    @State private var startedId: String?
    @State private var starts = 0
    @State private var hides = 0

    /// One whose Start or Hide is in flight has flown off; a failed one comes back with the reason.
    private var shown: [Suggestion] {
        upNext.stack.filter { context.requests[$0.id] != .inFlight }
    }

    private var showsStarted: Bool {
        guard let startedId else { return false }
        return context.requests[startedId]?.failureReason == nil
    }

    var body: some View {
        let shown = shown
        if !shown.isEmpty || showsStarted {
            VStack(alignment: .leading, spacing: 6) {
                if let top = shown.first {
                    deck(top: top, under: Array(shown.dropFirst()))
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
                    if let reason = context.requests[top.id]?.failureReason {
                        InlineFailure(reason: reason) { retry(top) }
                            .padding(.horizontal, 4)
                            .transition(.opacity)
                    }
                } else {
                    StartedNote()
                        .transition(.opacity)
                        .task {
                            try? await Task.sleep(for: .seconds(2.5))
                            if !Task.isCancelled { startedId = nil }
                        }
                }
            }
            .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.4, dampingFraction: 0.86), value: shown.map(\.id))
            .animation(.easeInOut(duration: 0.25), value: showsStarted)
            .animation(.easeInOut(duration: 0.2), value: shown.first.flatMap { context.requests[$0.id]?.failureReason })
            .sensoryFeedback(.impact(weight: .medium), trigger: starts)
            .sensoryFeedback(.impact(weight: .light), trigger: hides)
            .sensoryFeedback(.warning, trigger: shown.first.flatMap { context.requests[$0.id]?.failureReason }) { _, new in new != nil }
        }
    }

    // MARK: Deck

    /// The top card, the ones under it peeking out below (a step smaller each); as the top one is
    /// dragged away the next one rises, grows and shows its face.
    private func deck(top: Suggestion, under: [Suggestion]) -> some View {
        let lift = SuggestionSwipe.progress(dx: drag, width: width)
        let under = Array(under.prefix(ComposerSuggestionRules.maxStack - 1))
        return topCard(top)
            .background {
                ZStack {
                    ForEach(Array(under.enumerated()).reversed(), id: \.element.id) { index, suggestion in
                        underCard(suggestion, depth: index + 1, lift: lift)
                    }
                }
            }
            .padding(.bottom, SuggestionSwipe.peek * CGFloat(under.count))
    }

    private func underCard(_ suggestion: Suggestion, depth: Int, lift: CGFloat) -> some View {
        Color.clear
            .overlay(alignment: .top) {
                SuggestionCardFace(suggestion: suggestion, onHide: {}, onStart: {})
                    .opacity(depth == 1 && !reduceMotion ? Double(lift) : 0)
            }
            .clipped()
            .cardSurface()
            .scaleEffect(SuggestionSwipe.stackScale(depth: depth, lift: lift, reduceMotion: reduceMotion), anchor: .bottom)
            .offset(y: SuggestionSwipe.stackOffset(depth: depth, lift: lift, reduceMotion: reduceMotion))
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    private func topCard(_ suggestion: Suggestion) -> some View {
        SuggestionSwipeCard(
            drag: $drag, width: $width, enabled: context.requests[suggestion.id] != .inFlight,
            onRelease: { release($0, suggestion) }
        ) {
            SuggestionCardFace(suggestion: suggestion, onHide: { hide(suggestion, swiped: false) }, onStart: { start(suggestion) })
        }
        .id(suggestion.id)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Up next: \(suggestion.title)"))
        .accessibilityAction(named: Text("Start")) { start(suggestion) }
        .accessibilityAction(named: Text("Hide")) { hide(suggestion, swiped: false) }
    }

    // MARK: Actions

    private func release(_ outcome: SuggestionSwipe.Outcome, _ suggestion: Suggestion) {
        switch outcome {
        case .start: start(suggestion)
        case .hide: hide(suggestion, swiped: true)
        case .cancel: break
        }
    }

    private func start(_ suggestion: Suggestion) {
        guard context.requests[suggestion.id] != .inFlight else { return }
        lastTap[suggestion.id] = .start
        starts += 1
        startedId = shown.count <= 1 ? suggestion.id : nil
        leave(to: width * 1.4) { tasks.addSuggestion(suggestion.id) }
    }

    /// Hide fades the card; a left swipe flies it off to the left first.
    private func hide(_ suggestion: Suggestion, swiped: Bool) {
        guard context.requests[suggestion.id] != .inFlight else { return }
        lastTap[suggestion.id] = .hide
        hides += 1
        startedId = nil
        if swiped {
            leave(to: -width * 1.4) { tasks.hideSuggestion(suggestion.id) }
        } else {
            withAnimation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.4, dampingFraction: 0.86)) {
                tasks.hideSuggestion(suggestion.id)
            }
        }
    }

    /// Flies the top card off, then sends: the card it uncovered has already risen into place, so
    /// the swap happens without another animation. Reduce Motion: fades instead.
    private func leave(to offset: CGFloat, then send: @escaping @MainActor () -> Void) {
        if reduceMotion {
            withAnimation(.easeInOut(duration: 0.25)) {
                drag = 0
                send()
            }
            return
        }
        withAnimation(.easeIn(duration: 0.22)) {
            drag = offset
        } completion: {
            var quiet = Transaction()
            quiet.disablesAnimations = true
            withTransaction(quiet) {
                drag = 0
                send()
            }
        }
    }

    private func retry(_ suggestion: Suggestion) {
        if lastTap[suggestion.id] == .hide { hide(suggestion, swiped: false) } else { start(suggestion) }
    }
}
