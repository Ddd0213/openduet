// Task suggestions in chat (prompt L103-L104): the stacked suggestion list under a lead bubble
// (tap starts one; a started one dims with a green ✓), and the proactive suggestion card with
// Hide / Start. M23 (plan §6 W5, as in OpenDuet): swipe right starts, left hides; while it is
// dragged the card itself blurs and takes a green wash with ▷ Start on its left (a grey one with
// ✕ Hide for a left swipe), tilts, flies off, and collapses into "✓ Reviewed · See all tasks ›",
// whose circle and check draw themselves while "Reviewed" rises in; the row opens the Tasks tab.
// Medium haptic on start; Reduce Motion: no movement, the wash and the row only fade.
// SuggestionSwipeCard and DrawnCheckCircle are shared with the composer's Up next card.
import SwiftUI

// MARK: - Task suggestions (L103)

struct TaskSuggestionsCard: View {
    var message: Message
    var items: [TaskSuggestionsPayload.Item]
    var streaming: Bool
    var onStart: (_ itemId: String) -> Void
    var onSent: () -> Void

    @Environment(\.cardContext) private var context
    @State private var tapped: String?
    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var promptSize: CGFloat = 14

    private var request: CardRequest? { context.requests[message.id] }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.bubbleSpacing + 2) {
            LeadBubble(text: message.text, streaming: streaming)
            ForEach(items) { item in
                row(item)
            }
            if case .failed(let reason) = request, let tapped {
                InlineFailure(reason: reason) { start(tapped) }
            }
        }
        .animation(.easeInOut(duration: 0.25), value: items.map(\.taskId))
        .animation(.easeInOut(duration: 0.2), value: request)
        .sensoryFeedback(.impact(weight: .light), trigger: tapped) { _, new in new != nil }
        .sensoryFeedback(.warning, trigger: request) { _, new in new?.failureReason != nil }
    }

    private func row(_ item: TaskSuggestionsPayload.Item) -> some View {
        let started = item.taskId != nil
        let busy = request == .inFlight && tapped == item.id
        return Button { start(item.id) } label: {
            HStack(alignment: .top, spacing: 12) {
                tile(item)
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: item.title)
                        .font(.system(size: titleSize, weight: .semibold))
                        .foregroundStyle(Palette.primaryText)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(verbatim: "\u{201C}\(item.prompt)\u{201D}")
                        .font(.system(size: promptSize))
                        .foregroundStyle(Palette.secondaryText)
                        .multilineTextAlignment(.leading)
                        .lineLimit(3)
                }
                Spacer(minLength: 4)
                ZStack {
                    if started {
                        DuetIcon(glyph: .check, size: 20, tint: Palette.success)
                            .transition(.scale.combined(with: .opacity))
                    } else if busy {
                        ProgressView().controlSize(.small).transition(.opacity)
                    }
                }
                .frame(width: 22, height: 22)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardSurface()
            .opacity(started ? 0.55 : 1)
            .contentShape(RoundedRectangle(cornerRadius: Metrics.cardCorner, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .disabled(started || request == .inFlight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(item.title). \(item.prompt)"))
        .accessibilityValue(started ? Text("Started") : Text(verbatim: ""))
        .accessibilityHint(started ? Text(verbatim: "") : Text("Starts this task"))
        .accessibilityAddTraits(.isButton)
    }

    /// M9: the icon the assistant picked; without one, the app's mark when the item names an app, else
    /// the lightbulb (all from the hand-drawn set).
    @ViewBuilder private func tile(_ item: TaskSuggestionsPayload.Item) -> some View {
        if let icon = item.icon {
            DuetIconTile(icon: icon)
        } else if CardFormat.toolkitSlug(item.app) != nil {
            IconTile(app: item.app)
        } else {
            DuetIconTile(icon: .lightbulb)
        }
    }

    private func start(_ itemId: String) {
        tapped = itemId
        onStart(itemId)
        onSent()
    }
}

// MARK: - Proactive suggestion (L104)

struct ProactiveSuggestionCard: View {
    var message: Message
    var payload: ProactiveSuggestionPayload
    var streaming: Bool
    var onStart: () -> Void
    var onHide: () -> Void
    var onOpenTask: (_ taskId: String) -> Void
    var onSent: () -> Void

    @Environment(\.cardContext) private var context
    @Environment(\.cardHooks) private var hooks
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drag: CGFloat = 0
    @State private var cardWidth: CGFloat = 320
    /// Set when the user starts it here, so the row shows before the server's echo (and only
    /// then does the row's check draw itself).
    @State private var startedHere = false
    @State private var hidHere = false
    /// The last answer tapped or swiped, so a failure's Retry repeats it.
    @State private var lastTap: SuggestionSwipe.Outcome = .start
    @State private var starts = 0
    @State private var hides = 0

    @ScaledMetric(relativeTo: .body) private var titleSize: CGFloat = 17
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 15

    private var request: CardRequest? { context.requests[message.id] }
    private var failed: String? { if case .failed(let reason) = request { reason } else { nil } }

    private enum Display: Hashable { case open, started, hidden }

    private var display: Display {
        switch payload.state {
        case .started: return .started
        case .hidden: return .hidden
        case .open:
            if failed != nil { return .open }
            if startedHere { return .started }
            if hidHere { return .hidden }
            return .open
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.bubbleSpacing + 2) {
            LeadBubble(text: message.text, streaming: streaming)
            switch display {
            case .open:
                card.transition(.opacity)
            case .started:
                // M10 (as in OpenDuet): the card has flown off; its slot collapses into one
                // quiet "✓ Reviewed · See all tasks ›" row that opens the Tasks tab (M23: drawn
                // in when it was started here).
                StartedRow(onOpenTask: payload.taskId.map { id in { onOpenTask(id) } }, animated: startedHere) {
                    hooks.showAllTasks()
                }
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.96, anchor: .leading)))
            case .hidden:
                EmptyView()
            }
            if let failed {
                InlineFailure(reason: failed) { retry() }
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.3) : .spring(response: 0.45, dampingFraction: 0.85), value: display)
        .animation(.easeInOut(duration: 0.2), value: failed)
        .sensoryFeedback(.impact(weight: .medium), trigger: starts)
        .sensoryFeedback(.impact(weight: .light), trigger: hides)
        .sensoryFeedback(.warning, trigger: failed) { _, new in new != nil }
        .onChange(of: failed) { _, reason in
            // A rejected Start / Hide puts the card back.
            if reason != nil { startedHere = false; hidHere = false; drag = 0 }
        }
    }

    // MARK: Card

    private var card: some View {
        SuggestionSwipeCard(drag: $drag, width: $cardWidth, enabled: request != .inFlight, onRelease: release) {
            content
        }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: Text("Start")) { start() }
        .accessibilityAction(named: Text("Hide")) { hide() }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                // M9: the set's lightbulb on a tile, in the accent (was a bare SF lightbulb).
                DuetIconTile(icon: .lightbulb, tint: Palette.accent, accent: Palette.accent)
                Text(verbatim: payload.title)
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(Palette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !payload.body.isEmpty {
                Text(verbatim: payload.body)
                    .font(.system(size: bodySize))
                    .foregroundStyle(Palette.primaryText.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                CapsuleButton(title: Text("Hide"), style: .outline) { hide() }
                    .accessibilityLabel(Text("Hide \(payload.title)"))
                CapsuleButton(title: Text("Start"), style: .filled, busy: request == .inFlight) { start() }
                    .accessibilityLabel(Text("Start \(payload.title)"))
            }
            .disabled(request == .inFlight)
            .padding(.top, 2)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Actions

    private func release(_ outcome: SuggestionSwipe.Outcome) {
        switch outcome {
        case .start: start()
        case .hide: hide(swiped: true)
        case .cancel: break
        }
    }

    private func start() {
        guard request != .inFlight, display == .open else { return }
        lastTap = .start
        starts += 1
        // Fly off to the right, then collapse into the started row.
        fly(to: cardWidth * 1.4) {
            startedHere = true
            onStart()
            onSent()
        }
    }

    /// The Hide button fades the card; a left swipe flies it off to the left first.
    private func hide(swiped: Bool = false) {
        guard request != .inFlight, display == .open else { return }
        lastTap = .hide
        hides += 1
        let commit: @MainActor () -> Void = {
            hidHere = true
            onHide()
        }
        if swiped { fly(to: -cardWidth * 1.4, then: commit) } else { commit() }
    }

    private func fly(to offset: CGFloat, then commit: @escaping @MainActor () -> Void) {
        if reduceMotion { return commit() }
        withAnimation(.easeIn(duration: 0.22)) {
            drag = offset
        } completion: {
            commit()
        }
    }

    private func retry() {
        drag = 0
        if lastTap == .hide { hide() } else { start() }
    }
}

/// "✓ Reviewed            See all tasks ›" (M10, as in OpenDuet): a started suggestion, swiped
/// away and collapsed into one quiet outlined row. A tap opens the Tasks tab; VoiceOver can also
/// open the task itself.
/// M23: started here (`animated`), the circle and the check draw themselves in one stroke and
/// "Reviewed" rises in from below; Reduce Motion fades them in. Loaded started, it rests drawn.
struct StartedRow: View {
    var onOpenTask: (() -> Void)?
    var animated = false
    var onSeeAll: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 15
    @State private var risen: Bool

    init(onOpenTask: (() -> Void)?, animated: Bool = false, onSeeAll: @escaping () -> Void) {
        self.onOpenTask = onOpenTask
        self.animated = animated
        self.onSeeAll = onSeeAll
        _risen = State(initialValue: !animated)
    }

    var body: some View {
        Button(action: onSeeAll) {
            HStack(spacing: 8) {
                DrawnCheckCircle(size: fontSize + 3, tint: Palette.secondaryText, animated: animated)
                Text("Reviewed")
                    .foregroundStyle(Palette.secondaryText)
                    .lineLimit(1)
                    .offset(y: risen || reduceMotion ? 0 : fontSize)
                    .opacity(risen ? 1 : 0)
                    .clipped()
                Spacer(minLength: 8)
                HStack(spacing: 2) {
                    Text("See all tasks")
                    Image(systemName: "chevron.right").font(.system(size: fontSize - 3, weight: .semibold))
                }
                .foregroundStyle(Palette.secondaryText)
                .lineLimit(1)
                .fixedSize()
            }
            .font(.system(size: fontSize))
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Palette.hairline, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Reviewed"))
        .accessibilityHint(Text("See all tasks"))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: Text("Open task")) { onOpenTask?() }
        .onAppear {
            guard !risen else { return }
            // After the circle, while the check draws.
            withAnimation(reduceMotion ? .easeInOut(duration: 0.3) : .spring(response: 0.4, dampingFraction: 0.82).delay(0.22)) {
                risen = true
            }
        }
    }
}

/// M23: a circle and a check that draw themselves (trim), the circle first, then the check, as one
/// stroke. Reduce Motion: drawn at once, faded in. `animated` false: drawn from the start.
struct DrawnCheckCircle: View {
    var size: CGFloat
    var tint: Color
    var animated = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var ring: CGFloat
    @State private var tick: CGFloat
    @State private var shown: Bool

    init(size: CGFloat, tint: Color, animated: Bool = true) {
        self.size = size
        self.tint = tint
        self.animated = animated
        _ring = State(initialValue: animated ? 0 : 1)
        _tick = State(initialValue: animated ? 0 : 1)
        _shown = State(initialValue: !animated)
    }

    var body: some View {
        let line = max(1.4, size * 0.09)
        ZStack {
            Circle()
                .trim(from: 0, to: ring)
                .stroke(tint, style: StrokeStyle(lineWidth: line, lineCap: .round))
                .rotationEffect(.degrees(-90))
            CheckStroke(progress: tick, lineWidth: line * 1.1, color: tint)
                .padding(size * 0.27)
        }
        .frame(width: size, height: size)
        .opacity(shown ? 1 : 0)
        .accessibilityHidden(true)
        .onAppear(perform: draw)
    }

    private func draw() {
        guard animated, ring < 1 else { return }
        if reduceMotion {
            ring = 1
            tick = 1
            withAnimation(.easeInOut(duration: 0.3)) { shown = true }
            return
        }
        shown = true
        withAnimation(.easeOut(duration: 0.3)) { ring = 1 }
        withAnimation(.easeOut(duration: 0.24).delay(0.26)) { tick = 1 }
    }
}

/// M23: a suggestion card that follows a sideways drag (shared by the thread's proactive card and
/// the composer's Up next card). While dragged, the card itself blurs and takes a green wash with
/// ▷ Start on its left (right), or a grey one with ✕ Hide on its right (left), and tilts a little.
/// Reduce Motion: it stays put; the wash and the word fade with the drag. The parent answers the
/// release (SuggestionSwipe.outcome) and flies the card off by animating `drag`.
struct SuggestionSwipeCard<Content: View>: View {
    @Binding var drag: CGFloat
    @Binding var width: CGFloat
    var enabled = true
    var allowsHide = true
    var onRelease: (SuggestionSwipe.Outcome) -> Void
    @ViewBuilder var content: Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var progress: CGFloat { SuggestionSwipe.progress(dx: drag, width: width) }
    private var starting: Bool { drag >= 0 }
    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: Metrics.cardCorner, style: .continuous) }

    var body: some View {
        content
            .blur(radius: SuggestionSwipe.blur(progress, reduceMotion: reduceMotion))
            .overlay { wash }
            .overlay(alignment: starting ? .leading : .trailing) { label }
            .background { Color.clear.cardSurface() }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .offset(x: reduceMotion ? 0 : drag)
            .rotationEffect(.degrees(reduceMotion ? 0 : Double(drag / 28)), anchor: .bottom)
            .simultaneousGesture(swipe, including: enabled ? .all : .subviews)
    }

    private var wash: some View {
        shape
            .fill(starting ? Palette.startPanel : SuggestionSwipeCard.hideWash)
            .opacity(drag == 0 ? 0 : SuggestionSwipe.wash(progress))
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    private var label: some View {
        HStack(spacing: 10) {
            DuetIcon(glyph: starting ? .play : .close, size: 18, tint: starting ? Palette.startPanel : SuggestionSwipeCard.hideWash)
                .frame(width: 34, height: 34)
                .background(Circle().fill(.white))
            (starting ? Text("Start") : Text("Hide"))
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 18)
        .scaleEffect(0.85 + 0.15 * progress, anchor: starting ? .leading : .trailing)
        .opacity(drag == 0 ? 0 : Double(progress))
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var swipe: some Gesture {
        DragGesture(minimumDistance: 14)
            .onChanged { value in
                let dx = value.translation.width, dy = value.translation.height
                guard SuggestionSwipe.isHorizontal(dx: dx, dy: dy), allowsHide || dx > 0 else { return }
                drag = dx
            }
            .onEnded { value in
                let outcome = SuggestionSwipe.outcome(
                    dx: value.translation.width, dy: value.translation.height,
                    predictedDx: value.predictedEndTranslation.width, width: width, allowsHide: allowsHide
                )
                if outcome == .cancel {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) { drag = 0 }
                }
                onRelease(outcome)
            }
    }

    /// Hide's wash: a dark grey in light, a lighter grey in dark (white text on both).
    static var hideWash: Color { Color.dynamic(light: 0x6E6E6A, dark: 0x5A5A57) }
}
