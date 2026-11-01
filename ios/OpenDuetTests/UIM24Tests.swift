// M24 W4 (plan §7 W4, prompt L147, review-make P1-4 / P2-1 / P2-4): the gallery's type chips and
// sorts (Stores/MakeGallery.swift), "Just made" from lastOpenedAt and viewers catching up
// (Stores/MakeReducer.swift), the viewer's Versions rows and Undo (Make/VersionRules.swift), the
// card's line chart and checkable checklist (Chat/Cards/CardBlockRules.swift) and the thumbnail
// disk cache (Make/ThumbnailDiskCache.swift).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private enum M24Fixture {
    static let zone = TimeZone(identifier: "America/Los_Angeles")!
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }
    /// Tuesday 2026-11-03 15:00 in Los Angeles.
    static let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 3, hour: 15))!

    static func item(_ id: String, _ type: ArtifactType = .webPage, status: ArtifactSummary.Status = .ready,
                     hoursAgo: Double = 1, pinned: Bool = false, title: String? = nil, opened: Double? = nil,
                     madeHoursAgo: Double? = nil) -> ArtifactSummary {
        let at = now.addingTimeInterval(-hoursAgo * 3600)
        let made = madeHoursAgo.map { now.addingTimeInterval(-$0 * 3600) } ?? at
        return ArtifactSummary(id: id, channelId: "c1", type: type, title: title ?? "T \(id)", status: status, sourceCount: 0,
                               refreshSchedule: nil, pinnedToTabBar: false, createdAt: made, updatedAt: at, pinned: pinned,
                               lastOpenedAt: opened.map { now.addingTimeInterval(-$0 * 3600) })
    }

    static func decode<T: Decodable>(_ type: T.Type, _ object: [String: Any]) throws -> T {
        try JSONCoding.decoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }

    static func iso(_ date: Date) -> String { date.formatted(.iso8601) }
}

@Suite("M24 gallery")
struct UIM24GalleryTests {
    private typealias F = M24Fixture

    private func ids(_ gallery: MakeGallery, _ kind: MakeGallery.Section.Kind) -> [String] {
        gallery.section(kind)?.items.map(\.id) ?? []
    }

    @Test("Chips: only the types that have items, in the + menu's order")
    func chips() {
        let gallery = MakeGallery(artifacts: [F.item("s", .slides), F.item("d", .design), F.item("w", .webPage), F.item("s2", .slides)],
                                  now: F.now, calendar: F.calendar)
        #expect(gallery.types == [.webPage, .slides, .design])
        #expect(gallery.filter == nil)
        #expect(MakeGallery(artifacts: [], now: F.now).types.isEmpty)
    }

    @Test("A picked type leaves one section of just its items, building first; a stale pick reads All")
    func filter() {
        let all = [
            F.item("old", .slides, hoursAgo: 24 * 9),
            F.item("today", .slides, hoursAgo: 2),
            F.item("building", .slides, status: .building, hoursAgo: 30),
            F.item("pinned", .slides, hoursAgo: 48, pinned: true),
            F.item("page", .webPage, hoursAgo: 1),
        ]
        let slides = MakeGallery(artifacts: all, filter: .slides, now: F.now, calendar: F.calendar)
        #expect(slides.filter == .slides)
        #expect(slides.sections.map(\.kind) == [.type(.slides)])
        #expect(ids(slides, .type(.slides)) == ["building", "today", "pinned", "old"])
        let stale = MakeGallery(artifacts: all, filter: .dashboard, now: F.now, calendar: F.calendar)
        #expect(stale.filter == nil)
        #expect(stale.sections.map(\.kind) == [.pinned, .changedToday, .pages])
    }

