// The main thread (prompt L99-L114, L162, L184): oldest to newest in a bottom-anchored scroll
// view that keeps the newest message in view unless the user scrolled up themselves (the bottom
// is measured: the content's bottom edge against the unobscured area's, both global; the top
// comes from scroll geometry). Scrolling near the top loads older pages and keeps
// the reading position; the thread on screen marks itself read (M21: at any scroll position).
// M9: the swipe that shows a message's time is per bubble now (ThreadRowView / BubbleSwipe).
// M19: a thread at rest past its own end (blank) jumps back (OverscrollRule); a send's jump waits
// for the keyboard and the tab bar to settle; a fixed invisible last row again (the bottom anchor
// and the jumps resolve against it, not against a row still animating in); the visible bottom
// moving under a pinned thread (keyboard, composer, tab bar) is followed on the keyboard's curve,
// never with an instant jump; rows skip re-rendering when nothing they show changed.
// M29: a deep link's message is scrolled to only while the thread is on screen, and the focus is
// done once its row is measured in view (FocusScrollRule). A pinned thread follows its own content
// (a new row, a streaming reply, the typing row going) animated on the rows' curve, one follow at a
// time, instead of the bottom anchor's instant offset change (ContentFollowRule).
import OSLog
import SwiftUI

/// Device diagnostics for the thread's scrolling (Console, category "thread"; `.notice` so they're
/// kept): overscroll flips and heals, and each send's jump.
private let threadLog = Logger(subsystem: "dev.openduet.OpenDuet", category: "thread")

struct ThreadView<Header: View>: View {
    var thread: ThreadState
    /// The live status (header pill); with typing it tells which reply is still streaming.
    var status: StatusKey?
    /// The Chat tab is showing: only then is the thread marked read (M21: on screen is enough).
    var isActive: Bool
    var actions: ShellActions
    /// Bumped by the composer's send: jump to the bottom.
    var jumpRequest: Int
    /// Content above the messages that scrolls with them (task detail's body, L121). With a
    /// header the thread opens at the top and only follows new messages once the user has
    /// been at the bottom.
    var header: Header

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var position: ScrollPosition
    @State private var atBottom: Bool
    @State private var nearTop = false
    @State private var userScrolling = false
    /// Keeps the bottom anchor while an older page is prepended, so the reading position holds.
    @State private var holdBottom = false
    @State private var localJumps = 0
    @State private var safari: SafariLink?
    /// Edits by chat (L163): versions already seen, and the fields glowing right now.
    @State private var glowTracker = EditGlowTracker()
    @State private var glowing: [String: Set<String>] = [:]
    @State private var glowToken = 0
    @State private var scrollTarget: String?
    /// The thread follows new content at the bottom (always in the main thread; in a task
    /// detail once the user has been at the bottom or sent something).
    @State private var followArmed: Bool
    /// M10: the ↓ circle, from the live scroll position only (JumpButtonRule), never from a tap.
    @State private var showsJump = false
    /// M8: an animated jump to the bottom is under way (↓, a send, a new row). Its first frames
    /// aren't at the bottom yet; they must not read as "content grew under a pinned thread",
    /// whose instant jump would cancel the animation. Cleared at the bottom, by a drag, at idle,
    /// or after a short timeout.
    @State private var programmatic = false
    @State private var programmaticToken = 0
    /// The latest scroll geometry, for re-evaluating the bottom when scrolling stops (no state:
    /// it changes every frame).
    @State private var edgesBox = EdgesBox()
    /// M19: a send asked for the bottom (composer or a card's tap); the jump runs once the
    /// keyboard and the tab bar have settled (sendJumpWhenSettled).
    @State private var sendJumps = 0
    /// M29: the bottom anchor is kept for size changes (as before M29) while the list has just
    /// appeared or the visible bottom is moving (keyboard, composer, tab bar); otherwise a pinned
    /// thread anchors at the top and follows its content itself (ContentFollowRule).
    @State private var anchorSettling = true

    private var hasHeader: Bool { Header.self != EmptyView.self }

    init(thread: ThreadState, status: StatusKey?, isActive: Bool, actions: ShellActions, jumpRequest: Int, @ViewBuilder header: () -> Header) {
        self.thread = thread
        self.status = status
        self.isActive = isActive
        self.actions = actions
        self.jumpRequest = jumpRequest
        self.header = header()
        let top = Header.self != EmptyView.self
        _position = State(initialValue: ScrollPosition(edge: top ? .top : .bottom))
        _atBottom = State(initialValue: !top)
        _followArmed = State(initialValue: !top)
    }

