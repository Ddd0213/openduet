// The side menu (ChannelMenu): rows without the main thread or archived channels, selection and
// its thread / Tasks scope / context, the ≡ badge, archiving the selected channel, pending
// selections (duet:// links before the list loads). Switching threads (ParkedThreads): the old
// thread keeps its unsent messages and reconciles their echoes; the Tasks scope follows.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Channel menu")
struct DataMenuTests {
    private func loaded(_ channels: [Channel]) -> ChannelMenu {
        var menu = ChannelMenu(mainChannelId: Fx.main)
        _ = menu.setChannels(channels)
        return menu
    }

    @Test("rows leave out the main thread and archived channels; the badge skips the channel on screen")
    func rowsAndBadge() {
        var menu = loaded([
            Fx.chan(Fx.main, isMain: true, unread: 4), Fx.chan("a", unread: 2), Fx.chan("b", unread: 1),
            Fx.chan("old", unread: 7, archived: true),
        ])
        #expect(menu.state.channels.map(\.id) == ["a", "b"])
        #expect(menu.unreadChannels == 2)

        _ = menu.select("a")
        #expect(menu.unreadChannels == 1)
        menu.markedRead("b", at: Fx.date(10))
        #expect(menu.unreadChannels == 0)
        #expect(menu.state.channels[1].lastReadAt == Fx.date(10))
    }

    @Test("select moves the thread, the Tasks scope and the context; nil and the main channel are Everything")
    func selection() {
        var menu = loaded([Fx.chan(Fx.main, isMain: true), Fx.chan("a")])
        #expect(menu.context == .main)

        #expect(menu.select("a") == ChannelSelection(threadChannelId: "a", scope: "a"))
        #expect(menu.context == .channel(name: "a"))
        #expect(menu.threadChannelId == "a")
        #expect(menu.state.selected?.id == "a")
        #expect(menu.select("a") == nil)

        #expect(menu.select(Fx.main) == ChannelSelection(threadChannelId: Fx.main, scope: nil))
        #expect(menu.context == .main)
        #expect(menu.state.selectedChannelId == nil)
        #expect(menu.select(nil) == nil)
    }

    @Test("archiving or losing the selected channel goes back to Everything")
    func archivedSelection() {
        var menu = loaded([Fx.chan(Fx.main, isMain: true), Fx.chan("a"), Fx.chan("b")])
        menu.setArchived([])
        _ = menu.select("a")

        let back = menu.apply(Fx.chan("a", archived: true))
        #expect(back == ChannelSelection(threadChannelId: Fx.main, scope: nil))
        #expect(menu.state.channels.map(\.id) == ["b"])
        #expect(menu.state.archived?.map(\.id) == ["a"])
        // An archived channel can't be selected; unarchiving brings it back to the rows.
        #expect(menu.select("a") == nil)
        #expect(menu.apply(Fx.chan("a")) == nil)
        #expect(menu.state.archived?.isEmpty == true)
        #expect(menu.state.channels.map(\.id) == ["b", "a"])

        _ = menu.select("b")
        #expect(menu.setChannels([Fx.chan(Fx.main, isMain: true), Fx.chan("a")]) == ChannelSelection(threadChannelId: Fx.main, scope: nil))
        #expect(menu.state.selectedChannelId == nil)
    }

    @Test("Archived: a failure with nothing shown sets the reason; a retry clears it")
    func archivedError() {
        var menu = loaded([Fx.chan(Fx.main, isMain: true), Fx.chan("a")])
        menu.beginArchived()
        menu.failArchived(reason: "offline")
        #expect(menu.state.archived == nil)
        #expect(menu.state.archivedError == "offline")
        menu.beginArchived()
        #expect(menu.state.archivedError == nil)
        menu.setArchived([Fx.chan("old", archived: true)])
        #expect(menu.state.archived?.map(\.id) == ["old"])
        // A reload that fails keeps the list on screen without a reason.
        menu.failArchived(reason: "offline")
        #expect(menu.state.archivedError == nil)
        #expect(menu.state.archived?.map(\.id) == ["old"])
    }