    @Test("Each item sits in exactly one section: Pinned, Changed today, Designs, Pages")
    func oneSectionEach() {
        let all = [
            F.item("p", .design, hoursAgo: 1, pinned: true),
            F.item("t", .design, hoursAgo: 1),
            F.item("ds", .designSystem, hoursAgo: 50),
            F.item("dash", .dashboard, hoursAgo: 50),
        ]
        let gallery = MakeGallery(artifacts: all, now: F.now, calendar: F.calendar)
        #expect(gallery.sections.map(\.kind) == [.pinned, .changedToday, .designs, .pages])
        #expect(ids(gallery, .pinned) == ["p"])
        #expect(ids(gallery, .changedToday) == ["t"])
        #expect(ids(gallery, .designs) == ["ds"])
        #expect(ids(gallery, .pages) == ["dash"])
        let placed = gallery.sections.flatMap(\.items).map(\.id)
        #expect(placed.sorted() == all.map(\.id).sorted())
    }

    @Test("Last opened: newest open first; a never-opened one counts from when it was made")
    func lastOpened() {
        let gallery = MakeGallery(artifacts: [
            F.item("openedLongAgo", .docs, hoursAgo: 30, opened: 29),
            F.item("neverOpened", .docs, hoursAgo: 30, madeHoursAgo: 40),
            F.item("openedJustNow", .docs, hoursAgo: 72, opened: 0.5),
        ], sort: .lastOpened, now: F.now, calendar: F.calendar)
        #expect(ids(gallery, .pages) == ["openedJustNow", "openedLongAgo", "neverOpened"])
        let modified = MakeGallery(artifacts: gallery.section(.pages)!.items, sort: .lastModified, now: F.now, calendar: F.calendar)
        // Last modified: by updatedAt (the two at 30 h tie, then the id decides).
        #expect(ids(modified, .pages) == ["openedLongAgo", "neverOpened", "openedJustNow"])
    }

    @Test("Title: A to Z, numbers in order, case-blind; same title newest change first")
    func title() {
        let gallery = MakeGallery(artifacts: [
            F.item("b", .docs, hoursAgo: 30, title: "banana"),
            F.item("a10", .docs, hoursAgo: 30, title: "Plan 10"),
            F.item("a2", .docs, hoursAgo: 30, title: "Plan 2"),
            F.item("A", .docs, hoursAgo: 30, title: "Apple"),
            F.item("dupOld", .docs, hoursAgo: 60, title: "Zed"),
            F.item("dupNew", .docs, hoursAgo: 40, title: "Zed"),
        ], sort: .title, now: F.now, calendar: F.calendar)
        #expect(ids(gallery, .pages) == ["A", "b", "a2", "a10", "dupNew", "dupOld"])
    }

    @Test("Just made: ready and never opened")
    func justMade() {
        #expect(F.item("n").isJustMade)
        #expect(!F.item("o", opened: 0).isJustMade)
        #expect(!F.item("b", status: .building).isJustMade)
        #expect(!F.item("f", status: .failed).isJustMade)
    }
}

@Suite("M24 Make state")
struct UIM24MakeStateTests {
    private typealias F = M24Fixture

    private func detail(_ summary: ArtifactSummary) throws -> ArtifactDetail {
        var object: [String: Any] = [
            "id": summary.id, "channelId": summary.channelId, "type": summary.type.rawValue, "title": summary.title,
            "status": summary.status.rawValue, "sourceCount": 0, "pinnedToTabBar": false,
            "createdAt": F.iso(summary.createdAt), "updatedAt": F.iso(summary.updatedAt), "prompt": "p", "sources": [],
        ]
        if let opened = summary.lastOpenedAt { object["lastOpenedAt"] = F.iso(opened) }
        return try F.decode(ArtifactDetail.self, object)
    }

    @Test("An open is never undone: a list or event read before it (null) keeps it; the newer one wins")
    func openStays() {
        var state = MakeState()
        state.applyList([F.item("a", hoursAgo: 2)])
        #expect(state.artifact("a")?.isJustMade == true)
        _ = state.open("a", now: F.now)
        #expect(state.artifact("a")?.lastOpenedAt == F.now)
        state.applyList([F.item("a", hoursAgo: 2)])
        #expect(state.artifact("a")?.lastOpenedAt == F.now)
        state.apply(F.item("a", hoursAgo: 2))
        #expect(state.artifact("a")?.lastOpenedAt == F.now)
        // Opened later on another device: the list's newer date wins.
        let later = F.now.addingTimeInterval(600)
        var elsewhere = F.item("a", hoursAgo: 2)
        elsewhere.lastOpenedAt = later
        state.applyList([elsewhere])
        #expect(state.artifact("a")?.lastOpenedAt == later)
        // An open on this device that is older than the list's keeps the list's.
        _ = state.open("a", now: F.now)
        #expect(state.artifact("a")?.lastOpenedAt == later)
    }

