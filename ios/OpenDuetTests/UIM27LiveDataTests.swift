// M27 W4 (docs/API.md "## M27"): live dashboard data on iOS. The reducer's two clocks (a new page
// reloads, newer data alone is fetched and handed to the open page), "Refreshing..." on a
// data-only ↻ and its haptic (Stores/MakeReducer.swift), the HTML data-version reader, the
// hand-over script, Share's refetch and GET /data coalescing (Make/LiveDataRules.swift), the
// thumbnails' 30 s pacing (Make/ThumbnailPacing.swift, ThumbnailDiskCache newest), Versions'
// data rows (Make/VersionRules.swift) and the run step title (Runs/RunCopy.swift).
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private enum M27Fixture {
    static let base = Date(timeIntervalSince1970: 1_793_000_000)

    /// A dashboard whose page was saved at `page` s and whose data is at `data` (content time:
    /// the later of the page and `dataAt`). `old`: an older server (no pageUpdatedAt, data 0).
    static func dash(_ id: String = "a", page: Double = 0, data: Int = 0, dataAt: Double? = nil,
                     status: ArtifactSummary.Status = .ready, type: ArtifactType = .dashboard, old: Bool = false,
                     tab: Bool = false) -> ArtifactSummary {
        let pageAt = base.addingTimeInterval(page)
        let content = max(pageAt, base.addingTimeInterval(dataAt ?? page))
        var item = ArtifactSummary(id: id, channelId: "c1", type: type, title: "T \(id)", status: status, sourceCount: 1,
                                   refreshSchedule: nil, pinnedToTabBar: tab, createdAt: base, updatedAt: content)
        if !old {
            item.pageUpdatedAt = pageAt
            item.dataVersion = data
        }
        return item
    }

    /// The served page: the base's data element at `version` (nil: a page without data).
    static func html(_ version: Int?, body: String = "<p>Total</p>") -> String {
        guard let version else { return "<html><head></head><body>\(body)</body></html>" }
        return """
        <html><head><script data-duet-base data-duet-charts>/* charts */</script><script type="application/json" id="duet-data" data-version="\(version)" data-duet-base>{"total":\(version)}</script><script data-duet-base data-duet-data>/* runtime */</script></head><body>\(body)</body></html>
        """
    }

    static func update(_ artifact: ArtifactSummary, refresh: ArtifactWorkStatus? = nil, edit: ArtifactWorkStatus? = nil) -> DuetEvent.ArtifactUpdate {
        DuetEvent.ArtifactUpdate(artifact: artifact, buildStatus: nil, editStatus: edit, refreshStatus: refresh)
    }

    static func data(_ id: String = "a", version: Int, json: String? = "{\"total\":1}") throws -> ArtifactDataResponse {
        var object: [String: Any] = ["artifactId": id, "dataVersion": version, "dataUpdatedAt": base.formatted(.iso8601)]
        if let json { object["json"] = json }
        return try JSONCoding.decoder().decode(ArtifactDataResponse.self, from: JSONSerialization.data(withJSONObject: object))
    }

    static let working = ArtifactWorkStatus(state: .working)
    static let failed = ArtifactWorkStatus(state: .failed)

    /// The viewer (or the 4th tab) open on `artifact`, its page loaded as the store loads it.
    static func viewing(_ artifact: ArtifactSummary, slot: MakeState.Slot = .viewer, html: String? = nil) -> MakeState {
        var state = MakeState()
        state.applyList([artifact])
        let viewer = ArtifactViewerState(artifactId: artifact.id)
        if slot == .viewer { state.viewer = viewer } else { state.pinnedViewer = viewer }
        state.htmlLoaded(html ?? Self.html(artifact.dataVersion > 0 ? artifact.dataVersion : nil), version: artifact.pageVersion,
                         knownData: artifact.dataVersion, slot: slot, id: artifact.id)
        return state
    }

    /// What the dashboard's small line says: "Refreshing..." (the viewer's own spinner or the
    /// refresh's event), as ArtifactViewer.refreshing reads it.
    static func showsRefreshing(_ state: MakeState, slot: MakeState.Slot = .viewer, id: String = "a") -> Bool {
        let viewer = slot == .viewer ? state.viewer : state.pinnedViewer
        return viewer?.refreshing == true || state.work[id]?.isRefreshing == true
    }
}