    var body: some View {
        ZStack {
            switch screen {
            case .skeleton:
                ThreadSkeleton().transition(.opacity)
            case .failed(let reason):
                ThreadFailedView(reason: reason, onRetry: actions.reloadThread).transition(.opacity)
            case .empty:
                ThreadEmptyView().transition(.opacity)
            case .list:
                list.transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: screen)
        .environment(\.openURL, OpenURLAction { url in route(url) })
        .environment(\.glowingFields, glowing)
        .sheet(item: $safari) { link in
            SafariView(url: link.url).ignoresSafeArea()
        }
        .onAppear { _ = glowTracker.update(thread.edits) }
        .onChange(of: thread.edits) { _, edits in editsChanged(edits) }
        .task(id: glowToken) {
            guard glowToken > 0 else { return }
            try? await Task.sleep(for: .seconds(Metrics.editGlowSeconds))
            if !Task.isCancelled { glowing = [:] }
        }
    }

    // MARK: - Screens

    private enum Screen: Hashable { case skeleton, failed(String), empty, list }

    private var screen: Screen {
        let hasContent = !thread.messages.isEmpty || !thread.pending.isEmpty || thread.typing || thread.statusBubble != nil
        if hasContent || hasHeader { return .list }
        switch thread.phase {
        case .loading: return .skeleton
        case .failed(let reason): return .failed(reason)
        case .loaded: return .empty
        }
    }

    // MARK: - List

    private var list: some View {
        let rows = ThreadLayout.rows(for: thread)
        let streamingId = streamingMessageId
        let focusRowId = ThreadLayout.focusRow(thread.focus, in: rows)
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if hasHeader {
                        header
                        inlineState
                    }
                    ForEach(rows) { row in
                        // M19: value-compared (EquatableThreadRow), so a store write re-renders
                        // only the rows whose message, layout or streaming changed.
                        EquatableThreadRow(row: row, streaming: row.id == streamingId.map { "m:\($0)" }, actions: actions) {
                            localJumps += 1
                        }
                        .equatable()
                        // M29: a deep link's row is measured, so its scroll is known to have landed.
                        .modifier(FocusRowProbe(rowId: row.id, focused: row.id == focusRowId, box: edgesBox))
                        .padding(.top, spacing(row.gap))
                        .transition(rowTransition)
                        .id(row.id)
                    }
                    // M19: a fixed, invisible last row (as the footer line was before M16): a new
                    // row goes in above it, so the bottom anchor and the jumps to the bottom never
                    // resolve against a row that is still animating in. With the padding below it,
                    // the 22 pt above the composer the user approved.
                    Color.clear
                        .frame(height: ThreadEnd.height)
                        .accessibilityHidden(true)
                        .id(ThreadEnd.id)
                }
                .padding(.horizontal, Metrics.threadInset)
                // M29: the stack's padding at the top only; below, it is part of the last row, so a
                // scroll onto that row lands exactly at the content's end (fromBottom 0).
                .padding(.top, ThreadEnd.padding)
                // M29: the focus row is measured here, against the same frame as the content's edges.
                .coordinateSpace(.named(FocusRowProbe.space))
                .animation(rowAnimation, value: rows.map(\.id))
                // The content's edges (global): the bottom for ↓ and following it, both for the
                // overscroll check (M19).
                .onGeometryChange(for: EdgeSpan.self) { EdgeSpan($0.frame(in: .global)) } action: { span in
                    edgesBox.content = span
                    bottomMeasured(visibleMoved: false)
                }
            }
            .onAppear {
                edgesBox.proxy = proxy
                // M29: the first layout passes (rows measured, the skeleton replaced) keep the
                // bottom anchor, as before.
                holdBottomAnchor(appearing: true)
            }
            .onChange(of: scrollTarget) { _, target in
                // An edited card scrolls into view (L163); following the bottom pauses until
                // the user is back there.
                guard let target, let row = rows.first(where: { Self.message(in: $0)?.id == target }) else { return }
                atBottom = false
                withAnimation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.45, dampingFraction: 0.9)) {
                    proxy.scrollTo(row.id, anchor: .center)
                }
                scrollTarget = nil
            }
            // M21: a deep link's message (?message=), once its row is on the page. M29: and once
            // the thread is on screen (a link tapped on another tab).
            .task(id: FocusKey(focus: thread.focus, row: focusRowId, active: isActive)) {
                await scrollToFocus(proxy: proxy, row: focusRowId)
            }
            .modifier(ThreadScrolling(view: self, rows: rows))
        }
    }

    /// The first page of a task's thread, under its header: skeleton bubbles or the reason + Retry.
    @ViewBuilder
    private var inlineState: some View {
        if thread.messages.isEmpty && thread.pending.isEmpty {
            switch thread.phase {
            case .loading:
                OlderSkeleton().padding(.top, Metrics.sectionSpacing)
            case .failed(let reason):
                InlineFailure(reason: reason, onRetry: actions.reloadThread)
                    .padding(.top, Metrics.sectionSpacing)
            case .loaded:
                EmptyView()
            }
        }
    }

    private static func message(in row: ThreadRow) -> Message? {
        if case .message(let message, _) = row.kind { message } else { nil }
    }

    // MARK: - Deep link focus (M21)

    /// M29: `active` too, so a focus set while the thread was off screen (a link tapped on the
    /// Tasks tab: the TabView keeps this page alive) scrolls once the thread is on screen.
    private struct FocusKey: Equatable {
        var focus: ThreadFocus?
        var row: String?
        var active: Bool
    }

    /// The thread opened from a link that names a message: centre it once its row is laid out
    /// (following the bottom pauses until the user is back there), then tell the store.
    /// M29 (FocusScrollRule): only while the thread is on screen; the scroll waits for both edges
    /// to be measured and for an older page to have gone in, and the focus is done only once the
    /// row is measured in view (else up to maxAttempts scrolls). Before, it scrolled at once, even
    /// under another tab where the scroll didn't stick, and dropped the focus 0.85 s later anyway.
    private func scrollToFocus(proxy: ScrollViewProxy, row: String?) async {
        guard let focus = thread.focus, let row, isActive else { return }
        // Following the bottom pauses now: a pinned thread's own jump (the tab bar or composer
        // settling as the page appears) must not take it back down meanwhile.
        atBottom = false
        // The list may have just replaced the skeleton: let its rows lay out first.
        try? await Task.sleep(for: .milliseconds(250))
        var attempts = 0, waits = 0
        while !Task.isCancelled {
            let step = FocusScrollRule.next(
                active: isActive, laidOut: edgesBox.content != nil && edgesBox.visible != nil,
                holdingBottom: holdBottom, userScrolling: userScrolling,
                attempts: attempts, waits: waits, shown: focusRowShown(row)
            )
            switch step {
            case .wait:
                waits += 1
                try? await Task.sleep(for: .milliseconds(120))
                continue
            case .scroll:
                attempts += 1
                atBottom = false
                withAnimation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.45, dampingFraction: 0.9)) {
                    proxy.scrollTo(row, anchor: .center)
                }
                threadLog.notice("thread focus row=\(row, privacy: .private) attempt=\(attempts, privacy: .public) waits=\(waits, privacy: .public)")
                try? await Task.sleep(for: .milliseconds(600))
                continue
            case .done, .letGo:
                threadLog.notice("thread focus \(step == .done ? "shown" : "let go", privacy: .public) attempts=\(attempts, privacy: .public)")
            }
            break
        }
        guard !Task.isCancelled else { return }
        // The newest message can't be centred: when that left the thread at its bottom, following
        // resumes (the store forgetting the focus below cancels this task, so settle first).
        if !userScrolling { settle(nudge: false) }
        actions.focusShown(focus.token)
    }

    /// M29: the focus row's last measurement (FocusRowProbe, in the content's own space) lies in
    /// the visible area now (content and visible edges are global).
    private func focusRowShown(_ row: String) -> Bool {
        guard let probe = edgesBox.focusRow, probe.id == row,
              let content = edgesBox.content, let visible = edgesBox.visible else { return false }
        return FocusScrollRule.isShown(
            rowTop: content.top + probe.top, rowBottom: content.top + probe.bottom,
            visibleTop: visible.top, visibleBottom: visible.bottom
        )
    }

    // MARK: - Edits by chat (L163)

    private func editsChanged(_ edits: [String: CardEdit]) {
        let bumped = glowTracker.update(edits)
        guard !bumped.isEmpty else { return }
        for id in bumped { glowing[id] = Set(edits[id]?.fields ?? []) }
        glowToken += 1
        if let first = bumped.first { scrollTarget = first }
    }
}

