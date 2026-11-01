// Make tab state (Stores/MakeReducer.swift, Stores/MakeGallery.swift, prompt L147-L152): the
// gallery's sections, live `artifact` events against the list (newer wins), the Build view only
// for first builds and its hand-over to the viewer, "Just made", viewers reloading a newer
// version, and Add to tab bar (one pinned at a time, rolled back on failure).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("Make state")
struct UIMakeStateTests {
    private static let zone = TimeZone(identifier: "America/Los_Angeles")!
    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }
    /// Tuesday 2026-11-03 15:00 in Los Angeles.
    private static let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 3, hour: 15))!

    private func item(_ id: String, _ type: ArtifactType = .webPage, status: ArtifactSummary.Status = .ready,
                      hoursAgo: Double = 1, pinned: Bool = false) -> ArtifactSummary {
        let at = Self.now.addingTimeInterval(-hoursAgo * 3600)
        return ArtifactSummary(id: id, channelId: "c1", type: type, title: "T \(id)", status: status, sourceCount: 0,
                               refreshSchedule: nil, pinnedToTabBar: pinned, createdAt: at, updatedAt: at)
    }

    // MARK: Gallery sections

    private func ids(_ gallery: MakeGallery, _ kind: MakeGallery.Section.Kind) -> [String] {
        gallery.section(kind)?.items.map(\.id) ?? []
    }

    /// M24: Changed today (building first), Designs, Pages; "Earlier" is gone (older pages are Pages).
    @Test func sectionsSplitByDayAndType() {
        let gallery = MakeGallery(artifacts: [
            item("today", hoursAgo: 2),
            item("building", status: .building, hoursAgo: 30),
            item("design", .design, hoursAgo: 30),
            item("page", .docs, hoursAgo: 48),
            item("old", .slides, hoursAgo: 24 * 9),
        ], now: Self.now, calendar: Self.calendar)
        #expect(ids(gallery, .changedToday) == ["building", "today"])
        #expect(ids(gallery, .designs) == ["design"])
        #expect(ids(gallery, .pages) == ["page", "old"])
        #expect(gallery.sections.map(\.kind) == [.changedToday, .designs, .pages])
        #expect(!gallery.isEmpty)
        #expect(MakeGallery(artifacts: [], now: Self.now).isEmpty)
    }

    /// M24: "See all ›" after 4 in the grid (two rows), 5 in the list.
    @Test func sectionsShowFourOrFiveUntilSeeAll() throws {
        let pages = (1...6).map { item("p\($0)", .docs, hoursAgo: 24 + Double($0)) }
        let section = try #require(MakeGallery(artifacts: pages, now: Self.now, calendar: Self.calendar).section(.pages))
        #expect(section.hasMore(.grid) && section.hasMore(.list))
        #expect(section.visible(.grid, expanded: false).map(\.id) == ["p1", "p2", "p3", "p4"])
        #expect(section.visible(.list, expanded: false).map(\.id) == ["p1", "p2", "p3", "p4", "p5"])
        #expect(section.visible(.grid, expanded: true).count == 6)
        let five = try #require(MakeGallery(artifacts: Array(pages.prefix(5)), now: Self.now, calendar: Self.calendar).section(.pages))
        #expect(five.hasMore(.grid) && !five.hasMore(.list))
    }

    // MARK: List and events

    @Test func listKeepsANewerLiveCopy() {
        var state = MakeState()
        state.apply(item("a", hoursAgo: 0))
        state.applyList([item("a", hoursAgo: 3), item("b", hoursAgo: 2)])
        #expect(state.phase == .loaded)
        #expect(state.artifacts.map(\.id) == ["a", "b"])
        #expect(state.artifact("a")?.updatedAt == Self.now)
    }

    @Test func olderEventIsIgnored() {
        var state = MakeState()
        state.apply(item("a", hoursAgo: 0))
        var stale = item("a", hoursAgo: 2)
        stale.title = "old"
        let r1 = state.apply(stale)
        #expect(r1.isEmpty)
        #expect(state.artifact("a")?.title == "T a")
    }

    @Test func failedReloadKeepsTheGallery() {
        var state = MakeState()
        state.applyList([item("a")])
        state.refreshing = true
        state.failList(reason: "offline")
        #expect(state.phase == .loaded)
        #expect(state.refreshFailure == "offline")
        #expect(!state.refreshing)
        var fresh = MakeState()
        fresh.failList(reason: "offline")
        #expect(fresh.phase == .failed(reason: "offline"))
    }

    // MARK: Build view

    @Test func createOpensTheBuildViewThenHandsOverToTheViewer() {
        var state = MakeState()
        state.requests[MakeState.RequestKey.create] = .inFlight
        state.created(item("n", status: .building, hoursAgo: 0))
        #expect(state.build == "n")
        #expect(state.requests[MakeState.RequestKey.create] == nil)
        #expect(state.isFirstBuild("n"))
        let phrase = Phrase(key: "build.waking_workspace", params: nil, text: nil)
        var building = item("n", status: .building, hoursAgo: 0)
        building.updatedAt = Self.now.addingTimeInterval(1)
        let r2 = state.apply(building, buildStatus: phrase)
        #expect(r2.isEmpty)
        #expect(state.buildStatus["n"] == phrase)
        var ready = item("n", hoursAgo: 0)
        ready.updatedAt = Self.now.addingTimeInterval(20)
        let r3 = state.apply(ready)
        #expect(r3 == [.viewer])
        #expect(state.build == nil)
        #expect(state.viewer?.artifactId == "n")
        #expect(state.buildStatus["n"] == nil)
        #expect(!state.justMade.contains("n"))
        // M24: watched to the end = opened (no "Just made"); the viewer's first load gets the detail.
        #expect(state.artifact("n")?.lastOpenedAt != nil)
        #expect(state.artifact("n")?.isJustMade == false)
        #expect(state.needsDetail(.viewer, id: "n"))
    }

    @Test func buildFinishedElsewhereIsJustMade() {
        var state = MakeState()
        state.created(item("n", status: .building, hoursAgo: 0))
        state.build = nil
        var ready = item("n", hoursAgo: 0)
        ready.updatedAt = Self.now.addingTimeInterval(20)
        let r4 = state.apply(ready)
        #expect(r4.isEmpty)
        #expect(state.justMade.contains("n"))
        // M24: "Just made" = ready and never opened.
        #expect(state.artifact("n")?.isJustMade == true)
        // Opening it clears the badge and opens the viewer (it needs loading).
        let r5 = state.open("n", now: Self.now.addingTimeInterval(60))
        #expect(r5)
        #expect(!state.justMade.contains("n"))
        #expect(state.artifact("n")?.lastOpenedAt == Self.now.addingTimeInterval(60))
        #expect(state.artifact("n")?.isJustMade == false)
        #expect(state.viewer?.artifactId == "n")
    }

    @Test func failedFirstBuildStaysInTheBuildView() {
        var state = MakeState()
        state.created(item("n", status: .building, hoursAgo: 0))
        var failed = item("n", status: .failed, hoursAgo: 0)
        failed.updatedAt = Self.now.addingTimeInterval(5)
        let reason = Phrase(key: "artifact.workspace_unreachable", params: nil, text: nil)
        state.apply(failed, buildStatus: reason)
        #expect(state.build == "n")
        #expect(state.buildStatus["n"] == reason)
        #expect(state.isFirstBuild("n"))
    }

    @Test func editOfAKnownPageKeepsTheViewerAndReloads() {
        var state = MakeState()
        state.applyList([item("a", hoursAgo: 2)])
        let r6 = state.open("a")
        #expect(r6)
        state.htmlLoaded("<p>v1</p>", version: state.artifact("a")?.updatedAt, slot: .viewer, id: "a")
        var building = item("a", status: .building, hoursAgo: 0)
        building.updatedAt = Self.now
        let r7 = state.apply(building)
        #expect(r7.isEmpty)
        #expect(!state.isFirstBuild("a"))
        #expect(state.build == nil)
        var ready = item("a", hoursAgo: 0)
        ready.updatedAt = Self.now.addingTimeInterval(30)
        let r8 = state.apply(ready)
        #expect(r8 == [.viewer])
        state.htmlLoaded("<p>v2</p>", version: ready.updatedAt, slot: .viewer, id: "a")
        #expect(state.viewer?.editGeneration == 1)
        #expect(state.viewer?.phase == .ready(html: "<p>v2</p>"))
    }

    @Test func reloadFailureKeepsThePage() {
        var state = MakeState()
        state.applyList([item("a")])
        _ = state.open("a")
        state.htmlFailed(reason: "x", slot: .viewer, id: "a")
        #expect(state.viewer?.phase == .failed(reason: "x"))
        state.htmlLoaded("<p>ok</p>", version: nil, slot: .viewer, id: "a")
        state.htmlFailed(reason: "y", slot: .viewer, id: "a")
        #expect(state.viewer?.phase == .ready(html: "<p>ok</p>"))
    }

    // MARK: Add to tab bar

    @Test func onePinnedAtATimeAndRollback() {
        var state = MakeState()
        state.applyList([item("a", pinned: true), item("b", hoursAgo: 2)])
        #expect(state.pinned?.id == "a")
        let before = state.setPinned("b", true)
        #expect(state.pinned?.id == "b")
        #expect(state.artifact("a")?.pinnedToTabBar == false)
        state.restorePins(before)
        #expect(state.pinned?.id == "a")
        _ = state.setPinned("a", false)
        #expect(state.pinned == nil)
    }

    @Test func pinnedEventUnpinsTheOlderOne() {
        var state = MakeState()
        state.applyList([item("a", hoursAgo: 3, pinned: true), item("b", hoursAgo: 2)])
        state.pinnedViewer = ArtifactViewerState(artifactId: "a")
        var b = item("b", hoursAgo: 0, pinned: true)
        b.updatedAt = Self.now
        state.apply(b)
        #expect(state.pinned?.id == "b")
        #expect(state.artifact("a")?.pinnedToTabBar == false)
        #expect(state.pinnedViewer == nil)
    }

    @Test func staleViewer() {
        var viewer = ArtifactViewerState(artifactId: "a")
        #expect(!viewer.isStale(for: item("a")))
        viewer.phase = .ready(html: "")
        viewer.loadedVersion = Self.now.addingTimeInterval(-3600)
        #expect(!viewer.isStale(for: item("a", hoursAgo: 1)))
        #expect(viewer.isStale(for: item("a", hoursAgo: 0)))
    }
}