@Suite("M27 two clocks")
struct UIM27ClockTests {
    private typealias F = M27Fixture

    @Test("A data-only event: no reload, no glow; dataBehind names the slot")
    func dataOnly() {
        var state = F.viewing(F.dash(data: 3))
        #expect(state.viewer?.dataShown == 3 && state.viewer?.htmlDataVersion == 3)
        let reload = state.apply(F.update(F.dash(data: 4, dataAt: 60)))
        #expect(reload.isEmpty)
        #expect(state.staleViewers().isEmpty)
        #expect(state.dataBehind() == [.viewer: "a"])
        #expect(state.viewer?.editGeneration == 0)
    }

    @Test("A page event reloads (dataBehind waits for the new HTML); both at once: reload only")
    func pageEvent() {
        var page = F.viewing(F.dash(data: 3))
        #expect(page.apply(F.update(F.dash(page: 60, data: 3))) == [.viewer])
        #expect(page.dataBehind().isEmpty)
        var both = F.viewing(F.dash(data: 3))
        #expect(both.apply(F.update(F.dash(page: 60, data: 4, dataAt: 60))) == [.viewer])
        #expect(both.dataBehind().isEmpty, "the new HTML carries the data")
        both.htmlLoaded(F.html(4), version: F.dash(page: 60).pageVersion, knownData: 4, slot: .viewer, id: "a")
        #expect(both.viewer?.editGeneration == 1 && both.viewer?.dataShown == 4)
        #expect(both.dataBehind().isEmpty)
    }

    @Test("An older server's summary (no pageUpdatedAt, data 0): every change reloads, never /data")
    func olderServer() {
        var state = F.viewing(F.dash(old: true))
        #expect(state.viewer?.dataShown == 0 && state.viewer?.htmlDataVersion == nil)
        #expect(state.apply(F.update(F.dash(page: 60, old: true))) == [.viewer])
        #expect(state.dataBehind().isEmpty)
        state.htmlLoaded(F.html(nil), version: F.dash(page: 60, old: true).pageVersion, knownData: 0, slot: .viewer, id: "a")
        #expect(state.dataBehind().isEmpty)
        // A doc or a dashboard without data behaves the same.
        var doc = F.viewing(F.dash(type: .docs))
        #expect(doc.apply(F.update(F.dash(page: 60, type: .docs))) == [.viewer])
        #expect(doc.dataBehind().isEmpty)
    }

    @Test("✎'s wait isn't ended by a data update; a new page ends it")
    func editWait() {
        var state = F.viewing(F.dash(data: 3))
        state.editing.insert("a")
        state.apply(F.update(F.dash(data: 4, dataAt: 30), edit: F.working))
        state.apply(F.update(F.dash(data: 5, dataAt: 40)))
        #expect(state.editing.contains("a"), "a data update during ✎")
        state.apply(F.update(F.dash(page: 90, data: 5, dataAt: 40)))
        #expect(!state.editing.contains("a"))
    }

    @Test("After a list load: a new page is stale (reload), newer data alone is behind (hand-over)")
    func listLoad() {
        var state = F.viewing(F.dash(data: 3))
        state.applyList([F.dash(data: 5, dataAt: 60)])
        #expect(state.staleViewers().isEmpty)
        #expect(state.dataBehind() == [.viewer: "a"])
        state.applyList([F.dash(page: 120, data: 6, dataAt: 120)])
        #expect(state.staleViewers() == [.viewer: "a"])
        #expect(state.dataBehind().isEmpty)
    }

