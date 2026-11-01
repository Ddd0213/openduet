// One thread's state machine (the main thread, M2, or a task's own session, M3), fed by the
// SSE streams (GET /api/events and the POST answers) and by message pages: dedups events by
// id, upserts messages by id (never moving a newer version back), reconciles optimistic
// PendingMessages by clientId, tracks the live status / typing per run, hands out the offline
// queue one message at a time in order, and keeps approval cards current (approval events,
// decisions) with the "edits by chat" glow (L163). Foundation + model types only, so it runs
// in the Mac host tests.
import Foundation

struct ThreadReducer: Sendable {
    /// Which messages and runs belong to this thread.
    enum Scope: Hashable, Sendable {
        /// a channel's own timeline: taskId == nil
        case channel
        /// one task's session: taskId == this id (any channel)
        case task(String)
    }

    private(set) var scope: Scope
    /// The channel this thread lives in ("" for a task session, which is addressed by task id).
    private(set) var channelId: String
    var thread = ThreadState()
    /// Header pill + mascot (task detail: the pill under the centre capsule); nil = idle.
    private(set) var status: StatusKey?
    private(set) var usage: UsageState?
    private(set) var channels: [String: Channel] = [:]

    private var seen = Set<Int64>()
    private var seenOrder: [Int64] = []
    private let seenLimit: Int
    /// Runs in start order with their current status (nil = started or idle).
    private var runs: [(id: String, status: StatusKey?)] = []
    private var typingRuns = Set<String>()
    /// M10: runs the user asked to stop. Their typing and status stay hidden until their `done`
    /// (or until the stop fails and `resumeStop` shows them again); newer runs show as usual.
    private var stoppingRuns = Set<String>()
    /// M21: each run's kind (RunRef.kind) as its events said; a run whose events had none (stored
    /// before M21) isn't in here and is ended by a `done` of any kind, as before.
    private var runKinds: [String: RunKind] = [:]
    /// M21: runs whose `done` arrived (newest last, a few kept): a page read before that `done`
    /// can't bring a finished turn's dots back through its activeRun.
    private var endedRuns: [String] = []
    private static let endedLimit = 32
    /// The newest approval version seen per card message id (edits glow only when it grows).
    private var approvalVersions: [String: Int] = [:]

    /// The status keys that also show as the small grey status bubble in the thread (L101).
    static let bubbleKeys: Set<StatusKey> = [.checking, .readingNow]

    init(channelId: String, seenLimit: Int = 2000) {
        self.scope = .channel
        self.channelId = channelId
        self.seenLimit = seenLimit
    }

    /// A task's own session ("Reply to OpenDuet"); its thread context is .task.
    init(taskId: String, seenLimit: Int = 2000) {
        self.scope = .task(taskId)
        self.channelId = ""
        self.seenLimit = seenLimit
        self.thread = ThreadState(context: .task)
    }

    var taskId: String? {
        if case .task(let id) = scope { id } else { nil }
    }

    /// Red badge on the menu button: other open channels with unread messages.
    var unreadChannels: Int {
        channels.values.filter { !$0.isMain && !$0.archived && $0.unreadCount > 0 }.count
    }

    // MARK: - Events

    /// Applies one event; returns false when it was a duplicate (already applied by id).
    @discardableResult
    mutating func apply(_ event: DuetEvent) -> Bool {
        guard markSeen(event.id) else { return false }
        switch event.body {
        case .status(let run, let key):
            guard concernsThread(run, event.channelId) else { break }
            noteKind(run)
            setStatus(key, run: run.runId)
        case .typing(let run, let typing):
            guard concernsThread(run, event.channelId) else { break }
            noteKind(run)
            if typing { typingRuns.insert(run.runId) } else { typingRuns.remove(run.runId) }
            refreshTyping()
        case .done(let run, _, _):
            guard concernsThread(run, event.channelId) else { break }
            endRun(run.runId, kind: run.kind ?? runKinds[run.runId])
        case .message(let message):
            guard owns(message) else { break }
            // M15: a voice call's hand-off and the assistant's replies (callId set) show like any message.
            upsert(message)
            if let clientId = message.clientId { thread.pending.removeAll { $0.clientId == clientId } }
        case .messageDeleted(let messageId):
            thread.messages.removeAll { $0.id == messageId }
        case .channel(let channel):
            channels[channel.id] = channel
        case .usage(let usage):
            self.usage = usage
        case .approval(let approval):
            applyApproval(approval)
        case .artifact(let update):
            applyArtifact(update.artifact)
        case .task, .computer, .notification, .unsupported:
            break
        case .resync:
            // M21: the events in between won't come (their `done`s neither): the runs start over
            // and the stores reload what they show (ChatStore.resync); the page's activeRun
            // brings back a turn still running. Ids before it may be reused (a restored server).
            resetRuns()
            seen = [event.id]
            seenOrder = [event.id]
        case .taskDeleted, .channelDeleted:
            // M9: the stores drop the task / channel (and its open thread); see ChatStore.
            break
        case .call:
            // A cue for the open voice call (CallSession), not thread state.
            break
        }
        return true
    }