/// The scroll view's geometry, anchors and follow-the-bottom behaviour (split out of `list` to
/// keep the type checker fast).
private struct ThreadScrolling<Header: View>: ViewModifier {
    var view: ThreadView<Header>
    var rows: [ThreadRow]

    func body(content: Content) -> some View {
        view.scrolling(content, rows: rows)
    }
}

extension ThreadView where Header == EmptyView {
    init(thread: ThreadState, status: StatusKey?, isActive: Bool, actions: ShellActions, jumpRequest: Int) {
        self.init(thread: thread, status: status, isActive: isActive, actions: actions, jumpRequest: jumpRequest) { EmptyView() }
    }
}

extension ThreadView {
    fileprivate func scrolling(_ content: some View, rows: [ThreadRow]) -> some View {
        content
        .scrollPosition($position)
        .defaultScrollAnchor(hasHeader ? .top : .bottom, for: .initialOffset)
        // M29: pinned and with nothing else moving, the top: new content grows in below the visible
        // bottom and the thread follows it animated (followContent). The bottom moved the offset at
        // once, outside the rows' animation (the rows above jumped up, the new row faded in later).
        .defaultScrollAnchor(sizeChangeAnchor == .bottom ? .bottom : .top, for: .sizeChanges)
        .scrollDismissesKeyboard(.interactively)
        .onScrollPhaseChange { old, phase in
            userScrolling = phase == .tracking || phase == .interacting || phase == .decelerating
            // The user's finger takes over from an animated jump (and from a follow, M29).
            if phase == .tracking || phase == .interacting {
                programmatic = false
                cancelFollow()
            }
            if phase == .idle, old != .idle {
                let afterJump = old == .animating
                if afterJump { programmatic = false }
                settle(nudge: !afterJump)
            }
        }
        .task(id: programmaticToken) {
            // A jump whose animation never reported back (already there, or interrupted).
            guard programmatic else { return }
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled, programmatic else { return }
            programmatic = false
            settle(nudge: false)
        }
        // The top only (loading older pages); the bottom is measured (bottomMeasured).
        .onScrollGeometryChange(for: CGFloat.self) { geo in
            ScrollEdges.fromTop(geo)
        } action: { _, fromTop in
            topChanged(fromTop)
        }
        .overlay(alignment: .bottom) {
            ZStack(alignment: .bottom) {
                // The bottom of the unobscured area (global): an overlay is laid out inside the
                // scroll view's safe area, so its bottom is the top of the composer / tab bar.
                Color.clear
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                    // Its top too (M19: the visible height, for the overscroll check).
                    .onGeometryChange(for: EdgeSpan.self) { EdgeSpan($0.frame(in: .global)) } action: { span in
                        let moved = edgesBox.visible.map { $0.bottom != span.bottom } ?? false
                        edgesBox.visible = span
                        bottomMeasured(visibleMoved: moved)
                    }
                jumpButton
            }
        }
        // M16: no onChange(of: rows.last?.id) jump any more. While the footer row was last, it
        // practically never fired; without it, it would start an animated jump on every new or
        // streaming row. M29: a pinned thread follows new rows from the measured layout instead
        // (layoutSettled → followContent), one animated follow at a time.
        .onChange(of: rows.count) { old, new in rowsCountChanged(from: old, to: new) }
        .onChange(of: thread.context) { _, _ in holdBottomAnchor(appearing: true) }
        .onChange(of: thread.messages.last?.id) { _, _ in markReadIfVisible() }
        // M19: a send's jump waits until the keyboard and the tab bar have settled (it raced them).
        .onChange(of: jumpRequest) { _, _ in requestSendJump(rows: rows.count) }
        .onChange(of: localJumps) { _, _ in requestSendJump(rows: rows.count) }
        .task(id: sendJumps) {
            guard sendJumps > 0 else { return }
            await sendJumpWhenSettled()
        }
        .onChange(of: isActive) { _, active in
            guard active else { return }
            // M29: coming back on screen (the tab bar, the page settling) keeps the bottom anchor
            // for a moment, as the first appearance does.
            holdBottomAnchor(appearing: true)
            markReadIfVisible()
        }
        .onChange(of: scenePhase) { _, phase in if phase == .active { markReadIfVisible() } }
        // M10: the anchor is held only while an older page really loads (M9 also set it when the
        // request was refused before it began, and then nothing ever released it).
        .onChange(of: thread.loadingOlder) { _, loading in if loading && !hasHeader { holdBottom = true } }
        .task(id: thread.loadingOlder) {
            // Release the anchor a moment after the older page has been laid out.
            guard holdBottom else { return }
            try? await Task.sleep(for: .milliseconds(thread.loadingOlder ? 10_000 : 400))
            if !Task.isCancelled { holdBottom = false }
        }
        .onAppear { markReadIfVisible() }
    }

