// The Make tab's state changes (prompt L147-L152), kept pure so they run in the Mac host tests:
// the gallery list merged with live `artifact` events (a newer version always wins), the Build
// view's status line and its hand-over to the viewer, "Just made", the viewers' reloads when a
// newer version is ready (edits by ✎ or chat re-render in place, L181), and the optimistic
// one-pinned-at-a-time Add to tab bar. M9: long-press Delete (optimistic, put back on failure).
// M10: long-press Pin / Unpin in Make (any number; pinned first, newest pin first, then the
// usual newest first), optimistic with rollback and independent of Add to tab bar.
// M21: an edit or refresh of a page already made keeps it `ready`; the event's editStatus /
// refreshStatus (MakeState.work) say the assistant is working on it or why it gave up.
// M24: `lastOpenedAt` ("Just made" until the first open) only moves forward, an open marks it at
// once, and viewers behind the list (a missed event) reload.
// M27: two clocks. A newer `pageVersion` reloads the page as before; a newer `dataVersion` alone
// is fetched (GET /data) and handed to the open page in place: no reload, no glow, no haptic
// (dataBehind / dataFetched / handedOver). A data-only ↻ ends "Refreshing..." when its data
// lands, and only a ↻ tapped in the viewer gets the success haptic (RefreshWait).
// Foundation + model types only.
import Foundation

/// M21: the assistant changing a page that is already made (MakeState.work).
struct ArtifactWork: Hashable, Sendable {
    /// an edit (✎, Comment, or asked in the chat)
    var edit: ArtifactWorkStatus?
    /// a refresh (its schedule, or ↻)
    var refresh: ArtifactWorkStatus?

    var isEmpty: Bool { edit == nil && refresh == nil }
    var isEditing: Bool { edit?.state == .working }
    var isRefreshing: Bool { refresh?.state == .working }
    var editFailed: Bool { edit?.state == .failed }
    var refreshFailed: Bool { refresh?.state == .failed }
}

extension MakeState {
    /// Which viewer needs the HTML of a newer version.
    enum Slot: Hashable, Sendable { case viewer, pinned }

    // MARK: - List