    @Test("Viewers behind the gallery's ready copy reload; not while OpenDuet works or the page is loading")
    func staleViewers() {
        var state = MakeState()
        state.applyList([F.item("a", hoursAgo: 2), F.item("b", hoursAgo: 2)])
        state.viewer = ArtifactViewerState(artifactId: "a", phase: .ready(html: "<p>"), loadedVersion: F.now.addingTimeInterval(-7200))
        state.pinnedViewer = ArtifactViewerState(artifactId: "b", phase: .ready(html: "<p>"), loadedVersion: F.now.addingTimeInterval(-7200))
        #expect(state.staleViewers().isEmpty)
        // A restore while the stream was down: the list says both moved on.
        state.applyList([F.item("a", hoursAgo: 0), F.item("b", hoursAgo: 0)])
        #expect(state.staleViewers() == [.viewer: "a", .pinned: "b"])
        state.work["b"] = ArtifactWork(edit: ArtifactWorkStatus(state: .working), refresh: nil)
        #expect(state.staleViewers() == [.viewer: "a"])
        state.viewer?.phase = .loading
        #expect(state.staleViewers().isEmpty)
        state.viewer = ArtifactViewerState(artifactId: "a", phase: .ready(html: "<p>"), loadedVersion: F.now)
        #expect(state.staleViewers().isEmpty)
    }

    @Test("A viewer the Build view handed over fetches its detail once (it records the open)")
    func needsDetail() throws {
        var state = MakeState()
        state.applyList([F.item("a")])
        state.viewer = ArtifactViewerState(artifactId: "a")
        #expect(state.needsDetail(.viewer, id: "a"))
        #expect(!state.needsDetail(.viewer, id: "other"))
        #expect(!state.needsDetail(.pinned, id: "a"))
        var opened = F.item("a")
        opened.lastOpenedAt = F.now
        state.detailLoaded(try detail(opened), slot: .viewer)
        #expect(!state.needsDetail(.viewer, id: "a"))
        #expect(state.artifact("a")?.lastOpenedAt == F.now)
    }

    @Test("newer: the later of two optional dates")
    func newer() {
        let a = F.now, b = F.now.addingTimeInterval(1)
        #expect(MakeState.newer(nil, nil) == nil)
        #expect(MakeState.newer(a, nil) == a)
        #expect(MakeState.newer(nil, b) == b)
        #expect(MakeState.newer(a, b) == b && MakeState.newer(b, a) == b)
    }
}

@Suite("M24 versions")
struct UIM24VersionTests {
    private typealias F = M24Fixture

    private func version(_ id: String, by: String? = "user", reason: String? = "edit", prompt: String? = nil) throws -> ArtifactVersion {
        var object: [String: Any] = ["id": id, "artifactId": "a", "createdAt": F.iso(F.now)]
        if let by { object["by"] = by }
        if let reason { object["reason"] = reason }
        if let prompt { object["prompt"] = prompt }
        return try F.decode(ArtifactVersion.self, object)
    }

    private func label(_ by: String?, _ reason: String?) throws -> VersionRules.Label {
        VersionRules.label(try version("v", by: by, reason: reason))
    }

    @Test("Who saved it and why; a value from a newer server still reads")
    func labels() throws {
        #expect(try label("user", "create") == .made(.you))
        #expect(try label("assistant", "edit") == .edited(.assistant))
        #expect(try label("assistant", "refresh") == .refreshed(.assistant))
        #expect(try label("user", "restore") == .restored(.you))
        #expect(try label("robot", "edit") == .edited(nil))
        #expect(try label("assistant", "merge") == .changed(.assistant))
        #expect(try label(nil, nil) == .changed(nil))
    }

