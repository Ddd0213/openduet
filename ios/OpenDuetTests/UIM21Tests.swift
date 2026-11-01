// M21 W4 UI rules (plan §4 M21 W4, review #16 C10 C19, prompt L152): the Make viewer's edit /
// refresh status from `artifact` events (MakeState.work), quick replies of an earlier turn no
// longer taking taps, the tab bar's icon-only rule with a 4th tab, and the task reply's
// attachments in its composer.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M21 Make work status")
struct UIM21MakeWorkTests {
    private static let base = Date(timeIntervalSince1970: 1_793_000_000)

    private func item(_ id: String, at seconds: Double, status: ArtifactSummary.Status = .ready) -> ArtifactSummary {
        let at = Self.base.addingTimeInterval(seconds)
        return ArtifactSummary(id: id, channelId: "c1", type: .webPage, title: "T \(id)", status: status, sourceCount: 0,
                               refreshSchedule: nil, pinnedToTabBar: false, createdAt: Self.base, updatedAt: at)
    }

    private func update(_ artifact: ArtifactSummary, edit: ArtifactWorkStatus? = nil,
                        refresh: ArtifactWorkStatus? = nil) -> DuetEvent.ArtifactUpdate {
        DuetEvent.ArtifactUpdate(artifact: artifact, buildStatus: nil, editStatus: edit, refreshStatus: refresh)
    }

    private static let working = ArtifactWorkStatus(state: .working, reason: nil)
    private static let failed = ArtifactWorkStatus(state: .failed, reason: Phrase(key: nil, params: nil, text: "No access"))

    /// A viewer open on `a`, its HTML of version 0 on screen.
    private func viewing() -> MakeState {
        var state = MakeState()
        state.applyList([item("a", at: 0)])
        var viewer = ArtifactViewerState(artifactId: "a")
        viewer.phase = .ready(html: "<p>v0</p>")
        viewer.loadedVersion = Self.base
        state.viewer = viewer
        return state
    }

    @Test("An edit in progress, then its failure: the page stays as it was, ✎'s wait ends on failure")
    func editWorkingThenFailed() {
        var state = viewing()
        state.editing.insert("a")
        #expect(state.apply(update(item("a", at: 1), edit: Self.working)).isEmpty, "no reload while OpenDuet edits")
        #expect(state.work["a"]?.isEditing == true)
        #expect(state.editing.contains("a"), "the answer to ✎ (no new version yet) keeps the wait")

        #expect(state.apply(update(item("a", at: 2), edit: Self.failed)).isEmpty)
        #expect(state.work["a"]?.editFailed == true)
        #expect(state.work["a"]?.edit?.reason?.text == "No access")
        #expect(!state.editing.contains("a"))
    }

    @Test("A newer version without a status clears the work and reloads the viewer")
    func editDoneReloads() {
        var state = viewing()
        state.apply(update(item("a", at: 1), edit: Self.working))
        let reload = state.apply(update(item("a", at: 5)))
        #expect(state.work["a"] == nil)
        #expect(reload == [.viewer])
    }

    @Test("A ready event of the same version keeps ✎'s wait; a newer one ends it")
    func editingKeptOnSameVersion() {
        var state = viewing()
        state.editing.insert("a")
        state.apply(item("a", at: 0))
        #expect(state.editing.contains("a"))
        state.apply(item("a", at: 3))
        #expect(!state.editing.contains("a"))
    }

    @Test("A refresh's status takes over from the viewer's own spinner; its failure stays until the next event")
    func refreshStatus() {
        var state = viewing()
        state.setRefreshing(true, id: "a")
        state.apply(update(item("a", at: 1), refresh: Self.working))
        #expect(state.viewer?.refreshing == false)
        #expect(state.work["a"]?.isRefreshing == true)
        state.apply(update(item("a", at: 2), refresh: Self.failed))
        #expect(state.work["a"]?.refreshFailed == true)
        #expect(state.work["a"]?.isEditing == false)
    }

    @Test("An older event changes nothing; resync and delete forget the work")
    func olderAndForget() {
        var state = viewing()
        state.apply(update(item("a", at: 5), edit: Self.working))
        state.apply(update(item("a", at: 4)))
        #expect(state.work["a"]?.isEditing == true, "an older event doesn't clear it")

        state.forgetWork()
        #expect(state.work.isEmpty)

        state.apply(update(item("a", at: 6), refresh: Self.working))
        _ = state.remove("a")
        #expect(state.work["a"] == nil)
    }

    @Test("An older server (no statuses) keeps no work state")
    func olderServer() {
        var state = viewing()
        let reload = state.apply(update(item("a", at: 1)))
        #expect(state.work.isEmpty)
        #expect(reload == [.viewer])
    }