    /// GET /api/artifacts answered: the list, keeping any live copy that is newer than it.
    mutating func applyList(_ list: [ArtifactSummary]) {
        // M21: the first list of the session (cold load) doesn't carry editStatus / refreshStatus,
        // and the server keeps them in memory only: a "working" replayed from before a server
        // restart would never end. Gone; a job still running says so again with its next event.
        if phase != .loaded { dropWorking() }
        let live = Dictionary(artifacts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        // M27: what the open viewers' artifacts had, so a newer dataVersion in the list (its
        // final event missed) still ends a data-only ↻'s "Refreshing...".
        let shownIds = [viewer?.artifactId, pinnedViewer?.artifactId].compactMap { $0 }
        let dataBefore = Dictionary(shownIds.compactMap { id in live[id].map { (id, $0.dataVersion) } }, uniquingKeysWith: { a, _ in a })
        artifacts = list.map { item in
            guard let current = live[item.id] else { return item }
            var merged = item
            if current.updatedAt > item.updatedAt {
                merged = current
            } else if requests[RequestKey.pinInMake(item.id)] == .inFlight {
                // M10: a Pin / Unpin still in flight keeps what the user just chose.
                merged.pinned = current.pinned
            }
            // M24: an open is never undone (a list read before it says null).
            merged.lastOpenedAt = Self.newer(current.lastOpenedAt, item.lastOpenedAt)
            return merged
        }
        // Items made in this session that the list doesn't have yet (a build just started).
        for item in live.values where !artifacts.contains(where: { $0.id == item.id }) && (justMade.contains(item.id) || firstBuilds.contains(item.id)) {
            artifacts.append(item)
        }
        // A build already running when the list loads is taken as a first build.
        for item in list where item.status == .building && live[item.id] == nil { firstBuilds.insert(item.id) }
        // The server lists pinned ones first, newest pin first; a pin in flight stays in front.
        let pinnedNow = Set(artifacts.filter(\.pinned).map(\.id))
        let pending = pinOrder.filter { pinnedNow.contains($0) && requests[RequestKey.pinInMake($0)] == .inFlight }
        let served = list.map(\.id).filter { pinnedNow.contains($0) && !pending.contains($0) }
        pinOrder = pending + served
        pinOrder += artifacts.filter { $0.pinned && !pinOrder.contains($0.id) }.map(\.id)
        sortGallery()
        justMade = justMade.filter { id in artifacts.contains { $0.id == id } }
        phase = .loaded
        refreshing = false
        refreshFailure = nil
        for (id, before) in dataBefore {
            if let now = artifact(id) { noteData(now, previous: before) }
        }
    }

    mutating func failList(reason: String) {
        refreshing = false
        // A reload that fails keeps the gallery on screen with the reason above it.
        if phase == .loaded { refreshFailure = reason } else { phase = .failed(reason: reason) }
    }

    // MARK: - Events and answers

    /// An `artifact` event (or a POST / PATCH answer, buildStatus nil): upserts the summary,
    /// tracks the Build view's status line and returns the viewers that should reload their HTML.
    @discardableResult
    mutating func apply(_ artifact: ArtifactSummary, buildStatus status: Phrase? = nil, now: Date = .now) -> Set<Slot> {
        let previous = self.artifact(artifact.id)
        // Content time: an event older than the copy shown changes nothing (M27: data too).
        if let previous, previous.updatedAt > artifact.updatedAt { return [] }
        var artifact = artifact
        // M10: a Pin / Unpin still in flight keeps what the user just chose.
        if let previous, requests[RequestKey.pinInMake(artifact.id)] == .inFlight { artifact.pinned = previous.pinned }
        // M24: an event with the same updatedAt sent before an open must not bring "Just made" back.
        artifact.lastOpenedAt = Self.newer(previous?.lastOpenedAt, artifact.lastOpenedAt)
        // First seen building: a new artifact (an edit or ↻ of a known one is not).
        if previous == nil, artifact.status == .building { firstBuilds.insert(artifact.id) }
        if let index = artifacts.firstIndex(where: { $0.id == artifact.id }) {
            artifacts[index] = artifact
        } else {
            artifacts.append(artifact)
        }
        // A pin from elsewhere (another device, the assistant) goes to the front, like the server's order.
        if artifact.pinned, !pinOrder.contains(artifact.id) { pinOrder.insert(artifact.id, at: 0) }
        if !artifact.pinned { pinOrder.removeAll { $0 == artifact.id } }
        sortGallery()
        if artifact.pinnedToTabBar {
            // One pinned at a time: the server unpins the previous one (its event may come later).
            for index in artifacts.indices where artifacts[index].id != artifact.id && artifacts[index].pinnedToTabBar {
                if artifacts[index].updatedAt <= artifact.updatedAt { artifacts[index].pinnedToTabBar = false }
            }
        }
        if pinnedViewer != nil, pinned?.id != pinnedViewer?.artifactId { pinnedViewer = nil }

        switch artifact.status {
        case .building:
            if let status { buildStatus[artifact.id] = status }
            return []
        case .failed:
            if let status { buildStatus[artifact.id] = status }
            editing.remove(artifact.id)
            endRefresh(artifact.id)
            return []
        case .ready:
            buildStatus[artifact.id] = nil
            if firstBuilds.remove(artifact.id) != nil, build != artifact.id {
                // A new one finished while the user was elsewhere: "Just made" (L150).
                justMade.insert(artifact.id)
            }
            // M21: an edit keeps the page `ready` while the assistant works on it (editStatus says so),
            // so only a newer version ends ✎'s wait (the answer to ✎, the same version, doesn't),
            // and not while an edit is still reported working. M27: a newer page; a data update
            // during ✎ doesn't end its wait.
            let newer = previous.map { artifact.pageVersion > $0.pageVersion } ?? true
            if newer, work[artifact.id]?.isEditing != true { editing.remove(artifact.id) }
            noteData(artifact, previous: previous?.dataVersion)
            if build == artifact.id {
                // Watching the Build view: it hands over to the viewer. M24: that counts as opened
                // (the viewer's first load fetches the detail, which records it on the server).
                build = nil
                viewer = ArtifactViewerState(artifactId: artifact.id)
                markOpened(artifact.id, at: now)
                return [.viewer]
            }
            // M21: nothing new to show while an edit or a refresh is still going or just failed
            // (the last version stays, with the failure over it).
            guard work[artifact.id] == nil else { return [] }
            var reload: Set<Slot> = []
            if let viewer, viewer.artifactId == artifact.id, viewer.isStale(for: artifact) { reload.insert(.viewer) }
            if let pinnedViewer, pinnedViewer.artifactId == artifact.id, pinnedViewer.isStale(for: artifact) { reload.insert(.pinned) }
            return reload
        }
    }

    /// M21: an `artifact` event whole: what the assistant is doing to the page (editStatus /
    /// refreshStatus) first, then the summary as before. An event older than the copy shown
    /// changes nothing; a newer one replaces the work state, nil statuses clearing it (so an app
    /// talking to an older server, which never sends them, keeps none).
    @discardableResult
    mutating func apply(_ update: DuetEvent.ArtifactUpdate, now: Date = .now) -> Set<Slot> {
        let id = update.artifact.id
        if let previous = artifact(id), previous.updatedAt > update.artifact.updatedAt { return [] }
        let wasRefreshing = work[id]?.isRefreshing == true
        let next = ArtifactWork(edit: update.editStatus, refresh: update.refreshStatus)
        work[id] = next.isEmpty ? nil : next
        if next.edit?.state == .failed { editing.remove(id) }
        if next.refresh != nil { setRefreshing(false, id: id) }
        // M27: a ↻ tapped here is now reported working (only then can its data count as its own),
        // or it gave up.
        if next.isRefreshing { waitRefresh(id) { $0 == .asked ? .running : $0 } }
        if next.refreshFailed { waitRefresh(id) { _ in nil } }
        let reload = apply(update.artifact, buildStatus: update.buildStatus, now: now)
        // A refresh that ended without newer data (unchanged, or a whole page that reloads with
        // its own haptic): nothing more to wait for.
        if wasRefreshing, next.refresh == nil { waitRefresh(id) { $0?.waitsForEvents == true ? nil : $0 } }
        return reload
    }

    /// M21 resync: events were skipped, so a "working" may never be cleared (and a failure may
    /// be outdated); the next event for the page says again what is going on. M27: a ↻ whose
    /// end may have been skipped no longer waits for it (no haptic rather than a wrong one).
    mutating func forgetWork() {
        work = [:]
        for id in [viewer?.artifactId, pinnedViewer?.artifactId].compactMap({ $0 }) {
            waitRefresh(id) { $0?.waitsForEvents == true ? nil : $0 }
        }
    }

    /// M21 cold load: every "working" goes (the server may have restarted since its event, and
    /// then no final event comes); a failure stays, it is final.
    mutating func dropWorking() {
        for (id, var entry) in work {
            if entry.isEditing { entry.edit = nil }
            if entry.isRefreshing { entry.refresh = nil }
            work[id] = entry.isEmpty ? nil : entry
        }
    }

    /// M21: ✎ / Comment or ↻ tried again: the last one's failure leaves the viewer at once (the
    /// next event reports the new attempt).
    mutating func retryWork(_ id: String, edit: Bool) {
        guard var current = work[id] else { return }
        if edit, current.editFailed { current.edit = nil }
        if !edit, current.refreshFailed { current.refresh = nil }
        work[id] = current.isEmpty ? nil : current
    }

    /// Whether `id` is a first build (the Build view), not an edit or ↻ of a page already made
    /// (the viewer keeps showing the last version meanwhile).
    /// A failed first build stays in the Build view too (its reason with Retry).
    func isFirstBuild(_ id: String) -> Bool {
        guard firstBuilds.contains(id), let status = artifact(id)?.status else { return false }
        return status != .ready
    }

    /// POST /api/artifacts answered: the Build view opens on it.
    mutating func created(_ artifact: ArtifactSummary) {
        apply(artifact)
        if artifact.status == .building { firstBuilds.insert(artifact.id) }
        requests[RequestKey.create] = nil
        viewer = nil
        build = artifact.status == .ready ? nil : artifact.id
        if artifact.status == .ready { viewer = ArtifactViewerState(artifactId: artifact.id) }
    }

    // MARK: - Build view and viewer

    /// Gallery item / chat card / duet:// link: the Build view while building, else the viewer.
    /// Returns true when the viewer needs loading.
    mutating func open(_ id: String, now: Date = .now) -> Bool {
        justMade.remove(id)
        if isFirstBuild(id) {
            build = id
            viewer = nil
            return false
        }
        build = nil
        // M24: "Just made" goes at once (the viewer's GET /api/artifacts/:id records it).
        markOpened(id, at: now)
        if let viewer, viewer.artifactId == id, case .ready = viewer.phase { return false }
        viewer = ArtifactViewerState(artifactId: id)
        return true
    }

    /// M24: opened now (the gallery drops "Just made" before the server's answer says so).
    mutating func markOpened(_ id: String, at now: Date) {
        guard let index = artifacts.firstIndex(where: { $0.id == id }) else { return }
        artifacts[index].lastOpenedAt = Self.newer(artifacts[index].lastOpenedAt, now)
    }

    /// M24: the viewers whose page is older than the gallery's ready copy (an `artifact` event was
    /// missed, e.g. a restore while the stream was down): GET /api/artifacts answered, so they
    /// reload. Not while an edit or refresh is going on or just failed (as for events).
    func staleViewers() -> [Slot: String] {
        var out: [Slot: String] = [:]
        let shownBySlot: [(Slot, ArtifactViewerState?)] = [(.viewer, viewer), (.pinned, pinnedViewer)]
        for (slot, shown) in shownBySlot {
            guard let shown, case .ready = shown.phase, let loaded = shown.loadedVersion,
                  let current = artifact(shown.artifactId), current.status == .ready,
                  work[shown.artifactId] == nil, current.pageVersion > loaded else { continue }
            out[slot] = shown.artifactId
        }
        return out
    }

    /// M27: the ready viewers whose page is current but whose numbers are behind the gallery's
    /// ready copy (`dataVersion` above what the page shows or is about to): GET /data and hand it
    /// over. Unlike `staleViewers` this doesn't wait for an edit or refresh to end (the numbers
    /// show while the assistant works on the page); a stale viewer reloads instead (the new HTML carries
    /// the data).
    func dataBehind() -> [Slot: String] {
        var out: [Slot: String] = [:]
        let shownBySlot: [(Slot, ArtifactViewerState?)] = [(.viewer, viewer), (.pinned, pinnedViewer)]
        for (slot, shown) in shownBySlot {
            guard let shown, case .ready = shown.phase, let current = artifact(shown.artifactId),
                  current.status == .ready, !shown.isStale(for: current),
                  current.dataVersion > shown.dataKnown else { continue }
            out[slot] = shown.artifactId
        }
        return out
    }

    /// M27: GET /data answered. Each ready viewer of the artifact that doesn't know this version
    /// yet takes it (`pendingData`, handed to the page by the view); an older answer is dropped.
    /// `json` nil (the data was cleared, e.g. a restore of a version from before M27): those
    /// viewers reload once. Returns the slots to reload.
    mutating func dataFetched(_ response: ArtifactDataResponse) -> Set<Slot> {
        var reload: Set<Slot> = []
        for slot in [Slot.viewer, .pinned] {
            update(slot, id: response.artifactId) { viewer in
                guard case .ready = viewer.phase, response.dataVersion > viewer.dataKnown else { return }
                if response.json != nil {
                    viewer.pendingData = response
                } else if viewer.noData(response.dataVersion) {
                    reload.insert(slot)
                }
            }
        }
        return reload
    }

    /// M27: the page in `slot` answered the hand-over of `version`, run on its `load`-th HTML
    /// load: `shown` the version it shows now, -1 it has no data element (reload once for that
    /// version), nil the script failed (the next event or list load tries again). Returns
    /// whether to reload the page. An answer from a page since replaced is dropped.
    mutating func handedOver(_ slot: Slot, id: String, version: Int, load: Int, shown: Int?) -> Bool {
        var reload = false
        update(slot, id: id) { viewer in
            guard case .ready = viewer.phase, viewer.pageLoads == load else { return }
            guard let shown else {
                if viewer.pendingData?.dataVersion == version { viewer.pendingData = nil }
                return
            }
            if shown < 0 {
                reload = viewer.noData(version)
                return
            }
            viewer.dataShown = max(viewer.dataShown ?? 0, shown)
            if let pending = viewer.pendingData, pending.dataVersion <= shown { viewer.pendingData = nil }
            viewer.landIfShown()
        }
        return reload
    }

    /// M27 ↻ tapped: "Refreshing..." at once, and this viewer waits for its data (the haptic).
    mutating func askRefresh(_ id: String) {
        setRefreshing(true, id: id)
        waitRefresh(id) { _ in .asked }
    }

    /// M27: a ↻ that didn't go through or gave up: "Refreshing..." ends, nothing to wait for.
    mutating func endRefresh(_ id: String) {
        setRefreshing(false, id: id)
        waitRefresh(id) { _ in nil }
    }

    /// ↻'s POST answered with the summary as it is (`ready`: the refresh is queued; `building`:
    /// the page never got HTML). Returns the viewers to reload. M21: with nothing to reload the
    /// viewer's own spinner stops; the refresh's events say "Refreshing..." from here on.
    mutating func refreshAnswered(_ artifact: ArtifactSummary) -> Set<Slot> {
        let reload = apply(artifact)
        if artifact.status != .building && reload.isEmpty { setRefreshing(false, id: artifact.id) }
        return reload
    }

    /// M27: a ready summary with a newer `dataVersion` and no refresh working on it (an event, a
    /// POST answer or the list): the data-only ↻ that brought it is done (no `htmlLoaded` comes),
    /// so "Refreshing..." ends; a ↻ tapped here and reported working now waits for that version
    /// to be on the page (the haptic). Data a task or chat pushed never counts as a ↻'s.
    mutating func noteData(_ artifact: ArtifactSummary, previous: Int?) {
        guard artifact.status == .ready, let previous, artifact.dataVersion > previous,
              work[artifact.id]?.refresh == nil else { return }
        let version = artifact.dataVersion
        for slot in [Slot.viewer, .pinned] {
            update(slot, id: artifact.id) { viewer in
                viewer.refreshing = false
                if viewer.refreshWait == .running {
                    viewer.refreshWait = .landing(version)
                    viewer.landIfShown()
                } else if viewer.refreshWait == .asked {
                    viewer.refreshWait = nil
                }
            }
        }
    }

    /// M27: the ↻ wait of every viewer showing `id`.
    mutating func waitRefresh(_ id: String, _ change: (ArtifactViewerState.RefreshWait?) -> ArtifactViewerState.RefreshWait?) {
        for slot in [Slot.viewer, .pinned] {
            update(slot, id: id) { $0.refreshWait = change($0.refreshWait) }
        }
    }

    /// M24: the viewer in `slot` shows `id` without its detail yet (the Build view handed over):
    /// its next load fetches the detail too, which records the open and brings the sources.
    func needsDetail(_ slot: Slot, id: String) -> Bool {
        let shown = slot == .viewer ? viewer : pinnedViewer
        guard let shown, shown.artifactId == id else { return false }
        return shown.detail == nil
    }

    /// The later of two optional dates.
    static func newer(_ a: Date?, _ b: Date?) -> Date? {
        guard let x = a, let y = b else { return a ?? b }
        return max(x, y)
    }

    /// GET /api/artifacts/:id answered for a viewer (it may turn out to be still building).
    mutating func detailLoaded(_ detail: ArtifactDetail, slot: Slot) {
        apply(detail.summary)
        update(slot, id: detail.id) { $0.detail = detail }
        if slot == .viewer, isFirstBuild(detail.id), viewer?.artifactId == detail.id {
            viewer = nil
            build = detail.id
        }
    }

    /// GET /api/artifacts/:id/html answered: the page shows; a re-render bumps editGeneration.
    /// `version` is the page's `pageVersion`. M27: a reload of the same page (its data element
    /// was missing, or the data was cleared) is not an edit: no glow count, no haptic.
    /// `knownData`: the artifact's dataVersion when the page was asked for (a page without a data
    /// element has none to read).
    mutating func htmlLoaded(_ html: String, version: Date?, knownData: Int? = nil, slot: Slot, id: String) {
        update(slot, id: id) { viewer in
            var samePage = false
            if let version, let loaded = viewer.loadedVersion { samePage = version <= loaded }
            if case .ready = viewer.phase, !samePage { viewer.editGeneration += 1 }
            viewer.phase = .ready(html: html)
            viewer.loadedVersion = version ?? viewer.loadedVersion
            viewer.refreshing = false
            viewer.pageLoads += 1
            let inPage = LiveDataRules.htmlDataVersion(html)
            viewer.htmlDataVersion = inPage
            // The page's own data, else (no element) what was asked for: a page served without the
            // data has none, so it doesn't ask for it again (no reload loop).
            viewer.dataShown = inPage ?? [knownData, viewer.dataReload].compactMap { $0 }.max()
            viewer.dataReload = nil
            if let pending = viewer.pendingData, pending.dataVersion <= viewer.dataShown ?? 0 { viewer.pendingData = nil }
            // A new page brings its own haptic (editGeneration); a ↻ still waiting for its data
            // keeps waiting (a data-only reload).
            if !samePage, viewer.refreshWait?.waitsForEvents == false { viewer.refreshWait = nil }
            viewer.landIfShown()
        }
    }

    /// The HTML couldn't load: a first load shows the reason with Retry; a reload keeps the page.
    mutating func htmlFailed(reason: String, slot: Slot, id: String) {
        update(slot, id: id) { viewer in
            viewer.refreshing = false
            // M27: the reload a missing data element asked for didn't happen; the next event or
            // list load may ask again.
            viewer.dataReload = nil
            if case .ready = viewer.phase { return }
            viewer.phase = .failed(reason: reason)
        }
    }

    mutating func setRefreshing(_ refreshing: Bool, id: String) {
        if viewer?.artifactId == id { viewer?.refreshing = refreshing }
        if pinnedViewer?.artifactId == id { pinnedViewer?.refreshing = refreshing }
    }

    /// Changes the viewer in `slot` when it still shows `id`.
    mutating func update(_ slot: Slot, id: String, _ body: (inout ArtifactViewerState) -> Void) {
        switch slot {
        case .viewer: if viewer?.artifactId == id { body(&viewer!) }
        case .pinned: if pinnedViewer?.artifactId == id { body(&pinnedViewer!) }
        }
    }

    // MARK: - Add to tab bar

    /// Pins (unpinning any other) or unpins at once; returns the list before, for a rollback.
    mutating func setPinned(_ id: String, _ on: Bool) -> [ArtifactSummary] {
        let before = artifacts
        for index in artifacts.indices {
            if artifacts[index].id == id {
                artifacts[index].pinnedToTabBar = on
            } else if on {
                artifacts[index].pinnedToTabBar = false
            }
        }
        if pinned?.id != pinnedViewer?.artifactId { pinnedViewer = nil }
        return before
    }

    /// A failed PATCH: the pinned flags as they were (other fields keep any newer copy).
    mutating func restorePins(_ before: [ArtifactSummary]) {
        let flags = Dictionary(before.map { ($0.id, $0.pinnedToTabBar) }, uniquingKeysWith: { a, _ in a })
        for index in artifacts.indices {
            if let flag = flags[artifacts[index].id] { artifacts[index].pinnedToTabBar = flag }
        }
        if pinned?.id != pinnedViewer?.artifactId { pinnedViewer = nil }
    }

    // MARK: - Delete (M9)

    /// What a long-press Delete took out of the gallery, for the rollback.
    struct Removal: Hashable, Sendable {
        var artifact: ArtifactSummary
        var justMade: Bool
        /// M10: its place among the pinned ones (nil = not pinned)
        var pinIndex: Int? = nil
    }

    /// Long-press Delete: the item leaves the gallery at once and its viewer, Build view and 4th
    /// tab close. Nil when the gallery doesn't have it.
    mutating func remove(_ id: String) -> Removal? {
        guard let index = artifacts.firstIndex(where: { $0.id == id }) else { return nil }
        let removal = Removal(artifact: artifacts.remove(at: index), justMade: justMade.contains(id), pinIndex: pinOrder.firstIndex(of: id))
        pinOrder.removeAll { $0 == id }
        justMade.remove(id)
        editing.remove(id)
        work[id] = nil
        firstBuilds.remove(id)
        buildStatus[id] = nil
        if build == id { build = nil }
        if viewer?.artifactId == id { viewer = nil }
        if pinnedViewer?.artifactId == id { pinnedViewer = nil }
        for key in [RequestKey.edit(id), RequestKey.refresh(id), RequestKey.pin(id), RequestKey.pinInMake(id)] { requests[key] = nil }
        return removal
    }

    /// The DELETE failed: the item comes back where it was (a copy that arrived meanwhile wins).
    mutating func restore(_ removal: Removal) {
        guard artifact(removal.artifact.id) == nil else { return }
        artifacts.append(removal.artifact)
        if removal.artifact.pinned, !pinOrder.contains(removal.artifact.id) {
            pinOrder.insert(removal.artifact.id, at: min(removal.pinIndex ?? 0, pinOrder.count))
        }
        sortGallery()
        if removal.justMade { justMade.insert(removal.artifact.id) }
    }

    // MARK: - Pin in Make (M10)

    /// What a Pin / Unpin changed, for the rollback.
    struct PinChange: Hashable, Sendable {
        var id: String
        var wasPinned: Bool
        /// its place among the pinned ones before (nil = it wasn't pinned)
        var index: Int?
    }

    /// Long-press Pin / Unpin: at once (a pin goes to the front of the pinned ones). Nil when the
    /// gallery doesn't have it or it is already that way.
    mutating func setPinnedInMake(_ id: String, _ on: Bool) -> PinChange? {
        guard let index = artifacts.firstIndex(where: { $0.id == id }), artifacts[index].pinned != on else { return nil }
        let change = PinChange(id: id, wasPinned: artifacts[index].pinned, index: pinOrder.firstIndex(of: id))
        artifacts[index].pinned = on
        pinOrder.removeAll { $0 == id }
        if on { pinOrder.insert(id, at: 0) }
        sortGallery()
        return change
    }

    /// The PATCH failed: the item goes back to where it was (unless it was deleted meanwhile).
    mutating func restorePinInMake(_ change: PinChange) {
        guard let index = artifacts.firstIndex(where: { $0.id == change.id }) else { return }
        artifacts[index].pinned = change.wasPinned
        pinOrder.removeAll { $0 == change.id }
        if change.wasPinned { pinOrder.insert(change.id, at: min(change.index ?? 0, pinOrder.count)) }
        sortGallery()
    }

    /// The pinned artifacts in their order (newest pin first).
    var pinnedInMake: [ArtifactSummary] {
        let byId = Dictionary(artifacts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return pinOrder.compactMap { id in byId[id].flatMap { $0.pinned ? $0 : nil } }
    }

    // MARK: - Helpers

    /// The gallery's order: pinned first (newest pin first), then newest first.
    mutating func sortGallery() {
        Self.sortPinnedFirst(&artifacts, pinOrder: pinOrder)
    }

    static func sortPinnedFirst(_ list: inout [ArtifactSummary], pinOrder: [String]) {
        var rank: [String: Int] = [:]
        for (index, id) in pinOrder.enumerated() where rank[id] == nil { rank[id] = index }
        list.sort { a, b in
            let ra = a.pinned ? rank[a.id] ?? Int.max : nil
            let rb = b.pinned ? rank[b.id] ?? Int.max : nil
            switch (ra, rb) {
            case let (x?, y?) where x != y: return x < y
            case (.some, nil): return true
            case (nil, .some): return false
            default: return a.updatedAt != b.updatedAt ? a.updatedAt > b.updatedAt : a.id > b.id
            }
        }
    }

    static func sortNewestFirst(_ list: inout [ArtifactSummary]) {
        list.sort { a, b in a.updatedAt != b.updatedAt ? a.updatedAt > b.updatedAt : a.id > b.id }
    }
}

extension ArtifactViewerState {
    /// A ready `artifact` newer than the version on screen (or anything after a failed load).
    /// M27: newer page (`pageVersion`); a newer `dataVersion` alone is handed over in place.
    func isStale(for artifact: ArtifactSummary) -> Bool {
        if case .failed = phase { return true }
        guard let loadedVersion else { return phase != .loading }
        return artifact.pageVersion > loadedVersion
    }

    /// M27: the data version the page shows or is about to (a fetched one waiting for the page,
    /// a reload asked for); a newer one is fetched.
    var dataKnown: Int {
        [dataShown, pendingData?.dataVersion, dataReload].compactMap { $0 }.max() ?? 0
    }

    /// M27: the page can't take `version` in place (it has no data element, or the data was
    /// cleared): reload it once for that version; when a reload for it already happened (or is
    /// on its way) take it as shown instead. Returns whether to reload.
    mutating func noData(_ version: Int) -> Bool {
        if let pending = pendingData, pending.dataVersion <= version { pendingData = nil }
        if let asked = dataReload, asked >= version { return false }
        if let shown = dataShown, shown >= version { return false }
        dataReload = version
        return true
    }

    /// M27: the data a ↻ tapped here brought is on the page: the success haptic.
    mutating func landIfShown() {
        guard case .landing(let version) = refreshWait, (dataShown ?? 0) >= version else { return }
        refreshWait = nil
        dataLanded += 1
    }
}

extension ArtifactViewerState.RefreshWait {
    /// Still waiting for the refresh's events (not yet for its data on the page).
    var waitsForEvents: Bool {
        switch self {
        case .asked, .running: true
        case .landing: false
        }
    }
}