    @Test("Data shows while an edit or refresh works (the page itself still waits)")
    func whileWorking() {
        var state = F.viewing(F.dash(data: 3))
        #expect(state.apply(F.update(F.dash(data: 4, dataAt: 20), edit: F.working)).isEmpty)
        #expect(state.dataBehind() == [.viewer: "a"])
        state.apply(F.update(F.dash(page: 60, data: 4, dataAt: 20), refresh: F.working))
        #expect(state.staleViewers().isEmpty && state.dataBehind().isEmpty, "a new page waits; then it reloads")
    }
}
@Suite("M27 fetch and hand-over")
struct UIM27HandOverTests {
    private typealias F = M27Fixture

    @Test("GET /data: a newer answer waits for the page; the hand-over raises dataShown; an older one is dropped")
    func fetchAndHandOver() throws {
        var state = F.viewing(F.dash(data: 3))
        state.apply(F.update(F.dash(data: 5, dataAt: 60)))
        #expect(state.dataFetched(try F.data(version: 2)).isEmpty)
        #expect(state.viewer?.pendingData == nil, "older than the page: dropped")
        #expect(state.dataFetched(try F.data(version: 5)).isEmpty)
        #expect(state.viewer?.pendingData?.dataVersion == 5)
        #expect(state.dataBehind().isEmpty, "the answer is on its way to the page")
        #expect(state.dataFetched(try F.data(version: 4)).isEmpty)
        #expect(state.viewer?.pendingData?.dataVersion == 5, "an older answer doesn't replace a newer one")
        let load = state.viewer?.pageLoads ?? 0
        // A hand-over answer from a page since replaced is dropped.
        let reload1 = state.handedOver(.viewer, id: "a", version: 5, load: load - 1, shown: 5)
        #expect(!reload1)
        #expect(state.viewer?.dataShown == 3)
        let reload2 = state.handedOver(.viewer, id: "a", version: 5, load: load, shown: 5)
        #expect(!reload2)
        #expect(state.viewer?.dataShown == 5 && state.viewer?.pendingData == nil)
        #expect(state.viewer?.editGeneration == 0 && state.viewer?.dataLanded == 0, "no glow, no haptic")
        #expect(state.dataBehind().isEmpty)
    }

    @Test("A failed hand-over (script error) leaves it to the next event")
    func handOverFailed() throws {
        var state = F.viewing(F.dash(data: 3))
        state.apply(F.update(F.dash(data: 4, dataAt: 60)))
        _ = state.dataFetched(try F.data(version: 4))
        let load = state.viewer?.pageLoads ?? 0
        let reload1 = state.handedOver(.viewer, id: "a", version: 4, load: load, shown: nil)
        #expect(!reload1)
        #expect(state.viewer?.pendingData == nil && state.viewer?.dataShown == 3)
        #expect(state.dataBehind() == [.viewer: "a"], "asked again by the next sync")
    }

    @Test("Fetch coalescing: one in flight per artifact; newer meanwhile = one more; the same version doesn't")
    func coalescing() {
        var fetches = LiveDataFetches()
        let start1 = fetches.ask("a", version: 4)
        #expect(start1)
        let start2 = fetches.ask("a", version: 4)
        #expect(!start2)
        let start3 = fetches.ask("b", version: 1)
        #expect(start3, "another artifact fetches at once")
        let again1 = fetches.ended("a")
        #expect(!again1, "nothing newer was asked for")
        let start4 = fetches.ask("a", version: 5)
        #expect(start4)
        let start5 = fetches.ask("a", version: 6)
        #expect(!start5)
        let start6 = fetches.ask("a", version: 7)
        #expect(!start6)
        let start7 = fetches.ask("a", version: 7)
        #expect(!start7)
        let again2 = fetches.ended("a")
        #expect(again2, "a burst of updates: one more")
        let start8 = fetches.ask("a", version: 7)
        #expect(start8)
        let again3 = fetches.ended("a")
        #expect(!again3)
        #expect(fetches.inFlight == ["b": 1])
    }