    // MARK: - M6: artifact cards and reactions

    /// An `artifact` event (L153): the artifact cards that show it take the newer summary (status,
    /// title, pin), keeping their metrics until the server upserts the card itself.
    @discardableResult
    mutating func applyArtifact(_ artifact: ArtifactSummary) -> Bool {
        var changed = false
        for index in thread.messages.indices {
            guard case .artifact(var payload) = thread.messages[index].content, payload.artifact.id == artifact.id,
                  artifact.updatedAt >= payload.artifact.updatedAt, payload.artifact != artifact else { continue }
            payload.artifact = artifact
            thread.messages[index].content = .artifact(payload)
            changed = true
        }
        return changed
    }

    /// Long-press 👍 ❤️ ⭐ (L157): the reactions shown at once (optimistic); returns the ones
    /// before, for a rollback, or nil when the message isn't in this thread.
    mutating func setReactions(_ reactions: [Reaction], messageId: String) -> [Reaction]? {
        guard let index = thread.messages.firstIndex(where: { $0.id == messageId }) else { return nil }
        let before = thread.messages[index].reactions
        thread.messages[index].reactions = reactions
        return before
    }

    private mutating func markSeen(_ id: Int64) -> Bool {
        guard seen.insert(id).inserted else { return false }
        seenOrder.append(id)
        if seenOrder.count > seenLimit {
            let drop = seenOrder.count - seenLimit
            seenOrder.prefix(drop).forEach { seen.remove($0) }
            seenOrder.removeFirst(drop)
        }
        return true
    }

    /// Whether a message belongs to this thread (main: this channel, outside any task; task
    /// session: this task's messages).
    func owns(_ message: Message) -> Bool {
        switch scope {
        case .channel: message.channelId == channelId && message.taskId == nil
        case .task(let id): message.taskId == id
        }
    }

    /// Run events of this thread itself (main: not a task's session, not another channel;
    /// task session: runs of this task).
    private func concernsThread(_ run: DuetEvent.RunRef, _ eventChannel: String?) -> Bool {
        switch scope {
        case .channel: run.taskId == nil && (eventChannel == nil || eventChannel == channelId)
        case .task(let id): run.taskId == id
        }
    }

    private mutating func setStatus(_ key: StatusKey?, run: String) {
        if let index = runs.firstIndex(where: { $0.id == run }) {
            runs[index].status = key
        } else {
            runs.append((run, key))
        }
        refreshStatus()
    }

    /// `done` ends its run and any older one still marked busy (a run whose `done` was lost);
    /// a `done` for a run never seen clears everything. M21: only runs of the same kind, so a
    /// Make build's `done` (its own queue, the same channel) leaves the chat's dots and Stop
    /// alone. A run with no known kind (events from before M21) goes with any `done`, and a
    /// `done` without a kind ends as before.
    private mutating func endRun(_ run: String, kind: RunKind?) {
        func sameKind(_ id: String) -> Bool {
            guard let kind, let other = runKinds[id] else { return true }
            return other == kind
        }
        var ended: Set<String> = [run]
        if let index = runs.firstIndex(where: { $0.id == run }) {
            ended.formUnion(runs[...index].map(\.id).filter(sameKind))
        } else {
            ended.formUnion(runs.map(\.id).filter(sameKind))
            ended.formUnion(typingRuns.filter(sameKind))
            ended.formUnion(stoppingRuns.filter(sameKind))
        }
        runs.removeAll { ended.contains($0.id) }
        typingRuns.subtract(ended)
        stoppingRuns.subtract(ended)
        for id in ended { runKinds[id] = nil }
        endedRuns.removeAll { $0 == run }
        endedRuns.append(run)
        if endedRuns.count > Self.endedLimit { endedRuns.removeFirst(endedRuns.count - Self.endedLimit) }
        refreshTyping()
        refreshStatus()
    }