    /// The last assistant message while a run is still going (its markdown may stop mid-marker).
    private var streamingMessageId: String? {
        guard thread.typing || thread.statusBubble != nil || status != nil,
              let last = thread.messages.last, last.role == .assistant else { return nil }
        return last.clientId ?? last.id
    }

    private func spacing(_ gap: ThreadGap) -> CGFloat {
        switch gap {
        case .none: 0
        case .tight: Metrics.bubbleSpacing
        case .group: Metrics.groupSpacing
        case .section: Metrics.sectionSpacing
        }
    }

    private var rowAnimation: Animation {
        reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.42, dampingFraction: 0.86)
    }

    /// New rows rise in and fade; Reduce Motion keeps only the fade.
    private var rowTransition: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(insertion: .opacity.combined(with: .offset(y: 12)), removal: .opacity)
    }

    /// M29 (ContentFollowRule): off screen the bottom anchor is kept too, as before (nobody sees
    /// the offset change there, and nothing animates).
    private var sizeChangeAnchor: ContentFollowRule.Anchor {
        ContentFollowRule.sizeChangeAnchor(hasHeader: hasHeader, holdingBottom: holdBottom, atBottom: atBottom,
                                           settling: anchorSettling || !isActive)
    }

    /// M29: a follow's curve: the rows' spring, Reduce Motion's short ease, or none.
    private func followAnimation(_ curve: ContentFollowRule.Curve) -> Animation? {
        switch curve {
        case .spring: rowAnimation
        case .ease: Animation.easeInOut(duration: ContentFollowRule.easeSeconds)
        case .instant: nil
        }
    }

    // MARK: - Scrolling

    /// One of the two bottom edges moved (scrolling, new content, the composer growing or the
    /// keyboard): re-read how much lies below the visible bottom, once both are known.
    /// `visibleMoved` (M19): the visible bottom moved (keyboard, composer, tab bar), not the content.
    private func bottomMeasured(visibleMoved: Bool) {
        guard let content = edgesBox.content, let visible = edgesBox.visible else { return }
        if visibleMoved {
            edgesBox.insetMoved = true
            edgesBox.visibleMovedAt = .now
            // M29: the bottom anchor again while the visible bottom moves (as before M29).
            holdBottomAnchor()
        }
        // M19: both edges of a layout pass are in by the next run-loop turn: check there, once.
        if !edgesBox.layoutCheckQueued {
            edgesBox.layoutCheckQueued = true
            Task { @MainActor in
                edgesBox.layoutCheckQueued = false
                layoutSettled()
            }
        }
        let fromBottom = JumpButtonRule.fromBottom(contentEnd: content.bottom, visibleBottom: visible.bottom)
        guard fromBottom != edgesBox.fromBottom else { return }
        edgesBox.fromBottom = fromBottom
        bottomChanged(fromBottom)
    }

    /// M19, after a layout pass: the overscroll check, then a visible bottom that moved under a
    /// pinned thread is followed.
    private func layoutSettled() {
        let insetMoved = edgesBox.insetMoved
        edgesBox.insetMoved = false
        checkOverscroll()
        if insetMoved {
            followVisibleBottom()
        } else {
            // M29: the content grew or shrank under a pinned thread: follow it, animated.
            followContentIfNeeded()
        }
    }

    /// M19: past the end (OverscrollRule) is logged when it flips; at rest it heals (scheduleHeal,
    /// settle). JumpButtonRule.fromBottom reads it as 0, "at the bottom", so nothing else notices.
    private func checkOverscroll() {
        guard let content = edgesBox.content, let visible = edgesBox.visible else { return }
        let over = OverscrollRule.isPastEnd(contentTop: content.top, contentEnd: content.bottom, visibleTop: visible.top, visibleBottom: visible.bottom)
        guard over != edgesBox.overscrolled else { return }
        edgesBox.overscrolled = over
        let gap = logPoints(OverscrollRule.gap(contentEnd: content.bottom, visibleBottom: visible.bottom))
        let top = logPoints(content.top), end = logPoints(content.bottom)
        let visibleTop = logPoints(visible.top), visibleBottom = logPoints(visible.bottom)
        let pinned = atBottom, jumping = programmatic, scrolling = userScrolling
        threadLog.notice("thread overscroll=\(over, privacy: .public) gap=\(gap, privacy: .public) content=\(top, privacy: .public)-\(end, privacy: .public) visible=\(visibleTop, privacy: .public)-\(visibleBottom, privacy: .public) atBottom=\(pinned, privacy: .public) programmatic=\(jumping, privacy: .public) userScrolling=\(scrolling, privacy: .public)")
        if over {
            if !userScrolling { scheduleHeal() }
        } else {
            edgesBox.heal?.cancel()
            edgesBox.heal = nil
        }
    }

    /// Past the end with nobody scrolling: the keyboard, the tab bar or a jump's animation get a
    /// moment to bring it back on their own; then the thread jumps to the bottom, unanimated.
    private func scheduleHeal() {
        edgesBox.heal?.cancel()
        edgesBox.heal = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            healOverscroll()
        }
    }

    private func healOverscroll() {
        guard edgesBox.overscrolled, !userScrolling, let content = edgesBox.content, let visible = edgesBox.visible else { return }
        edgesBox.heal?.cancel()
        edgesBox.heal = nil
        let gap = logPoints(OverscrollRule.gap(contentEnd: content.bottom, visibleBottom: visible.bottom))
        let jumping = programmatic
        threadLog.notice("thread overscroll heal gap=\(gap, privacy: .public) programmatic=\(jumping, privacy: .public)")
        programmatic = false
        atBottom = true
        followArmed = true
        // Onto the fixed last row by id: unlike ScrollPosition's edge (which may still read
        // .bottom from the jump that ended here), this always scrolls.
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            if let proxy = edgesBox.proxy {
                proxy.scrollTo(ThreadEnd.id, anchor: .bottom)
            } else {
                position.scrollTo(edge: .bottom)
            }
        }
        markReadIfVisible()
    }

    /// M19: the visible bottom moved under a pinned thread (the keyboard came up or went down, the
    /// composer grew, the tab bar came back). The next measurement used to jump there at once,
    /// ahead of the keyboard, so the messages snapped up instead of moving with it. Now, when the
    /// bottom anchor hasn't kept the last row in place by itself, the thread follows on the
    /// keyboard's curve.
    private func followVisibleBottom() {
        guard atBottom, followArmed, !userScrolling, !programmatic, let fromBottom = edgesBox.fromBottom else { return }
        let curve = ChromeBar.keyboardAnimation(reduceMotion: reduceMotion)
        if edgesBox.overscrolled, let proxy = edgesBox.proxy {
            // The keyboard went down and left the offset past the end: back onto the last row.
            programmatic = true
            programmaticToken += 1
            withAnimation(curve) { proxy.scrollTo(ThreadEnd.id, anchor: .bottom) }
            markReadIfVisible()
        } else if fromBottom >= 1 {
            jumpToBottom(animation: curve)
        }
    }

    // MARK: - M29: following the content

    /// After a layout pass with the visible bottom still: the content grew (a new row, a streaming
    /// reply) or shrank (the typing row went) under a pinned thread (ContentFollowRule.step).
    private func followContentIfNeeded() {
        guard let content = edgesBox.content, let visible = edgesBox.visible else { return }
        let step = ContentFollowRule.step(
            contentTop: content.top, contentEnd: content.bottom, visibleTop: visible.top, visibleBottom: visible.bottom,
            pinned: atBottom, armed: followArmed, userScrolling: userScrolling, jumping: programmatic,
            insetMoving: false, holdingBottom: holdBottom, followHeight: edgesBox.followHeight
        )
        switch step {
        case .none:
            break
        case .merge:
            // Followed once the follow under way is over; its own frames don't count again.
            edgesBox.followMerges += 1
            edgesBox.followHeight = content.bottom - content.top
        case .follow:
            let sinceInsert = edgesBox.rowsGrewAt.map { elapsedSeconds(ContinuousClock.now - $0) }
            followContent(reason: ContentFollowRule.reason(sinceInsert: sinceInsert, below: content.bottom - visible.bottom))
        }
    }

    /// One follow onto the fixed last row, on the rows' curve (Reduce Motion: a short ease; off
    /// screen or more than a screen away: at once). The thread looks again once the curve is over
    /// (followEnded): what grew meanwhile is followed then, not by a new animation on every update.
    /// Not `programmatic`: the user's drag and a send's jump read that flag; a drag cancels this.
    private func followContent(reason: ContentFollowRule.Reason, merged: Int = 0) {
        guard let content = edgesBox.content, let visible = edgesBox.visible else { return }
        let distance = content.bottom - visible.bottom
        let justAppeared = edgesBox.appearedAt.map { elapsedSeconds(ContinuousClock.now - $0) < ContentFollowRule.settleSeconds } ?? true
        let curve = ContentFollowRule.curve(reduceMotion: reduceMotion, onScreen: isActive && scenePhase == .active,
                                            justAppeared: justAppeared, distance: distance, visibleHeight: visible.bottom - visible.top)
        logFollow(reason, distance: distance, curve: curve, merged: merged)
        edgesBox.followHeight = content.bottom - content.top
        edgesBox.followMerges = 0
        atBottom = true
        followArmed = true
        if let animation = followAnimation(curve) {
            withAnimation(animation) { scrollToEnd() }
        } else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { scrollToEnd() }
        }
        markReadIfVisible()
        let wait = ContentFollowRule.seconds(curve)
        edgesBox.follow?.cancel()
        edgesBox.follow = Task { @MainActor in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled else { return }
            followEnded()
        }
    }

    /// A follow's curve is over: still short of the end (what grew meanwhile), follow once more as
    /// a catch-up, so a long fast reply never falls further behind.
    private func followEnded() {
        edgesBox.follow = nil
        edgesBox.followHeight = nil
        let merged = edgesBox.followMerges
        edgesBox.followMerges = 0
        guard let content = edgesBox.content, let visible = edgesBox.visible else { return }
        let step = ContentFollowRule.step(
            contentTop: content.top, contentEnd: content.bottom, visibleTop: visible.top, visibleBottom: visible.bottom,
            pinned: atBottom, armed: followArmed, userScrolling: userScrolling, jumping: programmatic,
            insetMoving: edgesBox.insetMoved, holdingBottom: holdBottom, followHeight: nil
        )
        if step == .follow {
            followContent(reason: .catchUp, merged: merged)
        } else if merged > 0 || edgesBox.followsSinceLog > 0 {
            // The burst is over: the merges and the follows the throttle kept out of the log.
            let merges = edgesBox.mergesSinceLog + merged, follows = edgesBox.followsSinceLog
            edgesBox.mergesSinceLog = 0
            edgesBox.followsSinceLog = 0
            edgesBox.followLoggedAt = .now
            let left = logPoints(content.bottom - visible.bottom)
            threadLog.notice("thread follow done merged=\(merges, privacy: .public) unlogged=\(follows, privacy: .public) fromEnd=\(left, privacy: .public)")
        }
    }

    /// The user took the thread (a drag): no follow, and nothing to catch up.
    private func cancelFollow() {
        edgesBox.follow?.cancel()
        edgesBox.follow = nil
        edgesBox.followHeight = nil
        edgesBox.followMerges = 0
    }

    /// Onto the fixed last row by id (as the heal): it always scrolls, and lands at the content's
    /// end (ThreadEnd carries the padding below it).
    private func scrollToEnd() {
        if let proxy = edgesBox.proxy {
            proxy.scrollTo(ThreadEnd.id, anchor: .bottom)
        } else {
            position.scrollTo(edge: .bottom)
        }
    }

    /// Throttled (ContentFollowRule.logs): `by` is how far the content's end lay below the visible
    /// bottom (negative: above it, a shrink); `merged`, the updates merged into the follows since
    /// the last line; `follows`, the follows since then (1: none left out).
    private func logFollow(_ reason: ContentFollowRule.Reason, distance: CGFloat, curve: ContentFollowRule.Curve, merged: Int) {
        let now = ContinuousClock.now
        edgesBox.followsSinceLog += 1
        edgesBox.mergesSinceLog += merged
        guard ContentFollowRule.logs(reason, sinceLog: edgesBox.followLoggedAt.map { elapsedSeconds(now - $0) }) else { return }
        let follows = edgesBox.followsSinceLog, merges = edgesBox.mergesSinceLog
        edgesBox.followsSinceLog = 0
        edgesBox.mergesSinceLog = 0
        edgesBox.followLoggedAt = now
        let points = logPoints(distance), animated = curve != .instant, anchor = sizeChangeAnchor.rawValue
        threadLog.notice("thread follow reason=\(reason.rawValue, privacy: .public) by=\(points, privacy: .public) curve=\(curve.rawValue, privacy: .public) animated=\(animated, privacy: .public) merged=\(merges, privacy: .public) follows=\(follows, privacy: .public) anchor=\(anchor, privacy: .public)")
    }

    /// A row was added (the user's message, the typing row) or went: a follow right after is an
    /// insert. The line tells which anchor took the size change (top: a follow comes next).
    private func rowsCountChanged(from old: Int, to new: Int) {
        if new > old { edgesBox.rowsGrewAt = .now }
        let fromBottom = logPoints(edgesBox.fromBottom ?? -1)
        let anchor = sizeChangeAnchor.rawValue, pinned = atBottom
        threadLog.notice("thread rows \(old, privacy: .public)->\(new, privacy: .public) anchor=\(anchor, privacy: .public) atBottom=\(pinned, privacy: .public) fromBottom=\(fromBottom, privacy: .public)")
    }

    /// Keeps the bottom anchor for size changes (as before M29) until `settleSeconds` after the
    /// last call: the list appearing or coming back on screen (`appearing`: follows are at once
    /// meanwhile), the visible bottom moving.
    private func holdBottomAnchor(appearing: Bool = false) {
        if appearing { edgesBox.appearedAt = .now }
        if !anchorSettling { anchorSettling = true }
        edgesBox.anchorRelease?.cancel()
        edgesBox.anchorRelease = Task { @MainActor in
            try? await Task.sleep(for: .seconds(ContentFollowRule.settleSeconds))
            guard !Task.isCancelled else { return }
            anchorSettling = false
        }
    }

    private func bottomChanged(_ fromBottom: CGFloat) {
        let bottom = fromBottom < JumpButtonRule.hideWithin
        updateJump(fromBottom)
        // With a header (task detail) nothing follows the bottom until the user went there.
        if bottom && !followArmed && userScrolling { followArmed = true }
        if programmatic {
            // An animated jump is on its way down: wait for it to land.
            if bottom {
                programmatic = false
                markReadIfVisible()
            }
        } else if bottom != atBottom, followArmed {
            if !bottom && !userScrolling && atBottom {
                // Content grew under a pinned thread (a streaming reply): it stays pinned. M29: it
                // is followed animated after the layout pass (layoutSettled → followContent), not
                // with an instant jump here; the visible bottom moving (M19) is followed there too,
                // on the keyboard's curve.
            } else {
                atBottom = bottom
                if bottom { markReadIfVisible() }
            }
        }
    }

    /// Near the top (from ScrollGeometry, where a few points either way don't matter): load the
    /// older page.
    private func topChanged(_ fromTop: CGFloat) {
        let top = fromTop < 400
        if top != nearTop {
            nearTop = top
            if top { loadOlderIfNeeded() }
        }
    }

    private func loadOlderIfNeeded() {
        guard thread.phase == .loaded, thread.hasMoreBefore, !thread.loadingOlder, !thread.messages.isEmpty else { return }
        // The bottom anchor is held from thread.loadingOlder (onChange above), so a request the
        // store refuses can't leave it held. Under a header the older page goes in below it.
        actions.loadOlder()
    }

    /// M10: ↓ from the live geometry (JumpButtonRule): it fades as the thread reaches the bottom,
    /// whether by hand or by a jump, and returns once the user scrolls up.
    private func updateJump(_ fromBottom: CGFloat) {
        let following = followArmed && atBottom
        let next = JumpButtonRule.visible(fromBottom: fromBottom, wasVisible: showsJump, following: following, userScrolling: userScrolling)
        if next != showsJump { showsJump = next }
    }

    /// Scrolling stopped (M8): re-read the bottom with the latest geometry and a looser
    /// tolerance, so a hand scroll that ends just short of the bottom (or a reply that kept
    /// streaming meanwhile) counts as being there: ↓ goes and the thread follows again.
    /// `nudge`: after the user's own scroll, the last few points are closed with a short
    /// animated jump; after a jump (or its timeout) never again, so it can't loop.
    private func settle(nudge: Bool) {
        // M19: at rest past the end (blank): back to the bottom at once.
        if edgesBox.overscrolled, !userScrolling {
            healOverscroll()
            return
        }
        guard !programmatic, !userScrolling, let fromBottom = edgesBox.fromBottom else { return }
        if JumpButtonRule.atBottomAtRest(fromBottom: fromBottom) {
            if nudge, fromBottom >= 1 {
                jumpToBottom(animated: true)
            } else {
                followArmed = true
                if !atBottom { atBottom = true }
                if showsJump { showsJump = false }
                markReadIfVisible()
            }
        } else if atBottom, followArmed {
            // Pinned, but the reply outgrew the jump's animation: catch up. M29: animated, and
            // merged into a follow already under way.
            if edgesBox.follow != nil {
                edgesBox.followMerges += 1
            } else {
                followContent(reason: .catchUp)
            }
        } else {
            updateJump(fromBottom)
        }
    }

    private func jumpToBottom(animated: Bool) {
        jumpToBottom(animation: animated ? (reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.4, dampingFraction: 0.9)) : nil)
    }

    /// `animation`: nil jumps at once.
    private func jumpToBottom(animation: Animation?) {
        atBottom = true
        followArmed = true
        if let animation {
            programmatic = true
            programmaticToken += 1
            withAnimation(animation) {
                position.scrollTo(edge: .bottom)
            }
        } else {
            position.scrollTo(edge: .bottom)
        }
        markReadIfVisible()
    }

    // MARK: - M19: a send's jump

    /// The composer's send (or a card's tap that sends) asked for the bottom. The send also drops
    /// the keyboard, springs the tab bar back and animates the new row in, all in the same update;
    /// an animated jump started then resolved its target while all three still moved, and could
    /// end past the content's end (the blank thread). It runs once they have settled instead.
    private func requestSendJump(rows: Int) {
        let fromBottom = logPoints(edgesBox.fromBottom ?? -1)
        let pinned = atBottom, over = edgesBox.overscrolled
        threadLog.notice("thread send jump requested fromBottom=\(fromBottom, privacy: .public) rows=\(rows, privacy: .public) atBottom=\(pinned, privacy: .public) overscroll=\(over, privacy: .public)")
        // Following resumes now (a pinned thread stays pinned while things move); the jump waits.
        followArmed = true
        sendJumps += 1
    }

    private func sendJumpWhenSettled() async {
        // The keyboard and the tab bar's spring take about a third of a second; then wait for the
        // visible bottom to have held still for a moment (a few rounds at most).
        try? await Task.sleep(for: .milliseconds(350))
        var rounds = 0
        while !Task.isCancelled, rounds < 4, let moved = edgesBox.visibleMovedAt, ContinuousClock.now - moved < .milliseconds(200) {
            rounds += 1
            try? await Task.sleep(for: .milliseconds(120))
        }
        guard !Task.isCancelled else { return }
        let fromBottom = edgesBox.fromBottom ?? 0
        let over = edgesBox.overscrolled, scrolling = userScrolling, points = logPoints(fromBottom)
        threadLog.notice("thread send jump fromBottom=\(points, privacy: .public) overscroll=\(over, privacy: .public) userScrolling=\(scrolling, privacy: .public) waitRounds=\(rounds, privacy: .public)")
        // The user took the thread meanwhile: theirs.
        guard !scrolling else { return }
        if over {
            healOverscroll()
        } else if fromBottom >= 1 {
            jumpToBottom(animated: true)
        } else {
            // Already there (the bottom anchor kept the new row in view): nothing to scroll.
            atBottom = true
            markReadIfVisible()
        }
    }

    /// M21: the thread is read whenever it is on screen with the app in front, wherever it is
    /// scrolled (before, only at the bottom: a thread left scrolled up kept its badge).
    private func markReadIfVisible() {
        guard isActive, scenePhase == .active, thread.phase == .loaded, !thread.messages.isEmpty else { return }
        actions.markRead()
    }

    /// The ↓ circle while scrolled up (M10: `showsJump`, from the scroll position; the tap only
    /// starts the jump, and the circle fades as the thread gets there).
    private var jumpButton: some View {
        ZStack {
            if showsJump {
                Button { jumpToBottom(animated: true) } label: {
                    DuetIcon(glyph: .scrollDown, size: 20, tint: Palette.primaryText)
                        .floatingCircle(36)
                }
                .buttonStyle(PressableButtonStyle(scale: 0.9))
                .padding(.bottom, 10)
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.8)))
                .accessibilityLabel(Text("Scroll to the newest message"))
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.3, dampingFraction: 0.85), value: showsJump)
    }

    // MARK: - Links

    private func route(_ url: URL) -> OpenURLAction.Result {
        if let link = SafariLink(url) {
            safari = link
            return .handled
        }
        if url.scheme?.lowercased() == "duet" {
            actions.openRoute(url)
            return .handled
        }
        return .systemAction
    }
}