    @Test("-1 (the page has no data element): reload once for that version; still none: shown, no loop")
    func noElementReloadsOnce() throws {
        // A page built before the data existed, still on screen.
        var state = F.viewing(F.dash(data: 3), html: F.html(nil))
        #expect(state.viewer?.dataShown == 3 && state.viewer?.htmlDataVersion == nil)
        state.apply(F.update(F.dash(data: 4, dataAt: 60)))
        _ = state.dataFetched(try F.data(version: 4))
        var load = state.viewer?.pageLoads ?? 0
        let reload1 = state.handedOver(.viewer, id: "a", version: 4, load: load, shown: -1)
        #expect(reload1, "reload once")
        #expect(state.viewer?.dataReload == 4 && state.viewer?.pendingData == nil)
        #expect(state.dataBehind().isEmpty, "the reload carries it")
        let reload2 = state.handedOver(.viewer, id: "a", version: 4, load: load, shown: -1)
        #expect(!reload2, "asked already")
        // The reload: the same page, still without the element.
        state.htmlLoaded(F.html(nil), version: F.dash().pageVersion, knownData: 4, slot: .viewer, id: "a")
        #expect(state.viewer?.dataShown == 4 && state.viewer?.dataReload == nil)
        #expect(state.viewer?.editGeneration == 0, "a reload of the same page doesn't glow or buzz")
        #expect(state.dataBehind().isEmpty)
        // A later -1 for that version (a late answer) takes it as shown: no second reload.
        load = state.viewer?.pageLoads ?? 0
        let reload3 = state.handedOver(.viewer, id: "a", version: 4, load: load, shown: -1)
        #expect(!reload3)
    }

    @Test("json nil (the data was cleared): reload once; the page without data is taken as shown")
    func clearedData() throws {
        var state = F.viewing(F.dash(data: 3))
        state.apply(F.update(F.dash(data: 4, dataAt: 60)))
        #expect(state.dataFetched(try F.data(version: 4, json: nil)) == [.viewer])
        #expect(state.dataFetched(try F.data(version: 4, json: nil)).isEmpty, "one reload per version")
        state.htmlLoaded(F.html(nil), version: F.dash().pageVersion, knownData: 4, slot: .viewer, id: "a")
        #expect(state.viewer?.dataShown == 4 && state.viewer?.htmlDataVersion == nil)
        #expect(state.dataBehind().isEmpty)
    }

    @Test("The 4th tab: the same rules (hand-over, reload once, staleness)")
    func pinnedSlot() throws {
        var state = F.viewing(F.dash(data: 3, tab: true), slot: .pinned)
        state.apply(F.update(F.dash(data: 4, dataAt: 60, tab: true)))
        #expect(state.dataBehind() == [.pinned: "a"])
        _ = state.dataFetched(try F.data(version: 4))
        #expect(state.pinnedViewer?.pendingData?.dataVersion == 4)
        let load = state.pinnedViewer?.pageLoads ?? 0
        let reload1 = state.handedOver(.pinned, id: "a", version: 4, load: load, shown: 4)
        #expect(!reload1)
        #expect(state.pinnedViewer?.dataShown == 4)
        #expect(state.apply(F.update(F.dash(page: 90, data: 4, dataAt: 60, tab: true))) == [.pinned])
        #expect(state.dataBehind().isEmpty)
    }

    @Test("Restore: a data-only version updates the page in place; a page version reloads it")
    func restore() {
        var state = F.viewing(F.dash(page: 0, data: 6, dataAt: 100))
        // Undo of a data update: same pageUpdatedAt, newer dataVersion.
        #expect(state.apply(F.update(F.dash(page: 0, data: 7, dataAt: 200))).isEmpty)
        #expect(state.dataBehind() == [.viewer: "a"])
        // Restoring an older page: the page moves.
        #expect(state.apply(F.update(F.dash(page: 300, data: 8, dataAt: 300))) == [.viewer])
    }
}

@Suite("M27 Refreshing... and the haptic")
struct UIM27RefreshTests {
    private typealias F = M27Fixture