    private mutating func noteKind(_ run: DuetEvent.RunRef) {
        if let kind = run.kind { runKinds[run.runId] = kind }
    }

    /// M21 resync: no run is known to be live any more.
    private mutating func resetRuns() {
        runs.removeAll()
        typingRuns.removeAll()
        stoppingRuns.removeAll()
        runKinds.removeAll()
        refreshTyping()
        refreshStatus()
    }

    /// M21: a message page's activeRun (cold start, a reload, a resync): the turn running in this
    /// channel's own thread shows its typing dots and Stop again, until its `done`. A run already
    /// known from live events keeps what they said; one whose `done` already came stays ended.
    /// Returns whether anything changed.
    @discardableResult
    mutating func restoreActiveRun(_ active: ActiveRun?) -> Bool {
        guard scope == .channel, let active, !endedRuns.contains(active.runId),
              !runs.contains(where: { $0.id == active.runId }), !typingRuns.contains(active.runId) else { return false }
        runKinds[active.runId] = active.kind
        runs.append((active.runId, nil))
        typingRuns.insert(active.runId)
        refreshTyping()
        refreshStatus()
        return true
    }

    private mutating func refreshTyping() {
        thread.typing = !typingRuns.subtracting(stoppingRuns).isEmpty
    }

    private mutating func refreshStatus() {
        status = runs.last(where: { $0.status != nil && !stoppingRuns.contains($0.id) })?.status
        thread.statusBubble = status.flatMap { Self.bubbleKeys.contains($0) ? $0 : nil }
    }

    // MARK: - M10: stop responding

    /// The assistant is replying in this thread (typing, or a run with a live status) and the user
    /// hasn't asked it to stop: the composer's empty waveform turns into ■.
    var isReplying: Bool { thread.typing || status != nil }

    /// ■ was tapped: the runs live right now hide their typing and status at once (optimistic).
    /// Returns them, for `resumeStop` when the stop fails; empty when nothing was live.
    @discardableResult
    mutating func beginStop() -> Set<String> {
        let live = typingRuns.union(runs.filter { $0.status != nil }.map(\.id)).subtracting(stoppingRuns)
        guard !live.isEmpty else { return [] }
        stoppingRuns.formUnion(live)
        refreshTyping()
        refreshStatus()
        return live
    }

    /// The stop failed (not a 409): those runs show their typing and status again, if still live.
    mutating func resumeStop(_ runIds: Set<String>) {
        guard !runIds.isDisjoint(with: stoppingRuns) else { return }
        stoppingRuns.subtract(runIds)
        refreshTyping()
        refreshStatus()
    }

    /// What a stop's failure shows by the composer: nil for a 409 (nothing was running any more,
    /// silent) and for a cancelled request; otherwise the error's one-line reason.
    static func stopFailure(for error: any Error) -> String? {
        if error is CancellationError { return nil }
        guard let api = error as? APIError else { return String(localized: "Something went wrong.") }
        if case .server(status: 409, _) = api { return nil }
        if api == .staleVersion { return nil }
        return api.localizedReason
    }

    // MARK: - Messages

    /// Inserts or replaces by id, keeping createdAt order; an older version never wins.
    mutating func upsert(_ message: Message) {
        if let index = thread.messages.firstIndex(where: { $0.id == message.id }) {
            guard Self.supersedes(message, thread.messages[index]) else { return }
            thread.messages[index] = message
        } else {
            var index = thread.messages.endIndex
            while index > thread.messages.startIndex && thread.messages[index - 1].createdAt > message.createdAt {
                index -= 1
            }
            thread.messages.insert(message, at: index)
        }
        noteApproval(in: message)
    }

