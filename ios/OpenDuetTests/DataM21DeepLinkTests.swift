// M21 W4b (review C2 / C3, backend W1 notify): deep links name the message to scroll to
// (duet://channels/<id>?message=<id>, duet://tasks/<id>?message=<id>), a `notification` event's
// collapse id becomes its request identifier, a silent push's `withdraw` and a decided approval
// take the notification back, and a cold Make load forgets a "working" the server may have lost.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M21 deep links with a message")
struct DataM21DeepLinkTests {
    private func url(_ string: String) -> URL { URL(string: string)! }

    @Test("?message= is read from channel and task links; the route itself is unchanged")
    func messageQuery() {
        let channel = url("duet://channels/ch_1?message=msg_9")
        #expect(DuetRoute(channel) == .channel(id: "ch_1"))
        #expect(DuetRoute.messageId(in: channel) == "msg_9")
        let task = url("duet://tasks/t_1?message=msg_2")
        #expect(DuetRoute(task) == .task(id: "t_1"))
        #expect(DuetRoute.messageId(in: task) == "msg_2")
        // Percent-encoded by the server (encodeURIComponent).
        #expect(DuetRoute.messageId(in: url("duet://channels/c1?message=m%2F1")) == "m/1")
        #expect(DuetRoute.messageId(in: url("duet://channels/c1")) == nil)
        #expect(DuetRoute.messageId(in: url("duet://channels/c1?message=")) == nil)
        #expect(DuetRoute.messageId(in: url("duet://channels/c1?other=x")) == nil)
    }

    @Test("A focus only for channel and task links that name a message")
    func focusFromURL() {
        let channel = RouteFocus(url("duet://channels/ch_1?message=msg_9"))
        #expect(channel?.target == .channel("ch_1"))
        #expect(channel?.messageId == "msg_9")
        #expect(RouteFocus(url("duet://tasks/t_1?message=msg_2"))?.target == .task("t_1"))
        #expect(RouteFocus(url("duet://tasks/t_1")) == nil, "a task push without a message opens the task as before")
        #expect(RouteFocus(url("duet://channels/ch_1")) == nil)
        #expect(RouteFocus(url("duet://artifacts/a1?message=m")) == nil)
        #expect(RouteFocus(url("https://example.com/?message=m")) == nil)
    }

    @Test("The focus goes to the thread it names only")
    func focusTarget() {
        let token = UUID()
        let focus = RouteFocus(target: .channel("ch_1"), messageId: "m1", token: token)
        #expect(focus.thread(channelId: "ch_1") == ThreadFocus(messageId: "m1", token: token))
        #expect(focus.thread(channelId: "ch_2") == nil)
        #expect(focus.thread(taskId: "ch_1") == nil, "a task with the same id isn't the channel")
        let task = RouteFocus(target: .task("t_1"), messageId: "m2", token: token)
        #expect(task.thread(taskId: "t_1")?.messageId == "m2")
        #expect(task.thread(channelId: "t_1") == nil)
    }

    @Test("The focus survives a fresh page only when the page has the message")
    func focusSurvives() {
        let focus = RouteFocus(target: .channel(Fx.main), messageId: "m2")
        #expect(focus.survives([Fx.message("m1", at: 1), Fx.message("m2", at: 2)]))
        #expect(!focus.survives([Fx.message("m1", at: 1)]), "unknown or older than the page: open as before")
        #expect(!focus.survives([]))
    }

    @Test("A notification's identifier is its collapse id; grouping drops ?message=")
    func identifiers() {
        #expect(NotificationRules.requestIdentifier(eventId: 7, collapseId: "approval-a1") == "approval-a1")
        #expect(NotificationRules.requestIdentifier(eventId: 7, collapseId: nil) == "event-7")
        #expect(NotificationRules.requestIdentifier(eventId: 7, collapseId: "") == "event-7")
        #expect(NotificationRules.threadIdentifier(route: "duet://channels/c1?message=m1") == "duet://channels/c1")
        #expect(NotificationRules.threadIdentifier(route: "duet://tasks/t1") == "duet://tasks/t1")
    }

    @Test("A silent push's withdraw list, and which delivered notifications it matches")
    func withdraw() {
        let push: [AnyHashable: Any] = ["aps": ["content-available": 1], "withdraw": ["approval-a1", "", 3]]
        #expect(NotificationRules.withdrawIds(in: push) == ["approval-a1"])
        #expect(NotificationRules.withdrawIds(in: ["aps": ["alert": "hi"], "route": "duet://tasks/t1"]).isEmpty)
        let ids: Set<String> = ["approval-a1"]
        // A remote push: iOS picks the identifier; the payload carries the collapse id.
        #expect(NotificationRules.isWithdrawn(identifier: "6F1C-UUID", userInfo: ["collapseId": "approval-a1"], ids: ids))
        // A local one: the identifier is the collapse id.
        #expect(NotificationRules.isWithdrawn(identifier: "approval-a1", userInfo: ["route": "duet://tasks/t1"], ids: ids))
        #expect(!NotificationRules.isWithdrawn(identifier: "task-t1", userInfo: ["collapseId": "task-t1"], ids: ids))
        #expect(!NotificationRules.isWithdrawn(identifier: "event-3", userInfo: [:], ids: ids))
    }