    /// ↻ on a data dashboard up to the server's answer (`ready`: the refresh is queued).
    private func tapped() -> MakeState {
        var state = F.viewing(F.dash(data: 3))
        state.askRefresh("a")
        #expect(F.showsRefreshing(state) && state.viewer?.refreshWait == .asked)
        #expect(state.refreshAnswered(F.dash(data: 3)).isEmpty)
        return state
    }

    @Test("POST ready → working → ready with data +1: \"Refreshing...\" then in place, the haptic when it is on the page")
    func dataOnlyRefresh() throws {
        var state = tapped()
        state.apply(F.update(F.dash(data: 3, dataAt: 1), refresh: F.working))
        #expect(F.showsRefreshing(state) && state.viewer?.refreshWait == .running)
        #expect(state.apply(F.update(F.dash(data: 4, dataAt: 90))).isEmpty, "no reload: the page stays")
        #expect(!F.showsRefreshing(state), "Updated now")
        #expect(state.viewer?.refreshWait == .landing(4) && state.viewer?.dataLanded == 0)
        _ = state.dataFetched(try F.data(version: 4))
        let reload1 = state.handedOver(.viewer, id: "a", version: 4, load: state.viewer?.pageLoads ?? 0, shown: 4)
        #expect(!reload1)
        #expect(state.viewer?.dataLanded == 1 && state.viewer?.refreshWait == nil)
        #expect(state.viewer?.editGeneration == 0)
    }

    @Test("The final event missed: the list load ends \"Refreshing...\"")
    func finalEventMissed() {
        var state = tapped()
        state.apply(F.update(F.dash(data: 3, dataAt: 1), refresh: F.working))
        #expect(F.showsRefreshing(state))
        // resync: the stream skipped the end; the list has the new data.
        state.forgetWork()
        state.applyList([F.dash(data: 4, dataAt: 90)])
        #expect(!F.showsRefreshing(state))
        #expect(state.dataBehind() == [.viewer: "a"])
        #expect(state.viewer?.refreshWait == nil, "its end was skipped: no haptic rather than a wrong one")
    }

    @Test("Before the POST answers, the viewer's own spinner; a refresh with nothing new ends without a haptic")
    func unchangedRefresh() {
        var state = F.viewing(F.dash(data: 3))
        state.askRefresh("a")
        state.apply(F.update(F.dash(data: 3, dataAt: 1), refresh: F.working))
        #expect(state.refreshAnswered(F.dash(data: 3, dataAt: 1)).isEmpty)
        #expect(F.showsRefreshing(state))
        state.apply(F.update(F.dash(data: 3, dataAt: 2)))
        #expect(!F.showsRefreshing(state) && state.viewer?.refreshWait == nil && state.viewer?.dataLanded == 0)
    }

    @Test("Data a task pushes never buzzes: not with no ↻, not while a ↻ works, not before it is reported working")
    func taskData() throws {
        var idle = F.viewing(F.dash(data: 3))
        idle.apply(F.update(F.dash(data: 4, dataAt: 30)))
        _ = idle.dataFetched(try F.data(version: 4))
        _ = idle.handedOver(.viewer, id: "a", version: 4, load: idle.viewer?.pageLoads ?? 0, shown: 4)
        #expect(idle.viewer?.dataLanded == 0)

        var during = tapped()
        during.apply(F.update(F.dash(data: 3, dataAt: 1), refresh: F.working))
        during.apply(F.update(F.dash(data: 4, dataAt: 30), refresh: F.working))
        #expect(during.viewer?.refreshWait == .running, "a task's update while the refresh works isn't its data")
        #expect(F.showsRefreshing(during))

        var early = F.viewing(F.dash(data: 3))
        early.askRefresh("a")
        early.apply(F.update(F.dash(data: 4, dataAt: 30)))
        #expect(early.viewer?.refreshWait == nil && early.viewer?.dataLanded == 0)
    }