    @Test("What was asked: one line, a comment's note over its quote, at most 80 characters")
    func detail() {
        #expect(VersionRules.detail(nil) == nil)
        #expect(VersionRules.detail("  \n ") == nil)
        #expect(VersionRules.detail("Make it   blue\n\nand bigger") == "Make it blue and bigger")
        #expect(VersionRules.detail("> Q3 revenue\n> was flat\nSay why") == "Say why")
        #expect(VersionRules.detail("> just the quote") == "just the quote")
        let long = String(repeating: "word ", count: 30)
        let cut = VersionRules.detail(long)
        #expect(cut?.count ?? 0 <= 80)
        #expect(cut?.hasSuffix("…") == true)
        #expect(VersionRules.detail(String(repeating: "a", count: 80))?.count == 80)
    }

    @Test("Every row but the newest can be restored")
    func canRestore() throws {
        let list = ArtifactVersionList(versions: [try version("v3"), try version("v2"), try version("v1")])
        #expect(!VersionRules.canRestore(list.versions[0], in: list))
        #expect(VersionRules.canRestore(list.versions[1], in: list))
        #expect(VersionRules.canRestore(list.versions[2], in: list))
        #expect(!VersionRules.canRestore(list.versions[0], in: ArtifactVersionList(versions: [])))
    }

    @Test("A refused restore says why: OpenDuet still working (409), a dropped version (404), else the usual")
    func failure() {
        let busy = "OpenDuet is still working on this page. Try again when it's done."
        #expect(VersionRules.failure(APIError.server(status: 409, code: "conflict")) == busy)
        #expect(VersionRules.failure(APIError.staleVersion) == busy)
        #expect(VersionRules.failure(APIError.notFound) == "That version isn't kept any more.")
        #expect(VersionRules.failure(APIError.unreachable) == TaskBoard.reason(for: APIError.unreachable))
    }

    @Test("The listing: rows kept on a reload, a failed first load shows why, another page starts empty")
    func listing() throws {
        var listing = VersionRules.Listing()
        listing.begin("a")
        #expect(listing.phase == .loading)
        listing.failed("Offline", id: "a")
        #expect(listing.phase == .failed(reason: "Offline"))
        listing.begin("a")
        listing.loaded(ArtifactVersionList(versions: [try version("v2"), try version("v1")]), id: "a")
        #expect(listing.phase == .loaded)
        #expect(listing.undoTarget?.id == "v1")
        listing.begin("a")
        #expect(listing.phase == .loaded && listing.list.versions.count == 2)
        listing.failed("Offline", id: "a")
        #expect(listing.phase == .loaded)
        listing.restoring = "v1"
        #expect(listing.undoTarget == nil)
        listing.restoring = nil
        // An answer for a page no longer shown is dropped.
        listing.begin("b")
        #expect(listing.list.versions.isEmpty && listing.phase == .loading)
        listing.loaded(ArtifactVersionList(versions: [try version("x")]), id: "a")
        #expect(listing.list.versions.isEmpty)
    }
}

@Suite("M24 card blocks")
struct UIM24CardBlockTests {
    private typealias Tick = ChecklistTicks.Tick

    @Test("A series breaks at each null; a value alone is a dot; no values, no runs")
    func runs() {
        let runs = LineChartRules.runs([1, 2, nil, 4, nil, nil, 6, 7, 8])
        #expect(runs.map { $0.points.map(\.index) } == [[0, 1], [3], [6, 7, 8]])
        #expect(runs.map(\.isDot) == [false, true, false])
        #expect(runs[2].points.map(\.value) == [6, 7, 8])
        #expect(LineChartRules.runs([nil, nil]).isEmpty)
        #expect(LineChartRules.runs([]).isEmpty)
        #expect(LineChartRules.runs([Double.nan, 3]).map { $0.points.map(\.index) } == [[1]])
    }