    @Test("A decided approval withdraws its notification; a pending one doesn't")
    func approvalWithdraw() {
        #expect(NotificationRules.withdrawId(for: Fx.approval("a1", status: "pending")) == nil)
        #expect(NotificationRules.withdrawId(for: Fx.approval("a1", status: "approved")) == "approval-a1")
        #expect(NotificationRules.withdrawId(for: Fx.approval("a1", status: "declined")) == "approval-a1")
        #expect(NotificationRules.withdrawId(for: Fx.approval("a1", status: "expired")) == "approval-a1")
    }

    @Test("notification events decode collapseId, tolerating old events and odd values")
    func notificationDecoding() {
        let phrase: [String: Any] = ["key": NSNull(), "params": NSNull(), "text": "Hi"]
        func notification(_ extra: [String: Any]) -> DuetEvent.Notification? {
            var payload: [String: Any] = ["title": phrase, "body": phrase, "route": "duet://tasks/t1?message=m1"]
            payload.merge(extra) { _, new in new }
            guard case .notification(let n) = Fx.event(9, "notification", payload).body else { return nil }
            return n
        }
        #expect(notification(["collapseId": "task-t1"])?.collapseId == "task-t1")
        #expect(notification(["collapseId": "task-t1"])?.route == "duet://tasks/t1?message=m1")
        #expect(notification(["collapseId": NSNull()])?.collapseId == nil)
        #expect(notification([:])?.collapseId == nil, "events stored before M21")
        #expect(notification(["collapseId": 12])?.collapseId == nil, "a wrong type doesn't drop the event")
    }
}

@Suite("M21 Make work after a cold load")
struct DataM21ColdWorkTests {
    private static let base = Date(timeIntervalSince1970: 1_793_000_000)
    private static let working = ArtifactWorkStatus(state: .working, reason: nil)
    private static let failed = ArtifactWorkStatus(state: .failed, reason: Phrase(key: nil, params: nil, text: "No access"))

    private func item(_ id: String, at seconds: Double) -> ArtifactSummary {
        ArtifactSummary(id: id, channelId: "c1", type: .webPage, title: "T \(id)", status: .ready, sourceCount: 0,
                        refreshSchedule: nil, pinnedToTabBar: false, createdAt: Self.base, updatedAt: Self.base.addingTimeInterval(seconds))
    }

    private func update(_ artifact: ArtifactSummary, edit: ArtifactWorkStatus? = nil, refresh: ArtifactWorkStatus? = nil) -> DuetEvent.ArtifactUpdate {
        DuetEvent.ArtifactUpdate(artifact: artifact, buildStatus: nil, editStatus: edit, refreshStatus: refresh)
    }

    @Test("A replayed working before the first list is gone with it; a failure stays")
    func coldLoadDropsWorking() {
        var state = MakeState()
        state.apply(update(item("a", at: 1), edit: Self.working))
        state.apply(update(item("b", at: 1), refresh: Self.working))
        state.apply(update(item("c", at: 1), edit: Self.failed, refresh: Self.working))
        #expect(state.work.count == 3)
        state.applyList([item("a", at: 1), item("b", at: 1), item("c", at: 1)])
        #expect(state.work["a"] == nil)
        #expect(state.work["b"] == nil)
        #expect(state.work["c"]?.editFailed == true, "a failure is final")
        #expect(state.work["c"]?.refresh == nil)
    }

    @Test("Once loaded, a pull to refresh keeps the live work; a new working after it shows")
    func refreshKeepsLiveWork() {
        var state = MakeState()
        state.applyList([item("a", at: 0)])
        state.apply(update(item("a", at: 1), edit: Self.working))
        state.applyList([item("a", at: 1)])
        #expect(state.work["a"]?.isEditing == true, "events since the cold load are live")
    }

    @Test("A failed first list counts as cold too; resync forgets everything")
    func failedListAndResync() {
        var state = MakeState()
        state.failList(reason: "offline")
        state.apply(update(item("a", at: 1), refresh: Self.working))
        state.applyList([item("a", at: 1)])
        #expect(state.work["a"] == nil)
        state.apply(update(item("a", at: 2), edit: Self.failed))
        state.forgetWork()
        #expect(state.work.isEmpty)
    }
}