    @Test("A failed ↻ (POST or the refresh): \"Refreshing...\" ends, nothing waits")
    func failed() {
        var post = F.viewing(F.dash(data: 3))
        post.askRefresh("a")
        post.endRefresh("a")
        #expect(!F.showsRefreshing(post) && post.viewer?.refreshWait == nil)
        var refresh = tapped()
        refresh.apply(F.update(F.dash(data: 3, dataAt: 1), refresh: F.working))
        refresh.apply(F.update(F.dash(data: 3, dataAt: 2), refresh: F.failed))
        #expect(!F.showsRefreshing(refresh) && refresh.viewer?.refreshWait == nil)
    }

    @Test("A whole-page refresh (a dashboard without data) reloads with its own haptic, as before")
    func pageRefresh() {
        var state = F.viewing(F.dash())
        state.askRefresh("a")
        _ = state.refreshAnswered(F.dash())
        state.apply(F.update(F.dash(dataAt: 1), refresh: F.working))
        #expect(state.apply(F.update(F.dash(page: 90))) == [.viewer])
        state.htmlLoaded(F.html(nil), version: F.dash(page: 90).pageVersion, knownData: 0, slot: .viewer, id: "a")
        #expect(state.viewer?.editGeneration == 1 && state.viewer?.dataLanded == 0 && !F.showsRefreshing(state))
        #expect(state.viewer?.refreshWait == nil)
    }
}
@Suite("M27 live data rules")
struct UIM27LiveDataRuleTests {
    private typealias F = M27Fixture

    @Test("The HTML data-version: the injected element; none on a page without data or one that only mentions it")
    func reader() {
        #expect(LiveDataRules.htmlDataVersion(F.html(12)) == 12)
        #expect(LiveDataRules.htmlDataVersion(F.html(nil)) == nil)
        #expect(LiveDataRules.htmlDataVersion("") == nil)
        // A page whose text and code mention duet-data.
        let mentions = """
        <html><head><script>const el = document.getElementById("duet-data"); var s = '<script type="application/json" id="duet-data" data-version="99">';</script>\
        <style>#duet-data { color: red }</style></head>\
        <body><!-- <script type="application/json" id="duet-data" data-version="98"></script> -->\
        <p>The &lt;script id="duet-data"&gt; element holds duet-data.</p><pre>id="duet-data" data-version="97"</pre></body></html>
        """
        #expect(LiveDataRules.htmlDataVersion(mentions) == nil)
        #expect(LiveDataRules.htmlDataVersion(mentions + F.html(5)) == 5, "the real element after them still counts")
        // Another script type with the id isn't the data element.
        #expect(LiveDataRules.htmlDataVersion(#"<script id="duet-data" data-version="3">x</script>"#) == nil)
        // Attribute order, case and quotes as HTML allows; a bad or missing number reads 0.
        #expect(LiveDataRules.htmlDataVersion(#"<SCRIPT data-version='7' TYPE="Application/JSON" ID="duet-data">{}</SCRIPT>"#) == 7)
        #expect(LiveDataRules.htmlDataVersion(#"<script type=application/json id=duet-data data-version=8>{}</script>"#) == 8)
        #expect(LiveDataRules.htmlDataVersion(#"<script type="application/json" id="duet-data" data-version="x">{}</script>"#) == 0)
        #expect(LiveDataRules.htmlDataVersion(#"<script type="application/json" id="duet-data">{}</script>"#) == 0)
        // An unclosed tag at the end reads as none.
        #expect(LiveDataRules.htmlDataVersion(#"<p>duet-data</p><script type="application/json" id="duet-data""#) == nil)
    }