    @Test("The x axis names as many labels as fit, evenly, always the newest")
    func labels() {
        #expect(LineChartRules.labelIndices(count: 0, fit: 5).isEmpty)
        #expect(LineChartRules.labelIndices(count: 4, fit: 5) == [0, 1, 2, 3])
        // 24 labels, 5 fit: every 6th from the newest.
        #expect(LineChartRules.labelIndices(count: 24, fit: 5) == [5, 11, 17, 23])
        #expect(LineChartRules.labelIndices(count: 12, fit: 7) == [1, 3, 5, 7, 9, 11])
        #expect(LineChartRules.width("W40") == 3 && LineChartRules.width("十一月") == 6)
        #expect(LineChartRules.fit(longest: 3) == 7 && LineChartRules.fit(longest: 6) == 4 && LineChartRules.fit(longest: 20) == 2)
        let weeks = (40...52).map { "W\($0)" }
        #expect(LineChartRules.labelIndices(weeks) == LineChartRules.labelIndices(count: 13, fit: 7))
    }

    @Test("A tap shows at once; one tick at a time, later taps queue; read-only items don't move")
    func ticksQueue() {
        var items = [
            CardBlock.CheckItem(text: "Passport", done: false, id: "c1"),
            CardBlock.CheckItem(text: "Charger", done: true, id: "c2"),
            CardBlock.CheckItem(text: "Status", done: false),
        ]
        var ticks = ChecklistTicks()
        ticks.tap(items[2])
        #expect(!ticks.isDone(items[2]) && ticks.wanted.isEmpty)
        ticks.tap(items[0])
        ticks.tap(items[1])
        #expect(ticks.isDone(items[0]) && !ticks.isDone(items[1]))
        let first = ticks.next(items)
        #expect(first == Tick(itemId: "c1", done: true))
        let whileSending = ticks.next(items)
        #expect(whileSending == nil)
        // The card comes back with c1 done; c2 goes next.
        items[0].done = true
        ticks.sent()
        let second = ticks.next(items)
        #expect(second == Tick(itemId: "c2", done: false))
        items[1].done = false
        ticks.sent()
        let none = ticks.next(items)
        #expect(none == nil && ticks.wanted.isEmpty && !ticks.isSending)
    }

    @Test("A row tapped again while its tick is out sends the new wish next")
    func retap() {
        var items = [CardBlock.CheckItem(text: "Passport", done: false, id: "c1")]
        var ticks = ChecklistTicks()
        ticks.tap(items[0])
        let first = ticks.next(items)
        #expect(first == Tick(itemId: "c1", done: true))
        ticks.tap(items[0])
        #expect(!ticks.isDone(items[0]))
        items[0].done = true
        ticks.sent()
        #expect(!ticks.isDone(items[0]))
        let again = ticks.next(items)
        #expect(again == Tick(itemId: "c1", done: false))
    }

    @Test("A failed tick puts every row back as the card says")
    func failure() {
        let items = [
            CardBlock.CheckItem(text: "Passport", done: false, id: "c1"),
            CardBlock.CheckItem(text: "Charger", done: false, id: "c2"),
        ]
        var ticks = ChecklistTicks()
        ticks.tap(items[0])
        ticks.tap(items[1])
        _ = ticks.next(items)
        ticks.failed()
        #expect(!ticks.isDone(items[0]) && !ticks.isDone(items[1]))
        let none = ticks.next(items)
        #expect(!ticks.isSending && none == nil)
    }
}

@Suite("M24 thumbnail disk cache")
struct UIM24ThumbnailDiskTests {
    private typealias F = M24Fixture