    @Test("a channel picked before the list knows it is selected once it shows up")
    func pendingSelection() {
        var menu = ChannelMenu(mainChannelId: Fx.main)
        #expect(menu.select("new") == nil)
        #expect(menu.pendingSelection == "new")
        #expect(menu.setChannels([Fx.chan(Fx.main, isMain: true)]) == nil)
        #expect(menu.pendingSelection == "new")
        #expect(menu.apply(Fx.chan("new")) == ChannelSelection(threadChannelId: "new", scope: "new"))
        #expect(menu.pendingSelection == nil)
        #expect(menu.state.selectedChannelId == "new")
    }

    @Test("channel events from the stream update rows in place and append new ones")
    func channelEvents() {
        var menu = loaded([Fx.chan(Fx.main, isMain: true), Fx.chan("a")])
        guard case .channel(let renamed) = Fx.channelEvent(1, Fx.channel("a", unread: 3)).body else {
            Issue.record("not a channel event")
            return
        }
        _ = menu.apply(renamed)
        _ = menu.apply(Fx.chan("z"))
        _ = menu.apply(Fx.chan(Fx.main, isMain: true, unread: 9))
        #expect(menu.state.channels.map(\.id) == ["a", "z"])
        #expect(menu.state.channels[0].unreadCount == 3)
    }
}

@Suite("Channel switch")
struct DataChannelSwitchTests {
    @Test("switching threads parks unsent messages; their echoes reconcile and the parked thread is dropped")
    func parkAndReconcile() {
        var parked = ParkedThreads()
        var current = ThreadReducer(channelId: "a")
        current.setChannels([Fx.chan(Fx.main, isMain: true), Fx.chan("a"), Fx.chan("b")])
        current.applyFirstPage(Fx.page([Fx.message("m1", at: 1, channel: "a")]))
        current.enqueue(Fx.pending("c1"))

        var next = parked.switchThread(from: current, to: "b")
        #expect(next.channelId == "b")
        #expect(next.thread.messages.isEmpty)
        #expect(next.thread.phase == .loading)
        #expect(next.channels.count == 3)
        #expect(parked.channelIds == ["a"])

        // The echo of the parked message arrives while the user is in "b".
        let echo = Fx.messageEvent(5, Fx.messageJSON("m2", at: 5, role: "user", channel: "a", clientId: "c1"))
        next.apply(echo)
        parked.apply(echo)
        #expect(next.thread.messages.isEmpty)
        parked.prune()
        #expect(parked.channelIds.isEmpty)
    }

    @Test("coming back restores the parked thread with its queue; a thread with nothing pending isn't kept")
    func restore() {
        var parked = ParkedThreads()
        var a = ThreadReducer(channelId: "a")
        a.applyFirstPage(Fx.page([]))
        a.enqueue(Fx.pending("c1"))
        let b = parked.switchThread(from: a, to: "b")
        let back = parked.switchThread(from: b, to: "a")
        #expect(back.channelId == "a")
        #expect(back.thread.pending.map(\.clientId) == ["c1"])
        #expect(back.thread.phase == .loaded)
        #expect(parked.channelIds.isEmpty)
    }

    @Test("the Tasks scope follows the selected channel")
    func tasksScope() {
        var list = TasksReducer()
        list.beginLoad()
        list.applyList([Fx.task("t1", channel: "a"), Fx.task("t2", channel: Fx.main)], scope: nil)
        #expect(list.state.tasks.count == 2)

        var menu = ChannelMenu(mainChannelId: Fx.main)
        _ = menu.setChannels([Fx.chan(Fx.main, isMain: true), Fx.chan("a")])
        let selection = menu.select("a")!
        list.setScope(selection.scope)
        #expect(list.state.scopeChannelId == "a")
        #expect(list.state.tasks.map(\.id) == ["t1"])

        list.setScope(menu.select(nil)!.scope)
        #expect(list.state.tasks.count == 2)
    }
}