/// M19: the fixed invisible last row (its id is the heal's and the follows' scroll target): the
/// 22 pt above the composer M16 approved. M29: all 22 pt in the row (it was 14 + the stack's 8 pt
/// padding below it), so a scroll onto it lands at the content's end; `padding` is the top's only.
private enum ThreadEnd {
    static let id = "thread-end"
    static let height: CGFloat = 22
    static let padding: CGFloat = 8
}

/// A view's vertical extent in global coordinates (only what the thread's edges need, so a
/// sideways move, e.g. the side menu sliding the shell, doesn't report a change).
private struct EdgeSpan: Equatable, Sendable {
    var top: CGFloat
    var bottom: CGFloat

    init(_ frame: CGRect) {
        top = frame.minY
        bottom = frame.maxY
    }
}

/// The latest scroll measurements, without invalidating the view (they change every frame):
/// the content's edges and the unobscured area's edges (both global), and how much content lies
/// below the visible bottom (JumpButtonRule.fromBottom), nil until both are known. M19: whether
/// the thread is past its end, the pending heal, the visible bottom's last move, and the reader's
/// proxy (set on appear, used only from actions).
private final class EdgesBox {
    var content: EdgeSpan?
    var visible: EdgeSpan?
    var fromBottom: CGFloat?
    var overscrolled = false
    var heal: Task<Void, Never>?
    /// The visible bottom moved in the layout pass being measured (layoutSettled reads it).
    var insetMoved = false
    var visibleMovedAt: ContinuousClock.Instant?
    var layoutCheckQueued = false
    var proxy: ScrollViewProxy?
    /// M29: the deep link's row, measured in the content's own space (FocusRowProbe)
    var focusRow: FocusRowSpan?
    /// M29 (followContent): the follow under way (it ends when its curve is over), the content's
    /// height it was for, the updates merged into it, the last row added, the bottom anchor's
    /// release, and the log's throttle.
    var follow: Task<Void, Never>?
    var followHeight: CGFloat?
    var followMerges = 0
    var rowsGrewAt: ContinuousClock.Instant?
    var anchorRelease: Task<Void, Never>?
    var appearedAt: ContinuousClock.Instant?
    var followLoggedAt: ContinuousClock.Instant?
    var followsSinceLog = 0
    var mergesSinceLog = 0
}