    private func tempFolder() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("m24-thumbs-\(UUID().uuidString)", isDirectory: true)
    }

    private func age(_ folder: URL, _ name: String, hoursAgo: Double) throws {
        // Real time: the files just written carry the real clock's mtime.
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-hoursAgo * 3600)],
                                              ofItemAtPath: folder.appendingPathComponent(name).path)
    }

    @Test("One file per artifact version and scheme; the id is escaped so it never holds \"_\"")
    func names() {
        let at = Date(timeIntervalSince1970: 1_790_000_000.123)
        let light = ThumbnailKey(artifactId: "a_b/c", version: at, dark: false)
        let dark = ThumbnailKey(artifactId: "a_b/c", version: at, dark: true)
        #expect(light.fileName == "a%5Fb%2Fc_1790000000123_l.jpg")
        #expect(dark.fileName == "a%5Fb%2Fc_1790000000123_d.jpg")
        #expect(light.memoryKey != dark.memoryKey)
        // Only the same artifact's other versions can go (either scheme), never another artifact's.
        #expect(light.isOlderVersion("a%5Fb%2Fc_1789999999000_d.jpg"))
        #expect(!light.isOlderVersion(dark.fileName))
        #expect(!light.isOlderVersion("a%5Fb%2Fc%5Fx_1789999999000_l.jpg"))
        #expect(!light.isOlderVersion("b_1789999999000_l.jpg"))
    }

    @Test("Trim: the least recently used go until the rest fit")
    func trim() {
        let entries = [
            ThumbnailTrim.Entry(name: "new", bytes: 40, lastUsed: F.now),
            ThumbnailTrim.Entry(name: "old", bytes: 40, lastUsed: F.now.addingTimeInterval(-7200)),
            ThumbnailTrim.Entry(name: "mid", bytes: 40, lastUsed: F.now.addingTimeInterval(-3600)),
        ]
        #expect(ThumbnailTrim.evictions(entries, limit: 120).isEmpty)
        #expect(ThumbnailTrim.evictions(entries, limit: 100) == ["old"])
        #expect(ThumbnailTrim.evictions(entries, limit: 50) == ["old", "mid"])
        #expect(ThumbnailTrim.evictions(entries, limit: 0) == ["old", "mid", "new"])
    }

    @Test("Saved, read back, an older version replaced, trimmed to the limit")
    func storeAndTrim() async throws {
        let folder = tempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let cache = ThumbnailDiskCache(folder: folder, limit: 250)
        let v1 = ThumbnailKey(artifactId: "a", version: F.now.addingTimeInterval(-60), dark: false)
        let v1Dark = ThumbnailKey(artifactId: "a", version: v1.version, dark: true)
        let v2 = ThumbnailKey(artifactId: "a", version: F.now, dark: false)
        let page = Data(repeating: 1, count: 100)
        #expect(await cache.data(for: v1) == nil)
        await cache.store(page, for: v1)
        await cache.store(page, for: v1Dark)
        #expect(await cache.data(for: v1) == page)
        #expect(await cache.names() == [v1Dark.fileName, v1.fileName].sorted())
        // A new version of the page: both schemes of the old one go.
        await cache.store(page, for: v2)
        #expect(await cache.names() == [v2.fileName])
        // Over the limit: the least recently used goes.
        let b = ThumbnailKey(artifactId: "b", version: F.now, dark: false)
        let c = ThumbnailKey(artifactId: "c", version: F.now, dark: false)
        await cache.store(page, for: b)
        try age(folder, v2.fileName, hoursAgo: 2)
        try age(folder, b.fileName, hoursAgo: 1)
        await cache.store(page, for: c)
        #expect(await cache.names() == [b.fileName, c.fileName].sorted())
    }

    @Test("Sign-out deletes every snapshot; a render started before it isn't saved")
    func signOut() async {
        let folder = tempFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let cache = ThumbnailDiskCache(folder: folder)
        let key = ThumbnailKey(artifactId: "a", version: F.now, dark: false)
        await cache.store(Data([1, 2, 3]), for: key, generation: 0)
        await cache.removeAll(generation: 1)
        #expect(await cache.names().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: folder.path))
        await cache.store(Data([1, 2, 3]), for: key, generation: 0)
        #expect(await cache.names().isEmpty)
        await cache.store(Data([4]), for: key, generation: 1)
        #expect(await cache.data(for: key) == Data([4]))
    }
}