    /// A card action's answer (POST /api/messages/:id/action), upserted when it belongs here.
    @discardableResult
    mutating func accept(_ message: Message) -> Bool {
        guard owns(message) else { return false }
        upsert(message)
        return true
    }

    /// Whether `new` may replace `old` (same id): never an older version. Approval cards order by
    /// the approval's version and updatedAt first, so a decision written in locally
    /// (applyApproval) isn't undone by a copy of the message from before it.
    static func supersedes(_ new: Message, _ old: Message) -> Bool {
        if case .approval(let a) = new.content, case .approval(let b) = old.content {
            if a.version != b.version { return a.version > b.version }
            if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt }
        }
        // M9: a form card submitted / skipped here (optimistically) isn't reopened by a copy
        // from before that, which carries the same updatedAt.
        if case .form(let a) = new.content, case .form(let b) = old.content,
           a.state == .open, b.state != .open, new.updatedAt == old.updatedAt {
            return false
        }
        return new.updatedAt >= old.updatedAt
    }

    // MARK: - M9: form cards

    /// Submit / Skip on a form card, shown at once: the card takes `state` (and the answers).
    /// Returns the card as it was, for a rollback; nil when no open form card here has that id.
    mutating func setFormState(_ messageId: String, _ state: FormPayload.State, answers: [FormAnswer]?) -> FormSnapshot? {
        guard let index = thread.messages.firstIndex(where: { $0.id == messageId }),
              case .form(var payload) = thread.messages[index].content, payload.state == .open else { return nil }
        let before = FormSnapshot(payload: payload, updatedAt: thread.messages[index].updatedAt)
        payload.state = state
        payload.answers = answers
        thread.messages[index].content = .form(payload)
        return before
    }

    /// The submit / skip didn't go through: the card opens again as it was, unless the server's
    /// own newer copy has landed meanwhile. False when nothing was put back.
    @discardableResult
    mutating func restoreForm(_ messageId: String, _ snapshot: FormSnapshot) -> Bool {
        guard let index = thread.messages.firstIndex(where: { $0.id == messageId }),
              case .form = thread.messages[index].content,
              thread.messages[index].updatedAt <= snapshot.updatedAt else { return false }
        thread.messages[index].content = .form(snapshot.payload)
        return true
    }

    /// A pending bubble that won't be sent (a refused form submit): it goes without a trace.
    mutating func removePending(_ clientId: String) {
        thread.pending.removeAll { $0.clientId == clientId }
    }

    /// M9 channel_deleted: the channel's name and read state are forgotten.
    mutating func forgetChannel(_ channelId: String) {
        channels[channelId] = nil
    }

    /// The newest page (first load or reload). Messages that arrived live after the page
    /// was read stay; per id the newer version wins; pending echoes are reconciled.
    mutating func applyFirstPage(_ page: MessagePage) {
        let messages = page.messages
        let newestInPage = messages.last?.createdAt
        let live = thread.messages.filter { message in
            guard let newestInPage else { return true }
            return message.createdAt > newestInPage || messages.contains { $0.id == message.id }
        }
        thread.messages = messages
        live.forEach { upsert($0) }
        thread.messages.forEach { noteApproval(in: $0) }
        reconcilePending()
        thread.hasMoreBefore = page.hasMore
        thread.phase = .loaded
        restoreActiveRun(page.activeRun)
    }

    /// The newest page fetched again to refresh a card (409 stale version / 410 expired): merged
    /// by id without dropping older pages already on screen. Before the first load it is one.
    mutating func mergePage(_ page: MessagePage) {
        guard thread.phase == .loaded else { return applyFirstPage(page) }
        page.messages.forEach { upsert($0) }
        reconcilePending()
        restoreActiveRun(page.activeRun)
    }

    /// M16: the newest page fetched again for a thread already on screen (a cached thread the
    /// chat switched back to). The page is the truth for the span it covers (newer versions win
    /// per id, messages strictly inside it but missing from it were deleted meanwhile); older
    /// pages already loaded stay, so the thread doesn't shrink or jump. A message whose createdAt
    /// ties the page's oldest or newest but isn't in it stays: it may sit just outside the page
    /// (loadOlder asks for what is before the oldest id, so it would never come back). A page
    /// that doesn't reach back to what is shown (more new messages than one page while away)
    /// replaces the thread like a first load, so no hole is left in the middle. Before the first
    /// load it is one.
    ///
    /// A copy kept here wins over the page's on an equal updatedAt (as in applyFirstPage). Since
    /// ParkedThreads.update reaches cached threads too, every rollback of an optimistic change
    /// lands wherever the thread is; such a tie is then only a change whose request is still in
    /// flight (its answer, or its rollback, settles it), not a stale one.
    ///
    /// M19: returns whether the thread changed. The merge runs on a copy and `thread` is written
    /// only when the result differs, so an unchanged page (the usual switch back to a cached
    /// thread) doesn't re-render the whole thread mid-animation; the caller can skip its own write.
    @discardableResult
    mutating func applyRefreshedPage(_ page: MessagePage) -> Bool {
        let before = thread
        guard thread.phase == .loaded, page.hasMore, let oldestInPage = page.messages.first?.createdAt else {
            applyFirstPage(page)
            return thread != before
        }
        let pageIds = Set(page.messages.map(\.id))
        guard thread.messages.contains(where: { pageIds.contains($0.id) }) else {
            applyFirstPage(page)
            return thread != before
        }
        let newestInPage = page.messages.last?.createdAt ?? oldestInPage
        let older = thread.messages.filter { $0.createdAt <= oldestInPage && !pageIds.contains($0.id) }
        let olderIds = Set(older.map(\.id))
        // Copies of the page's messages (a local decision may be newer), and ones at or after its
        // newest that it doesn't have (live, or tied at its edge).
        let kept = thread.messages.filter {
            !olderIds.contains($0.id) && (pageIds.contains($0.id) || $0.createdAt >= newestInPage)
        }
        var merged = self
        merged.thread.messages = older + page.messages
        kept.forEach { merged.upsert($0) }
        page.messages.forEach { merged.noteApproval(in: $0) }
        merged.reconcilePending()
        // The approval versions noted along the way are kept either way (they only ever grow).
        approvalVersions = merged.approvalVersions
        var changed = false
        if merged.thread != before {
            thread = merged.thread
            changed = true
        }
        // M21: the turn running there now (its dots and Stop after a cold start or a resync).
        if restoreActiveRun(page.activeRun) { changed = true }
        return changed
    }

    /// An older page (?before=<oldest id>), prepended without duplicates.
    mutating func applyOlderPage(_ page: MessagePage) {
        let known = Set(thread.messages.map(\.id))
        let older = page.messages.filter { !known.contains($0.id) }
        thread.messages.insert(contentsOf: older, at: 0)
        older.forEach { noteApproval(in: $0) }
        thread.hasMoreBefore = page.hasMore
        thread.loadingOlder = false
    }

    private mutating func reconcilePending() {
        let echoed = Set(thread.messages.compactMap(\.clientId))
        thread.pending.removeAll { echoed.contains($0.clientId) }
    }

    func contains(messageId: String) -> Bool {
        thread.messages.contains { $0.id == messageId }
    }

    // MARK: - Approval cards

    /// Writes an approval (an `approval` event, or the answer of Approve / Not now) into the card
    /// that shows it, found by approval id: approval cards take it whole unless they already show
    /// a newer version; spend request cards take its status. False when no card here shows it.
    @discardableResult
    mutating func applyApproval(_ approval: Approval) -> Bool {
        guard let index = thread.messages.firstIndex(where: { Self.approvalId(of: $0) == approval.id }) else { return false }
        var message = thread.messages[index]
        switch message.content {
        case .approval(let current):
            guard (approval.version, approval.updatedAt) >= (current.version, current.updatedAt) else { return true }
            message.content = .approval(approval)
        case .spendRequest(var spend):
            // A decided spend request never goes back to pending.
            guard spend.status == .pending || approval.status != .pending else { return true }
            spend.status = approval.status
            message.content = .spendRequest(spend)
        default:
            return false
        }
        thread.messages[index] = message
        noteApproval(in: message)
        return true
    }

    /// 410 expired: the server marked the approval expired; show it until the refreshed copy lands.
    @discardableResult
    mutating func markExpired(approvalId: String) -> Bool {
        guard let index = thread.messages.firstIndex(where: { Self.approvalId(of: $0) == approvalId }) else { return false }
        switch thread.messages[index].content {
        case .approval(var approval) where approval.status == .pending:
            approval.status = .expired
            thread.messages[index].content = .approval(approval)
        case .spendRequest(var spend) where spend.status == .pending:
            spend.status = .expired
            thread.messages[index].content = .spendRequest(spend)
        default:
            break
        }
        return true
    }

    static func approvalId(of message: Message) -> String? {
        switch message.content {
        case .approval(let approval): approval.id
        case .spendRequest(let spend): spend.approvalId
        default: nil
        }
    }

    /// Edits by chat (L163): a card whose approval version grew past the one already seen, with
    /// changedFields, glows them. The first sight of a card (first load, a new card) never glows.
    private mutating func noteApproval(in message: Message) {
        guard case .approval(let approval) = message.content else { return }
        let previous = approvalVersions[message.id]
        guard previous.map({ approval.version > $0 }) ?? true else { return }
        approvalVersions[message.id] = approval.version
        if previous != nil, !approval.changedFields.isEmpty {
            thread.edits[message.id] = CardEdit(version: approval.version, fields: approval.changedFields)
        }
    }

    // MARK: - Channels

    mutating func setChannels(_ list: [Channel]) {
        channels = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        thread.lastReadAt = channels[channelId]?.lastReadAt
    }

    /// One channel from outside the list (a create / archive answer): kept for names and lastReadAt.
    mutating func noteChannel(_ channel: Channel) {
        channels[channel.id] = channel
    }

    /// This thread takes over the chat from `other` (side menu switch, M4): the channel list and
    /// the latest usage carry over; the "New" divider follows this channel's lastReadAt.
    mutating func adoptShared(from other: ThreadReducer) {
        channels = other.channels
        if let usage = other.usage { self.usage = usage }
        thread.lastReadAt = channels[channelId]?.lastReadAt
    }

    /// Messages typed here that the server hasn't echoed yet (waiting, sending or failed).
    var hasPending: Bool { !thread.pending.isEmpty }

    /// The main channel turned out to be another id than first assumed: start that thread over.
    mutating func retarget(to id: String) {
        guard scope == .channel, id != channelId else { return }
        channelId = id
        thread.messages = []
        thread.hasMoreBefore = false
        thread.phase = .loading
    }

    // MARK: - Offline queue

    mutating func enqueue(_ pending: PendingMessage) {
        thread.pending.append(pending)
    }

    /// The next waiting message, marked sending; nil while one is still being sent so the
    /// queue goes out strictly in order.
    mutating func nextToSend() -> PendingMessage? {
        guard !thread.pending.contains(where: { $0.state == .sending }),
              let index = thread.pending.firstIndex(where: { $0.state == .waiting }) else { return nil }
        thread.pending[index].state = .sending
        return thread.pending[index]
    }

    /// Back to waiting (offline) or failed (rejected, can be retried).
    mutating func setPending(_ clientId: String, _ state: PendingMessage.State) {
        guard let index = thread.pending.firstIndex(where: { $0.clientId == clientId }) else { return }
        thread.pending[index].state = state
    }

    /// Retry of a failed message: sent again as the newest one, so it waits after anything already
    /// queued and its bubble moves to the bottom (its old time would keep it up in the thread).
    mutating func retry(_ clientId: String, at now: Date = .now) {
        guard let index = thread.pending.firstIndex(where: { $0.clientId == clientId }),
              thread.pending[index].state == .failed else { return }
        var item = thread.pending.remove(at: index)
        item.state = .waiting
        item.createdAt = now
        thread.pending.append(item)
    }

    func isPending(_ clientId: String) -> Bool {
        thread.pending.contains { $0.clientId == clientId }
    }

    func pendingState(_ clientId: String) -> PendingMessage.State? {
        thread.pending.first { $0.clientId == clientId }?.state
    }
}