    @Test("Trying again drops the last failure of that kind only; an edit reported working keeps ✎'s wait")
    func retryAndWorkingEdit() {
        var state = viewing()
        state.apply(update(item("a", at: 1), edit: Self.failed, refresh: Self.failed))
        state.retryWork("a", edit: true)
        #expect(state.work["a"]?.edit == nil)
        #expect(state.work["a"]?.refreshFailed == true)
        state.retryWork("a", edit: false)
        #expect(state.work["a"] == nil)

        state.editing.insert("a")
        state.apply(update(item("a", at: 2), edit: Self.working))
        #expect(state.editing.contains("a"), "a newer version that only says OpenDuet is editing")
    }
}

@Suite("M21 stale quick replies")
struct UIM21QuickRepliesTests {
    private static let base = Date(timeIntervalSince1970: 1_793_000_000)

    private func message(_ id: String, _ role: Message.Role = .assistant, at minutes: Double, text: String = "text",
                         content: MessageContent? = nil) -> Message {
        let date = Self.base.addingTimeInterval(minutes * 60)
        return Message(
            id: id, channelId: "main", taskId: nil, role: role, text: text, status: .sent, clientId: nil,
            reactions: [], createdAt: date, updatedAt: date,
            content: content ?? .text(TextPayload(skill: nil, attachments: []))
        )
    }

    private func replies(_ id: String, at minutes: Double) -> Message {
        message(id, at: minutes, content: .quickReplies(QuickRepliesPayload(options: ["Yes", "No"], chosen: nil)))
    }

    private func staleIds(_ thread: ThreadState) -> [String: Bool] {
        var result: [String: Bool] = [:]
        for row in ThreadLayout.rows(for: thread) {
            if case .message(let m, let layout) = row.kind, ThreadLayout.isQuickReplies(m) { result[m.id] = layout.stale }
        }
        return result
    }

    @Test("Only OpenDuet's newest message keeps its options live")
    func newestLive() {
        var thread = ThreadState(phase: .loaded)
        thread.messages = [replies("q1", at: 0), message("u1", .user, at: 1), replies("q2", at: 2)]
        #expect(ThreadLayout.liveQuickReplies(thread.messages, hasPending: false) == "q2")
        #expect(staleIds(thread) == ["q1": true, "q2": false])
    }

    @Test("Anything the user or OpenDuet said after them makes them stale; a system line or an empty reply doesn't")
    func newerMessages() {
        let q = replies("q", at: 0)
        #expect(ThreadLayout.liveQuickReplies([q, message("u", .user, at: 1)], hasPending: false) == nil)
        #expect(ThreadLayout.liveQuickReplies([q, message("c", at: 1)], hasPending: false) == nil)
        let system = message("s", .system, at: 1, content: .system(Phrase(key: nil, params: nil, text: "Done")))
        #expect(ThreadLayout.liveQuickReplies([q, system], hasPending: false) == "q")
        #expect(ThreadLayout.liveQuickReplies([q, message("e", at: 1, text: " ")], hasPending: false) == "q")
    }

    @Test("A message on its way (the tap itself, or typed) locks them")
    func pendingLocks() {
        var thread = ThreadState(phase: .loaded)
        thread.messages = [replies("q", at: 0)]
        thread.pending = [Fx.pending("c1", "Yes")]
        #expect(ThreadLayout.liveQuickReplies(thread.messages, hasPending: true) == nil)
        #expect(staleIds(thread) == ["q": true])
    }
}

@Suite("M21 tab bar")
struct UIM21TabBarTests {
    @Test("With a 4th tab all four show icons only; with 3 they keep their text")
    func titles() {
        #expect(TabBarRule.tabCount(hasPinned: false) == 3)
        #expect(TabBarRule.tabCount(hasPinned: true) == 4)
        #expect(TabBarRule.showsTitles(tabCount: 3))
        #expect(!TabBarRule.showsTitles(tabCount: 4))
    }

    @Test("VoiceOver reads the artifact's title on the 4th tab, nil when it has none")
    func pinnedLabel() {
        #expect(TabBarRule.pinnedLabel(title: "  我的工作方式与偏好（起草版 v0.1） ") == "我的工作方式与偏好（起草版 v0.1）")
        #expect(TabBarRule.pinnedLabel(title: " \n") == nil)
    }
}

@Suite("M21 task reply attachments")
struct UIM21TaskAttachmentTests {
    @Test("The task session's attachments show in its composer and go when the task is gone")
    func composerAttachments() {
        var session = TaskSession(taskId: "t1")
        let file = ComposerAttachment(id: UUID(), name: "a.png", mime: "image/png", thumbnail: nil, upload: .uploading(progress: 0.5))
        session.attachments = [file]
        #expect(session.state.composer.attachments == [file])
        session.markGone()
        #expect(session.state.composer.attachments.isEmpty)
    }
}
