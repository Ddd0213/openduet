// M10 (agent B) UI logic: the Make FAB's scroll fade and the gallery's bottom room, the task
// row's one menu (⋯ and long-press) and the Rename rule, channel ink without the tile, and Make's
// long-press Pin (pinned first, newest pin first, optimistic with rollback, independent of the
// tab bar).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M10b Make FAB fade")
struct UIM10BFABFadeTests {
    @Test("scrolling hides it; idle brings it back after the pause; a resting finger changes nothing")
    func steps() {
        for phase in [FABFadeRule.Phase.interacting, .decelerating, .animating] {
            #expect(FABFadeRule.step(for: phase, hidden: false) == .hide)
            #expect(FABFadeRule.step(for: phase, hidden: true) == .hide)
        }
        #expect(FABFadeRule.step(for: .idle, hidden: true) == .showAfterDelay)
        #expect(FABFadeRule.step(for: .idle, hidden: false) == .keep)
        #expect(FABFadeRule.step(for: .tracking, hidden: false) == .keep)
        #expect(FABFadeRule.step(for: .tracking, hidden: true) == .keep)
        #expect(FABFadeRule.delay == .milliseconds(400))
    }

    @Test("the gallery's bottom room clears the FAB and the tab bar")
    func bottomPadding() {
        // The safe area already holds the chrome: the base room.
        #expect(FABFadeRule.bottomPadding(inset: 140, chrome: 166) == 120)
        // No inset measured (yet): the whole chrome plus the gap.
        #expect(FABFadeRule.bottomPadding(inset: 0, chrome: 166) == 190)
        #expect(FABFadeRule.bottomPadding(inset: 34, chrome: 166) == 156)
        #expect(FABFadeRule.bottomPadding(inset: -10, chrome: 166) == 190, "a negative inset counts as none")
        #expect(FABFadeRule.bottomPadding(inset: 0, chrome: 50, base: 120, gap: 24) == 120)
    }
}

@Suite("M10b task row menu and Rename")
struct UIM10BTaskMenuTests {
    private func model(pinned: Bool = false, resolved: Bool = false, updating: Bool = false,
                       pinning: Bool = false, renaming: Bool = false, deleting: Bool = false) -> TaskRowMenuModel {
        TaskRowMenuModel(pinned: pinned, resolved: resolved, updating: updating, pinning: pinning,
                         renaming: renaming, deleting: deleting)
    }

    @Test("one menu, in order, Delete under a divider; no add sub-goal")
    func order() {
        let idle = model()
        #expect(idle.items == [.discuss, .pin, .markComplete, .rename, .archive, .copyLink, .delete])
        #expect(idle.items.allSatisfy { !idle.isDisabled($0) })
        #expect(idle.items.filter(idle.startsGroup) == [.delete])
    }

    @Test("what each state disables")
    func disabled() {
        let resolved = model(resolved: true)
        #expect(resolved.isDisabled(.markComplete))
        #expect(!resolved.isDisabled(.archive))
        #expect(!resolved.isDisabled(.rename))

        // Pin and Rename share the task's one optimistic PATCH.
        for busy in [model(pinning: true), model(renaming: true)] {
            #expect(busy.isDisabled(.pin))
            #expect(busy.isDisabled(.rename))
            #expect(!busy.isDisabled(.markComplete))
            #expect(!busy.isDisabled(.archive))
        }

        let updating = model(updating: true)
        #expect(updating.isDisabled(.markComplete))
        #expect(updating.isDisabled(.archive))
        #expect(!updating.isDisabled(.pin))

        let deleting = model(deleting: true)
        #expect(deleting.items.filter(deleting.isDisabled) == [.pin, .markComplete, .rename, .archive, .delete])
        #expect(!deleting.isDisabled(.discuss))
        #expect(!deleting.isDisabled(.copyLink))
    }

    @Test("Rename: trimmed, 1-200 characters (UTF-16, as the server counts), and a change")
    func titleRule() {
        #expect(TaskTitleRule.cleaned("  Plan the offsite \n") == "Plan the offsite")
        #expect(TaskTitleRule.cleaned("   ") == nil)
        #expect(TaskTitleRule.cleaned("") == nil)
        #expect(TaskTitleRule.cleaned(String(repeating: "a", count: 200)) != nil)
        #expect(TaskTitleRule.cleaned(String(repeating: "a", count: 201)) == nil)
        #expect(TaskTitleRule.cleaned("  " + String(repeating: "a", count: 200) + "  ") != nil, "spaces around don't count")
        // 😀 is 2 UTF-16 units: 100 fit, 101 don't.
        #expect(TaskTitleRule.cleaned(String(repeating: "😀", count: 100)) != nil)
        #expect(TaskTitleRule.cleaned(String(repeating: "😀", count: 101)) == nil)
        #expect(TaskTitleRule.isTooLong(String(repeating: "a", count: 201)))
        #expect(!TaskTitleRule.isTooLong("   "))

        #expect(TaskTitleRule.canSave("New name", current: "Old name"))
        #expect(!TaskTitleRule.canSave("  Old name ", current: "Old name"), "unchanged once trimmed")
        #expect(!TaskTitleRule.canSave("  ", current: "Old name"))
    }
}