    @Test("The hand-over script: ArtifactLiveData's names, text before the attribute before the event; no data in it")
    func script() {
        let script = LiveDataRules.handOverScript
        #expect(script.contains("getElementById(\"\(ArtifactLiveData.elementId)\")"))
        #expect(script.contains("getAttribute(\"\(ArtifactLiveData.versionAttribute)\")"))
        #expect(script.contains("new Event(\"\(ArtifactLiveData.event)\")"))
        #expect(script.contains("return -1"))
        let text = script.range(of: "el.textContent = json")
        let attribute = script.range(of: "el.setAttribute(")
        let event = script.range(of: "document.dispatchEvent(")
        #expect(text != nil && attribute != nil && event != nil)
        if let text, let attribute, let event {
            #expect(text.lowerBound < attribute.lowerBound && attribute.lowerBound < event.lowerBound)
        }
        // The data and its version go in as arguments, exactly as received.
        let json = #"{"total":312,"note":"</script><b>"}"#
        let arguments = LiveDataRules.handOverArguments(json: json, version: 11)
        #expect(arguments["json"] as? String == json)
        #expect(arguments["version"] as? Int == 11)
        #expect(arguments.count == 2)
        #expect(!script.contains("312") && !script.contains("total"))
    }

    @Test("Share: the page again once hand-overs moved past the HTML loaded")
    func shareRefetch() {
        #expect(LiveDataRules.shareNeedsFetch(dataShown: 5, htmlDataVersion: 3))
        #expect(!LiveDataRules.shareNeedsFetch(dataShown: 3, htmlDataVersion: 3))
        #expect(!LiveDataRules.shareNeedsFetch(dataShown: nil, htmlDataVersion: 3))
        #expect(!LiveDataRules.shareNeedsFetch(dataShown: 4, htmlDataVersion: nil), "a page without data: as loaded")
        // In the reducer: after a hand-over the loaded HTML is behind.
        var state = F.viewing(F.dash(data: 3))
        state.apply(F.update(F.dash(data: 4, dataAt: 60)))
        _ = try? state.dataFetched(F.data(version: 4))
        _ = state.handedOver(.viewer, id: "a", version: 4, load: state.viewer?.pageLoads ?? 0, shown: 4)
        #expect(LiveDataRules.shareNeedsFetch(dataShown: state.viewer?.dataShown, htmlDataVersion: state.viewer?.htmlDataVersion))
    }
}

@Suite("M27 thumbnails")
struct UIM27ThumbnailTests {
    private typealias F = M27Fixture

    private func shown(page: Double = 0, data: Int = 3, renderedAt: Double) -> ThumbnailPacing.Shown {
        let summary = F.dash(page: page, data: data, dataAt: 10)
        return ThumbnailPacing.Shown(key: ThumbnailKey(artifactId: "a", version: summary.updatedAt, dark: false),
                                     pageVersion: summary.pageVersion, dataVersion: data, status: .ready,
                                     renderedAt: F.base.addingTimeInterval(renderedAt))
    }

    @Test("Pacing: a page change now; a data change within 30 s waits the rest; after 30 s now; a status change now")
    func pacing() {
        let now = F.base.addingTimeInterval(100)
        let snap = shown(renderedAt: 90)
        #expect(ThumbnailPacing.decide(shown: nil, artifact: F.dash(data: 4, dataAt: 95), now: now) == .now)
        #expect(ThumbnailPacing.decide(shown: snap, artifact: F.dash(data: 4, dataAt: 95), now: now) == .wait(20))
        #expect(ThumbnailPacing.decide(shown: shown(renderedAt: 60), artifact: F.dash(data: 4, dataAt: 95), now: now) == .now)
        #expect(ThumbnailPacing.decide(shown: shown(renderedAt: 70), artifact: F.dash(data: 4, dataAt: 95), now: now) == .now)
        #expect(ThumbnailPacing.decide(shown: snap, artifact: F.dash(page: 95, data: 4, dataAt: 95), now: now) == .now)
        #expect(ThumbnailPacing.decide(shown: snap, artifact: F.dash(data: 4, dataAt: 95, status: .failed), now: now) == .now)
        // Read from disk after a cold start (nothing known): now.
        var disk = snap
        disk.pageVersion = nil
        disk.renderedAt = .distantPast
        #expect(ThumbnailPacing.decide(shown: disk, artifact: F.dash(data: 4, dataAt: 95), now: now) == .now)
    }

