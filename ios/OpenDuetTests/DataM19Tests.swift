// M19: the side menu refresh writes the menu only when GET /api/channels changed it
// (ChatStore.refreshMenu compares a ChannelMenu copy; every observed write re-renders the shell).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Menu refresh diff (M19)")
struct DataM19Tests {
    private let list = [Fx.chan(Fx.main, isMain: true), Fx.chan("a", unread: 1), Fx.chan("b")]

    private func loaded() -> ChannelMenu {
        var menu = ChannelMenu(mainChannelId: Fx.main)
        _ = menu.setChannels(list)
        return menu
    }

    @Test("the same list again leaves the menu equal (nothing to write)")
    func sameListIsEqual() {
        let menu = loaded()
        var next = menu
        let selection = next.setChannels(list)
        #expect(selection == nil)
        #expect(next == menu)
    }

    @Test("a changed row, a gone selection or a pending pick makes it differ")
    func changesDiffer() {
        var menu = loaded()
        var next = menu
        _ = next.setChannels([Fx.chan(Fx.main, isMain: true), Fx.chan("a", unread: 3), Fx.chan("b")])
        #expect(next != menu)

        _ = menu.select("b")
        next = menu
        let back = next.setChannels([Fx.chan(Fx.main, isMain: true), Fx.chan("a", unread: 1)])
        #expect(back == ChannelSelection(threadChannelId: Fx.main, scope: nil))
        #expect(next != menu)

        var pending = loaded()
        _ = pending.select("c")
        next = pending
        let picked = next.setChannels(list + [Fx.chan("c")])
        #expect(picked == ChannelSelection(threadChannelId: "c", scope: "c"))
        #expect(next != pending)
    }
}