@Suite("M10b channel ink")
struct UIM10BChannelInkTests {
    @Test("still 24 icons and 9 colours")
    func counts() {
        #expect(ChannelIcon.allCases.count == 24)
        #expect(ChannelColor.allCases.count == 9)
    }

    @Test("on a light background pale swatches deepen a lot, orange a little, the deep ones not at all")
    func lightInk() {
        #expect(ChannelColor.allCases.filter(\.isPale) == [.blush, .sand, .sage, .mist, .lavender])
        for pale in [ChannelColor.blush, .sand, .sage, .mist, .lavender] {
            #expect(pale.lightInkDarkening == 0.42)
        }
        #expect(ChannelColor.orange.lightInkDarkening == 0.22)
        for deep in [ChannelColor.berry, .green, .blue] {
            #expect(deep.lightInkDarkening == 0)
        }
        #expect(ChannelColor.berry.hex == 0xB54C76)
        #expect(ChannelColor.orange.luma > 0.6 && ChannelColor.orange.luma < 0.7)
    }

    @Test("with no tile the line fills nearly all of an inline frame, less of a big preview")
    func artRatio() {
        #expect(ChannelGlyphLayout.artRatio(for: 16) == 0.94)
        #expect(ChannelGlyphLayout.artRatio(for: 26) == 0.94)
        #expect(ChannelGlyphLayout.artRatio(for: 56) == 0.8)
        #expect(ChannelGlyphLayout.artRatio(for: 84) == 0.8)
    }
}
@Suite("M10b Make pin")
struct UIM10BMakePinTests {
    private static let zone = TimeZone(identifier: "America/Los_Angeles")!
    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }
    /// Tuesday 2026-11-03 15:00 in Los Angeles.
    private static let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 3, hour: 15))!

    /// `pinned` is the Make pin (not the tab bar's `pinnedToTabBar`).
    private func item(_ id: String, _ type: ArtifactType = .webPage, status: ArtifactSummary.Status = .ready,
                      hoursAgo: Double = 1, pinned: Bool = false, tabBar: Bool = false) -> ArtifactSummary {
        let at = Self.now.addingTimeInterval(-hoursAgo * 3600)
        return ArtifactSummary(id: id, channelId: "c1", type: type, title: "T \(id)", status: status, sourceCount: 0,
                               refreshSchedule: nil, pinnedToTabBar: tabBar, createdAt: at, updatedAt: at, pinned: pinned)
    }

    private func ids(_ state: MakeState) -> [String] { state.artifacts.map(\.id) }

    @Test("Pin moves it to the front at once, newest pin first; Unpin puts it back; a failure rolls back")
    func optimisticPin() {
        var state = MakeState()
        state.applyList([item("a", hoursAgo: 1), item("b", hoursAgo: 2), item("c", hoursAgo: 3)])
        #expect(ids(state) == ["a", "b", "c"])

        let pinC = state.setPinnedInMake("c", true)
        #expect(pinC == MakeState.PinChange(id: "c", wasPinned: false, index: nil))
        #expect(ids(state) == ["c", "a", "b"])
        let pinB = state.setPinnedInMake("b", true)
        #expect(ids(state) == ["b", "c", "a"], "the newest pin goes first")
        #expect(state.pinnedInMake.map(\.id) == ["b", "c"])

        // b's PATCH failed: back to where it was.
        if let pinB { state.restorePinInMake(pinB) } else { Issue.record("expected a change") }
        #expect(ids(state) == ["c", "a", "b"])
        #expect(state.artifact("b")?.pinned == false)

        let unpinC = state.setPinnedInMake("c", false)
        #expect(ids(state) == ["a", "b", "c"])
        // c's Unpin failed: pinned again, in its old place.
        if let unpinC { state.restorePinInMake(unpinC) } else { Issue.record("expected a change") }
        #expect(ids(state) == ["c", "a", "b"])
        #expect(state.pinOrder == ["c"])

        let again = state.setPinnedInMake("c", true)
        #expect(again == nil, "already pinned")
        let missing = state.setPinnedInMake("zzz", true)
        #expect(missing == nil)
        #expect(state.pinned == nil, "Pin in Make leaves the tab bar alone")
    }

    @Test("the server's order of pinned ones is kept; a pin in flight survives a list reload")
    func listKeepsPins() {
        var state = MakeState()
        state.applyList([item("p2", hoursAgo: 5, pinned: true), item("p1", hoursAgo: 1, pinned: true), item("x", hoursAgo: 0)])
        #expect(ids(state) == ["p2", "p1", "x"], "pinned first in the server's (newest pin) order")
        #expect(state.pinOrder == ["p2", "p1"])

        _ = state.setPinnedInMake("x", true)
        state.requests[MakeState.RequestKey.pinInMake("x")] = .inFlight
        // A reload that went out before the PATCH landed still says x isn't pinned.
        state.applyList([item("p2", hoursAgo: 5, pinned: true), item("p1", hoursAgo: 1, pinned: true), item("x", hoursAgo: 0)])
        #expect(state.artifact("x")?.pinned == true)
        #expect(ids(state) == ["x", "p2", "p1"])

        // Answered: the next list is the truth.
        state.requests[MakeState.RequestKey.pinInMake("x")] = nil
        state.applyList([item("x", hoursAgo: 0, pinned: true), item("p2", hoursAgo: 5, pinned: true), item("p1", hoursAgo: 1, pinned: true)])
        #expect(ids(state) == ["x", "p2", "p1"])
    }

    @Test("an artifact event pins or unpins (a pin from elsewhere goes first); one in flight keeps the user's choice")
    func eventsPin() {
        var state = MakeState()
        state.applyList([item("a", hoursAgo: 1), item("b", hoursAgo: 2)])
        state.apply(item("b", hoursAgo: 2, pinned: true))
        #expect(ids(state) == ["b", "a"])
        state.apply(item("b", hoursAgo: 2, pinned: false))
        #expect(ids(state) == ["a", "b"])
        #expect(state.pinOrder.isEmpty)

        _ = state.setPinnedInMake("a", true)
        state.requests[MakeState.RequestKey.pinInMake("a")] = .inFlight
        state.apply(item("a", hoursAgo: 0.5, pinned: false))
        #expect(state.artifact("a")?.pinned == true)
        #expect(ids(state).first == "a")
    }

    @Test("Delete and its rollback keep a pinned item's place")
    func deleteKeepsPinPlace() {
        var state = MakeState()
        state.applyList([item("p1", hoursAgo: 3, pinned: true), item("p2", hoursAgo: 2, pinned: true),
                         item("p3", hoursAgo: 1, pinned: true), item("x")])
        state.requests[MakeState.RequestKey.pinInMake("p2")] = .failed(reason: "Offline")
        let removal = state.remove("p2")
        #expect(removal?.pinIndex == 1)
        #expect(state.pinOrder == ["p1", "p3"])
        #expect(state.requests[MakeState.RequestKey.pinInMake("p2")] == nil)
        if let removal { state.restore(removal) } else { Issue.record("expected a removal") }
        #expect(ids(state) == ["p1", "p2", "p3", "x"])
        #expect(state.pinOrder == ["p1", "p2", "p3"])
    }

    @Test("sort: ranked pins, then unranked pins, then newest first")
    func sortPinnedFirst() {
        var list = [item("old"), item("pinX", hoursAgo: 4, pinned: true), item("new", hoursAgo: 0),
                    item("pinA", hoursAgo: 9, pinned: true), item("pinNoRank", hoursAgo: 2, pinned: true)]
        MakeState.sortPinnedFirst(&list, pinOrder: ["pinA", "pinX", "gone"])
        #expect(list.map(\.id) == ["pinA", "pinX", "pinNoRank", "new", "old"])
    }

    @Test("the gallery's Pinned section comes first and takes them out of the other sections")
    func gallerySection() {
        let gallery = MakeGallery(artifacts: [
            item("today", hoursAgo: 2),
            item("pinnedDesign", .design, hoursAgo: 30, pinned: true),
            item("pinnedToday", hoursAgo: 1, pinned: true),
            item("design", .design, hoursAgo: 30),
        ], now: Self.now, calendar: Self.calendar)
        func ids(_ kind: MakeGallery.Section.Kind) -> [String] { gallery.section(kind)?.items.map(\.id) ?? [] }
        #expect(gallery.sections.first?.kind == .pinned)
        // M24: sorted as chosen like every section (Last modified by default).
        #expect(ids(.pinned) == ["pinnedToday", "pinnedDesign"])
        #expect(ids(.changedToday) == ["today"])
        #expect(ids(.designs) == ["design"])
        #expect(!gallery.isEmpty)
        let byTitle = MakeGallery(artifacts: [item("b", hoursAgo: 1, pinned: true), item("a", hoursAgo: 5, pinned: true)],
                                  sort: .title, now: Self.now, calendar: Self.calendar)
        #expect(byTitle.section(.pinned)?.items.map(\.id) == ["a", "b"])
        let onlyPinned = MakeGallery(artifacts: [item("p", hoursAgo: 48, pinned: true)], now: Self.now, calendar: Self.calendar)
        #expect(!onlyPinned.isEmpty)
        #expect(onlyPinned.sections.map(\.kind) == [.pinned])
    }
}