    @Test("The newest snapshot on disk of an artifact (the file name format kept)")
    func newestName() {
        let at = Date(timeIntervalSince1970: 1_790_000_000.123)
        let key = ThumbnailKey(artifactId: "a_b/c", version: at, dark: true)
        let parsed = ThumbnailKey(fileName: key.fileName)
        #expect(parsed?.artifactId == "a_b/c" && parsed?.dark == true && parsed?.fileName == key.fileName)
        #expect(ThumbnailKey(fileName: "notes.txt") == nil && ThumbnailKey(fileName: "a_x_l.jpg") == nil)
        let names = ["a%5Fb%2Fc_1789999999000_d.jpg", key.fileName, "a%5Fb%2Fc_1790000000500_l.jpg", "b_1790000009000_d.jpg"]
        #expect(ThumbnailKey.newest("a_b/c", dark: true, in: names)?.name == key.fileName)
        #expect(ThumbnailKey.newest("a_b/c", dark: false, in: names)?.name == "a%5Fb%2Fc_1790000000500_l.jpg")
        #expect(ThumbnailKey.newest("zzz", dark: true, in: names) == nil)
    }

    @Test("The disk cache answers the newest of an artifact, whatever its version")
    func newestOnDisk() async {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("m27-thumbs-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let cache = ThumbnailDiskCache(folder: folder)
        let key = ThumbnailKey(artifactId: "a", version: F.base, dark: false)
        #expect(await cache.newest("a", dark: false) == nil)
        await cache.store(Data([7]), for: key)
        let found = await cache.newest("a", dark: false)
        #expect(found?.key.fileName == key.fileName && found?.data == Data([7]))
        #expect(await cache.newest("a", dark: true) == nil)
    }
}

@Suite("M27 versions and run step")
struct UIM27VersionTests {
    private func version(_ reason: String, by: String = "assistant", updates: Int? = nil) throws -> ArtifactVersion {
        var object: [String: Any] = ["id": "v", "artifactId": "a", "by": by, "reason": reason,
                                     "createdAt": M27Fixture.base.formatted(.iso8601)]
        if let updates { object["dataUpdates"] = updates }
        return try JSONCoding.decoder().decode(ArtifactVersion.self, from: JSONSerialization.data(withJSONObject: object))
    }

    @Test("Data rows: their own label; \"5 updates\" for merged ones, nothing for one")
    func dataRows() throws {
        #expect(VersionRules.label(try version("data", updates: 5)) == .dataUpdated(.assistant))
        #expect(VersionRules.label(try version("data", by: "user", updates: 1)) == .dataUpdated(.you))
        #expect(VersionRules.label(try version("data", by: "robot")) == .dataUpdated(nil))
        #expect(VersionRules.updates(try version("data", updates: 5)) == 5)
        #expect(VersionRules.updates(try version("data", updates: 1)) == nil)
        #expect(VersionRules.updates(try version("data")) == nil, "an older server")
        #expect(VersionRules.updates(try version("edit", updates: 3)) == nil)
    }

    @Test("Versions load once at a time; a burst of data updates ends in one more load")
    func coalescedLoads() throws {
        var listing = VersionRules.Listing()
        let start1 = listing.begin("a")
        #expect(start1)
        #expect(!listing.begin("a") && !listing.begin("a") && !listing.begin("a"))
        #expect(listing.loaded(ArtifactVersionList(versions: [try version("data", updates: 2)]), id: "a"), "one more")
        let start2 = listing.begin("a")
        #expect(start2)
        #expect(!listing.loaded(ArtifactVersionList(versions: [try version("data", updates: 3)]), id: "a"))
        #expect(listing.list.versions.first?.dataUpdates == 3)
        let start3 = listing.begin("a")
        #expect(start3)
        #expect(!listing.cancelled("a") && !listing.inFlight)
    }

    @Test("Run step: update_artifact_data reads \"Updated dashboard data\"")
    func runStep() {
        #expect(RunCopy.title(key: "run.step.artifact_data")?.key == "Updated dashboard data")
        #expect(RunCopy.contractKeys.contains("run.step.artifact_data"))
    }
}