/// M29: where the deep link's row lies inside the thread's content (FocusRowProbe.space): it only
/// changes when rows above it change, not on scrolling, so a measurement taken before the row was
/// scrolled to stays right; with the content's global top it says whether the row is in view.
private struct FocusRowSpan: Equatable {
    var id: String
    var top: CGFloat
    var bottom: CGFloat
}

/// M29: measures the focused row only (the others get no geometry reader).
private struct FocusRowProbe: ViewModifier {
    nonisolated static let space = "thread-content"

    var rowId: String
    var focused: Bool
    var box: EdgesBox

    func body(content: Content) -> some View {
        content.background {
            if focused {
                Color.clear
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                    .onGeometryChange(for: EdgeSpan.self) { EdgeSpan($0.frame(in: .named(Self.space))) } action: { span in
                        box.focusRow = FocusRowSpan(id: rowId, top: span.top, bottom: span.bottom)
                    }
            }
        }
    }
}

/// Whole points for the log (-1 when not finite).
private func logPoints(_ value: CGFloat) -> Int {
    value.isFinite ? Int(value.rounded()) : -1
}

/// A clock duration in seconds (M29: ContentFollowRule's windows).
private func elapsedSeconds(_ duration: Duration) -> Double {
    let parts = duration.components
    return Double(parts.seconds) + Double(parts.attoseconds) / 1e18
}

/// The distance from the scroll view's visible top to the content's top, from ScrollGeometry
/// (only for loading older pages; in steps of 50 so it changes rarely).
private enum ScrollEdges {
    static func fromTop(_ geo: ScrollGeometry) -> CGFloat {
        ((geo.contentOffset.y + geo.contentInsets.top) / 50).rounded() * 50
    }
}
