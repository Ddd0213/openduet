// The artifact viewer and docs reader (prompt L151-L152, L181): one top row with ✕ (none when it's
// the 4th tab), the title with one small grey line under it ("Refreshes daily at 5:30 AM"; on
// dashboards "Updated now", or the refresh's status), the comment pointer on dashboards, Contents
// on long docs, and a pill with ✎ edit and ⋯ (Share, Comment, Add to tab bar; docs add Export PDF
// and Copy text; dashboards Refresh and Data sources; M24: Undo last change and Versions, through
// `\.apiClient` since MakeActions has no restore). Edits re-render in place (the page glows
// what changed); meanwhile "OpenDuet is working on it..." floats over the page. Swipe the header
// down to close.
// After M13 (decided by the user): the page sits below the top row, not under it, and nothing is
// drawn over it (no blur or fade masks); the row, the area behind the status bar and the ✎ /
// Comment bar take the page's own background colour (PageTint), with the dark or light look to
// match. On the 4th tab the shell's header and tab bar take it too (`onChrome`).
// M27: a dashboard's newer live data is handed to the open page in place (no reload, no glow, no
// haptic unless a ↻ tapped here brought it); Share fetches the page again once hand-overs moved
// past the HTML loaded; Versions follow merged data updates.
import SwiftUI
import UIKit

/// The bars' colour and the look that reads on it (the 4th tab hands it to the shell).
struct ViewerChrome: Equatable {
    var fill: Color
    var scheme: ColorScheme
}

struct ArtifactViewer: View {
    var viewer: ArtifactViewerState
    var make: MakeState
    var actions: MakeActions
    /// The 4th tab: no ✕, "Remove from tab bar" in ⋯.
    var pinned = false
    var onOpenRoute: (URL) -> Void
    var onClose: () -> Void = {}
    /// The ✎ / Comment bar opened or closed.
    var onEditing: (Bool) -> Void = { _ in }
    /// The bars' colour once the page has reported it, nil before and after (the 4th tab).
    var onChrome: (ViewerChrome?) -> Void = { _ in }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.locale) private var locale
    @Environment(\.colorScheme) private var colorScheme
    @State private var page = ArtifactPage()
    @State private var editMode: ArtifactEditBar.Mode?
    @State private var showSources = false
    @State private var showContents = false
    @State private var share: ShareFile?
    @State private var safari: SafariLink?
    /// M20: a web link waiting for "Open" / "Cancel" (an unknown site or a long query).
    @State private var confirmLink: SafariLink?
    @State private var headings: [DocOutline.Heading] = []
    @State private var longDoc = false
    @State private var toast: Text?
    @State private var drag: CGFloat = 0
    @State private var successes = 0
    @State private var failures = 0
    /// M24: ⋯ Versions and Undo (GET /versions with the page and each new version; restore).
    @Environment(\.apiClient) private var api
    @State private var versions = VersionRules.Listing()
    @State private var showVersions = false
    @ScaledMetric(relativeTo: .headline) private var titleSize: CGFloat = 18
    @ScaledMetric(relativeTo: .headline) private var pinnedTitleSize: CGFloat = 17
    /// The page's frame between the top row and the bottom (safe area kept) and the web view's
    /// (with the ✎ bar closed it reaches the screen bottom), both global: the difference is the
    /// room the page's end needs above the home indicator or the 4th tab's tab bar.
    @State private var pageBox: CGRect = .zero
    @State private var webBox: CGRect = .zero
    @ScaledMetric(relativeTo: .footnote) private var subtitleSize: CGFloat = 13
    @ScaledMetric(relativeTo: .subheadline) private var toastSize: CGFloat = 14

    private var id: String { viewer.artifactId }
    private var artifact: ArtifactSummary? { make.artifact(id) ?? viewer.detail?.summary }
    private var type: ArtifactType? { artifact?.type }
    private var editRequest: CardRequest? { make.requests[MakeState.RequestKey.edit(id)] }
    private var refreshRequest: CardRequest? { make.requests[MakeState.RequestKey.refresh(id)] }
    /// M21: what the `artifact` events say about an edit or a refresh of this page.
    private var work: ArtifactWork? { make.work[id] }
    /// "OpenDuet is working on it..." over the page: ✎ sent, or an edit going on (M21: also one
    /// asked in the chat, which the page's editStatus reports).
    private var working: Bool {
        if work?.editFailed == true { return false }
        return editRequest == .inFlight || make.editing.contains(id) || work?.isEditing == true
            || (artifact?.status == .building && !viewer.refreshing)
    }
    /// "Refreshing...": ↻ in flight or a refresh going on (scheduled ones too, M21).
    private var refreshing: Bool { viewer.refreshing || work?.isRefreshing == true }
    private var html: String? { if case .ready(let html) = viewer.phase { html } else { nil } }
    private var scheduleLine: String? {
        artifact?.refreshSchedule.flatMap { MakeCopy(format: ChatDateFormat(locale: locale)).refreshes($0) }
    }

    /// The page's background as the page reported it, over the app's (nil until it has, and
    /// while loading or failed: the app's own background and look).
    private var tint: PageColor? {
        guard html != nil, let backdrop = page.backdrop else { return nil }
        return PageTint.resolve(backdrop, base: colorScheme == .dark ? .appDark : .appLight)
    }
    private var tintFill: Color { tint.map(Color.init(page:)) ?? Palette.background }
    /// Buttons, title and the small line: the dark look on a dark page, the light look on a light one.
    private var chromeScheme: ColorScheme { tint.map { PageTint.isDark($0) ? .dark : .light } ?? colorScheme }
    private var viewerChrome: ViewerChrome? { tint.map { _ in ViewerChrome(fill: tintFill, scheme: chromeScheme) } }
    /// The small grey line straight on the bar: the app's grey where it reads on the page colour,
    /// else something that does (mid-tone pages).
    private var secondaryInk: Color { tint.map { Color(page: PageTint.secondaryInk(on: $0)) } ?? Palette.secondaryText }

    var body: some View {
        // The row on top, the page from its lower edge down, the ✎ / Comment bar under the page:
        // nothing lies over the page and the page never runs under the row.
        VStack(spacing: 0) {
            chrome
                .environment(\.colorScheme, chromeScheme)
            content
            editBar
                .environment(\.colorScheme, chromeScheme)
        }
        // Behind the row and the status bar (on the 4th tab behind the shell's header too, one
        // block), behind the ✎ bar down to the screen bottom, and where the page bounces.
        .background(tintFill.ignoresSafeArea())
        .animation(.easeInOut(duration: 0.25), value: tint)
        .offset(y: drag)
        .overlay(alignment: .top) { toastView }
        .animation(.easeInOut(duration: 0.25), value: working)
        .animation(reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.38, dampingFraction: 0.86), value: editMode)
        .animation(.easeInOut(duration: 0.3), value: viewer.phase)
        .task(id: "\(viewer.loadedVersion?.timeIntervalSince1970 ?? 0)|\(html?.count ?? 0)") { outline() }
        .onChange(of: viewer.editGeneration) { _, _ in successes += 1 }
        // M27: the data a ↻ tapped here brought is on the page (never data a task or chat pushed).
        .onChange(of: viewer.dataLanded) { _, _ in successes += 1 }
        // M27: newer live data goes into the open page once it has loaded (no reload).
        .task(id: handOverKey) { await handOver() }
        .onChange(of: editMode != nil) { _, open in onEditing(open) }
        .onChange(of: viewerChrome, initial: true) { _, chrome in onChrome(chrome) }
        .onDisappear {
            onEditing(false)
            onChrome(nil)
        }
        .onChange(of: editRequest) { old, new in
            if old == .inFlight && new == nil { editMode = nil; page.setSelecting(false) }
            if case .failed = new { failures += 1 }
        }
        // M21: an edit or refresh that gave up after it was accepted.
        .onChange(of: work?.editFailed == true || work?.refreshFailed == true) { _, failed in
            if failed { failures += 1 }
        }
        .animation(.easeInOut(duration: 0.25), value: editFailure)
        .sensoryFeedback(.success, trigger: successes)
        .sensoryFeedback(.warning, trigger: failures)
        .sheet(isPresented: $showSources) {
            SourcesSheet(sources: viewer.detail?.sources ?? [], schedule: scheduleLine) { showSources = false }
                .duetSheetChrome()
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showVersions) {
            VersionsSheet(listing: versions, onRestore: { restore($0, undo: false) }, onRetry: loadVersions) { showVersions = false }
                .duetSheetChrome()
                .presentationDetents([.medium, .large])
        }
        // M24: the versions load with the page and again with every new version (edit, refresh,
        // restore), so Undo knows the one before the newest.
        .task(id: versionsKey) { if versionsKey != nil { loadVersions() } }
        .sheet(isPresented: $showContents) {
            ContentsSheet(headings: headings, onPick: { heading in
                showContents = false
                page.scrollToHeading(heading.index, smooth: !reduceMotion)
            }, onClose: { showContents = false })
            .duetSheetChrome()
            .presentationDetents([.medium, .large])
        }
        .sheet(item: $share) { file in
            ActivitySheet(items: [file.url])
                .presentationDetents([.medium, .large])
                .onDisappear { try? FileManager.default.removeItem(at: file.url) }
        }
        .sheet(item: $safari) { link in SafariView(url: link.url).ignoresSafeArea() }
        // M20 (#7): the link's full host in the title, the URL shortened in the middle below.
        .confirmationDialog(confirmTitle, isPresented: confirmingLink, titleVisibility: .visible, presenting: confirmLink) { link in
            Button { safari = link } label: { Text("Open") }
            Button(role: .cancel) {} label: { Text("Cancel") }
        } message: { link in
            Text(verbatim: ExternalLinkRules.shortened(link.url))
        }
    }

    // MARK: - Chrome

    @ViewBuilder
    private var chrome: some View {
        // One glass layer for the circles and the pill that sit together; spacing under the row's
        // gaps so each keeps its own shape at rest.
        ChromeGlassGroup(spacing: 4) { row }
            .padding(.top, pinned ? 0 : 8)
            .padding(.bottom, 8)
            .contentShape(Rectangle())
            .gesture(pinned ? nil : closeDrag)
    }

    /// One row, full screen and on the 4th tab (L152) alike: ✕ (not on the 4th tab), the title
    /// with its small grey line, Contents on long docs, the comment pointer on dashboards, ✎ | ⋯.
    /// A dashboard's Refresh and Data sources are in ⋯ (no second toolbar row).
    private var row: some View {
        HStack(alignment: .center, spacing: pinned ? 8 : 10) {
            if !pinned {
                CircleIconButton(systemImage: DuetGlyph.close.symbol, label: Text("Close"), action: onClose)
            }
            if type == .dashboard {
                titleBlock(subtitle: nil, status: true)
            } else {
                // M21: a scheduled refresh going on says so instead of the schedule.
                titleBlock(subtitle: refreshing ? Text("Refreshing...") : scheduleLine.map { Text(verbatim: $0) })
            }
            if longDoc {
                CircleIconButton(systemImage: DuetGlyph.contents.symbol, label: Text("Contents")) { showContents = true }
                    .transition(.opacity)
            }
            if type == .dashboard {
                selectCircle.transition(.opacity)
            }
            actionPill
        }
        .padding(.horizontal, 16)
    }

    /// The dashboard's comment pointer: tap it, then tap a passage (orange while it's on).
    private var selectCircle: some View {
        Button(action: toggleSelecting) {
            DuetIcon(glyph: .pointer, size: 20, tint: page.selecting ? Palette.justMade : Palette.primaryText)
                .frame(width: Metrics.headerCircle, height: Metrics.headerCircle)
                .background(Circle().fill(page.selecting ? Palette.justMade.opacity(0.12) : .clear))
                .floatingCircle(Metrics.headerCircle)
        }
        .buttonStyle(PressableButtonStyle(scale: 0.92))
        .disabled(html == nil)
        .accessibilityLabel(page.selecting ? Text("Stop selecting") : Text("Select to comment"))
        .accessibilityAddTraits(page.selecting ? .isSelected : [])
    }

    private func titleBlock(subtitle: Text?, status: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(verbatim: artifact?.title ?? "")
                .font(.system(size: pinned ? pinnedTitleSize : titleSize, weight: .semibold))
                .foregroundStyle(Palette.primaryText)
                .lineLimit(1)
            if status {
                dashboardStatus
                    .font(.system(size: subtitleSize))
                    .foregroundStyle(secondaryInk)
                    .lineLimit(1)
            } else if let subtitle {
                subtitle
                    .font(.system(size: subtitleSize))
                    .foregroundStyle(secondaryInk)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    /// Under a dashboard's title: "Updated now", or "Loading 2 sources" / "Refreshing..." / the
    /// refresh's failure while those are going on.
    private var dashboardStatus: some View {
        DashboardStatus(
            artifact: artifact, sourceCount: sourceCount,
            loading: viewer.phase == .loading, refreshing: refreshing,
            refreshFailure: refreshRequest?.failureReason ?? refreshFailure, ink: secondaryInk
        )
    }

    /// M21: a refresh that gave up (its schedule or ↻) while the last version stays on screen.
    private var refreshFailure: String? {
        guard let status = work?.refresh, status.state == .failed else { return nil }
        return Self.failureLine(status.reason, locale: locale, plain: String(localized: "Couldn't refresh")) {
            String(localized: "Couldn't refresh: \($0)")
        }
    }

    private var sourceCount: Int { viewer.detail?.sources.count ?? artifact?.sourceCount ?? 0 }

    /// ✎ | ⋯ in one pill (glass on iOS 26, the white capsule on iOS 18).
    private var actionPill: some View {
        HStack(spacing: 0) {
            Button { editMode = .edit } label: {
                DuetIcon(glyph: .edit, size: 22, tint: Palette.primaryText)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(Text("Ask OpenDuet for changes"))
            .disabled(html == nil)
            if !LiquidGlass.isAvailable {
                Divider().frame(height: 18)
            }
            Menu { menuItems } label: {
                Image(glyph: .more)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(Text("More"))
        }
        .font(.system(size: 17, weight: .medium))
        .foregroundStyle(Palette.primaryText)
        .chromeSurface(Capsule(), interactive: true, hairline: false)
        .buttonStyle(PressableButtonStyle(scale: 0.94))
    }

    @ViewBuilder
    private var menuItems: some View {
        if type == .dashboard {
            Button { actions.refreshArtifact(id) } label: { Label { Text("Refresh") } icon: { Image(glyph: .refresh) } }
                .disabled(viewer.phase == .loading || refreshing)
            Button { showSources = true } label: { Label { Text("Data sources (\(sourceCount))") } icon: { Image(glyph: .sources) } }
                .disabled(sourceCount == 0)
            Divider()
        }
        Button { shareFile() } label: { Label { Text("Share") } icon: { Image(glyph: .share) } }
            .disabled(html == nil)
        Button { startComment() } label: { Label { Text("Comment") } icon: { Image(glyph: .comment) } }
            .disabled(html == nil)
        if type == .docs {
            Button { exportPDF() } label: { Label { Text("Export PDF") } icon: { Image(glyph: .exportPDF) } }
                .disabled(html == nil)
            Button { copyText() } label: { Label { Text("Copy text") } icon: { Image(glyph: .copy) } }
                .disabled(html == nil)
        }
        Divider()
        // M24: Undo restores the one before the newest; Versions lists them all.
        if let target = versions.undoTarget {
            Button { restore(target, undo: true) } label: {
                Label { Text("Undo last change") } icon: { Image(systemName: "arrow.uturn.backward") }
            }
            .disabled(restoreBlocked)
        }
        Button { openVersions() } label: {
            Label { Text("Versions") } icon: { Image(systemName: "clock.arrow.circlepath") }
        }
        .disabled(html == nil)
        Divider()
        if artifact?.pinnedToTabBar == true {
            Button { actions.setPinned(id, false) } label: { Label { Text("Remove from tab bar") } icon: { Image(glyph: .removeFromTabBar) } }
        } else {
            Button { actions.setPinned(id, true) } label: { Label { Text("Add to tab bar") } icon: { Image(glyph: .addToTabBar) } }
                .disabled(artifact?.status != .ready)
        }
    }

    // MARK: - Page

    @ViewBuilder
    private var content: some View {
        ZStack(alignment: .top) {
            switch viewer.phase {
            case .loading:
                ViewerSkeleton(type: type ?? .docs).transition(.opacity)
            case .failed(let reason):
                VStack {
                    InlineFailure(reason: reason, onRetry: { actions.open(id) }, onEdit: nil)
                        .padding(Metrics.threadInset)
                    Spacer()
                }
                .transition(.opacity)
            case .ready(let html):
                ArtifactWebView(html: html, page: page, bottomInset: bottomInset, onLink: link, onSelect: { quote in
                    page.setSelecting(false)
                    editMode = .comment(quote: quote)
                })
                .opacity(working ? 0.6 : 1)
                // It starts at the row's lower edge (never under it). With the ✎ bar closed it
                // reaches the screen bottom (under the 4th tab's tab bar), its bottom
                // inset keeping the last line clear; with the bar open it ends at the bar's top
                // (the bar, not the page, then touches the safe area, so nothing is ignored).
                .ignoresSafeArea(.container, edges: .bottom)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { webBox = $0 }
                .accessibilityLabel(Text(verbatim: artifact?.title ?? ""))
            }
            VStack(spacing: 8) {
                if working {
                    WorkingPill().frame(maxWidth: 300).transition(dropIn)
                } else if let failure = editFailure {
                    Text(verbatim: failure)
                        .font(.system(size: subtitleSize))
                        .foregroundStyle(Palette.secondaryText)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .chromeSurface(Capsule(), hairline: false)
                        .transition(.opacity)
                }
                if page.selecting {
                    Text("Tap a passage to comment on it")
                        .font(.system(size: subtitleSize, weight: .medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(Capsule().fill(Palette.justMade))
                        .transition(.opacity)
                }
            }
            .padding(.top, 10)
            .animation(.easeInOut(duration: 0.25), value: page.selecting)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { pageBox = $0 }
    }

    /// How far the web view reaches past the page's own bottom (the home indicator; on the 4th tab
    /// the tab bar), plus a little air; 0 when the ✎ bar is open.
    private var bottomInset: CGFloat {
        guard pageBox != .zero, webBox != .zero else { return 0 }
        let below = max(webBox.maxY - pageBox.maxY, 0)
        return below > 0.5 ? below + 8 : 0
    }

    /// A finished edit or refresh that failed while the last version stays on screen. M21: an
    /// edit's failure comes as the page's editStatus (it stays `ready`); a server before M21 marks
    /// the page `failed` instead. A refresh's failure shows here on pages without the dashboard's
    /// status line.
    private var editFailure: String? {
        guard html != nil else { return nil }
        if let status = work?.edit, status.state == .failed {
            return Self.failureLine(status.reason, locale: locale, plain: String(localized: "Couldn't make the changes")) {
                String(localized: "Couldn't make the changes: \($0)")
            }
        }
        if type != .dashboard, let failure = refreshFailure { return failure }
        guard artifact?.status == .failed else { return nil }
        let reason = make.buildStatus[id].map { PhraseText.string($0, locale: locale) } ?? ""
        return reason.isEmpty ? String(localized: "Couldn't make the changes") : String(localized: "Couldn't make the changes: \(reason)")
    }

    /// "Couldn't ...", with the server's reason after a colon when it gave one.
    private static func failureLine(_ reason: Phrase?, locale: Locale, plain: String, with: (String) -> String) -> String {
        let text = reason.map { PhraseText.string($0, locale: locale) } ?? ""
        return text.isEmpty ? plain : with(text)
    }

    @ViewBuilder
    private var editBar: some View {
        if let editMode {
            ArtifactEditBar(mode: editMode, request: editRequest, onSend: { text in
                switch editMode {
                case .edit: actions.edit(id, text)
                case .comment(let quote): actions.comment(id, quote, text)
                }
            }, onClose: {
                self.editMode = nil
                page.setSelecting(false)
            }, noteInk: secondaryInk)
            .id(editMode)
            .padding(.horizontal, Metrics.threadInset)
            .padding(.vertical, 8)
            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
        }
    }

    @ViewBuilder
    private var toastView: some View {
        if let toast {
            toast
                .font(.system(size: toastSize, weight: .medium))
                .foregroundStyle(Palette.primaryText)
                .padding(.horizontal, 16).padding(.vertical, 9)
                .chromeSurface(Capsule(), hairline: false)
                .padding(.top, 60)
                .transition(dropIn)
                .accessibilityAddTraits(.isStaticText)
        }
    }

    /// The working pill and the toast drop in from the top; Reduce Motion fades them.
    private var dropIn: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top))
    }

    // MARK: - Versions (M24)

    /// The page shown and its version; nil until the page is on screen. M27: and the data
    /// version, so an open sheet and Undo follow merged data updates (one load at a time).
    private var versionsKey: String? {
        guard html != nil else { return nil }
        return "\(id)|\(viewer.loadedVersion?.timeIntervalSince1970 ?? 0)|\(artifact?.dataVersion ?? 0)"
    }

    /// No restore while one runs, nothing is on screen or the assistant is changing the page (409).
    private var restoreBlocked: Bool {
        html == nil || versions.restoring != nil || working || refreshing
    }

    /// M27: one load in flight; asked again meanwhile (a burst of data updates), one more after it.
    private func loadVersions() {
        guard let api else { return }
        let id = id
        guard versions.begin(id) else { return }
        Task {
            let again: Bool
            do {
                let list = try await api.artifactVersions(id: id)
                again = versions.loaded(list, id: id)
            } catch is CancellationError {
                again = versions.cancelled(id)
            } catch {
                again = versions.failed(TaskBoard.reason(for: error), id: id)
            }
            if again { loadVersions() }
        }
    }

    private func openVersions() {
        versions.failure = nil
        showVersions = true
        loadVersions()
    }

    /// Undo (the one before the newest) or a row's Restore. The page re-renders from the
    /// `artifact` event like any new version; the gallery reload catches a missed event.
    private func restore(_ version: ArtifactVersion, undo: Bool) {
        // A row's Restore while the assistant works gets the server's 409 and says so; Undo waits.
        guard let api, versions.restoring == nil, html != nil, !(undo && restoreBlocked) else { return }
        let id = id
        versions.restoring = version.id
        versions.failure = nil
        Task {
            do {
                _ = try await api.restoreArtifact(id: id, versionId: version.id)
                versions.restoring = nil
                showVersions = false
                show(undo ? Text("Undone") : Text("Restored"))
                actions.refresh()
            } catch {
                versions.restoring = nil
                let reason = VersionRules.failure(error)
                failures += 1
                if showVersions { versions.failure = reason } else { show(Text(verbatim: reason)) }
            }
        }
    }

    // MARK: - Actions

    private func outline() {
        guard type == .docs, let html else {
            headings = []
            longDoc = false
            return
        }
        headings = DocOutline.headings(in: html)
        longDoc = DocOutline.isLong(html: html, headings: headings)
    }

    private func toggleSelecting() {
        page.setSelecting(!page.selecting)
        if page.selecting { editMode = nil }
    }

    private func startComment() {
        editMode = .comment(quote: nil)
        page.setSelecting(true)
    }

    /// M20 (#7): a web link to a host none of the artifact's sources name, or with a long query,
    /// asks once ("Open <host>?") before Safari opens; short links to a source's site open at once.
    private func link(_ url: URL) {
        if let web = SafariLink(url) {
            if ExternalLinkRules.needsConfirmation(url, sources: viewer.detail?.sources) {
                confirmLink = web
            } else {
                safari = web
            }
        } else if url.scheme?.lowercased() == "duet" {
            onOpenRoute(url)
        }
    }

    private var confirmingLink: Binding<Bool> {
        Binding(get: { confirmLink != nil }, set: { if !$0 { confirmLink = nil } })
    }

    private var confirmTitle: Text {
        let host = confirmLink.flatMap { ExternalLinkRules.host(of: $0.url) } ?? ""
        return Text("Open \(host)?")
    }

    /// M27: the key of the hand-over waiting for the page: the fetched version and the loads
    /// (the page's own count of finished loads and the viewer's of HTML loads); nil = none.
    private var handOverKey: String? {
        guard let pending = viewer.pendingData else { return nil }
        return "\(pending.dataVersion)|\(viewer.pageLoads)|\(page.finishedLoads)"
    }

    /// M27: newer live data into the open page without a reload, once the page shown has loaded
    /// (a hand-over asked for while it loads runs at its didFinish: the key moves); the answer
    /// goes back to the store (it raises dataShown, or asks for one reload).
    private func handOver() async {
        guard let pending = viewer.pendingData, let json = pending.json, let html, page.isShowing(html) else { return }
        let load = viewer.pageLoads
        let shown = await page.handOver(json: json, version: pending.dataVersion)
        actions.dataHandedOver(pinned, id, pending.dataVersion, load, shown)
    }

    private func shareFile() {
        guard let html else { return }
        let title = artifact?.title ?? ""
        if type == .docs {
            exportPDF()
        } else if LiveDataRules.shareNeedsFetch(dataShown: viewer.dataShown, htmlDataVersion: viewer.htmlDataVersion), let api {
            // M27: the loaded HTML holds the numbers from before the hand-overs: share the page
            // as served now (the loaded one if that fails). Never into `phase` (that reloads).
            let id = id
            Task {
                let fresh = try? await api.artifactHTML(id: id)
                share = ShareFile.write(Data((fresh ?? html).utf8), title: title, ext: "html")
            }
        } else {
            share = ShareFile.write(Data(html.utf8), title: title, ext: "html")
        }
    }

    private func exportPDF() {
        let title = artifact?.title ?? ""
        Task {
            guard let data = await page.pdf() else { return show(Text("Couldn't make the PDF")) }
            share = ShareFile.write(data, title: title, ext: "pdf")
        }
    }

    private func copyText() {
        Task {
            guard let text = await page.text(), !text.isEmpty else { return }
            UIPasteboard.general.string = text
            successes += 1
            show(Text("Copied"))
        }
    }

    private func show(_ text: Text) {
        withAnimation(.easeInOut(duration: 0.2)) { toast = text }
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            withAnimation(.easeInOut(duration: 0.3)) { toast = nil }
        }
    }

    private var closeDrag: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                guard value.translation.height > 0, abs(value.translation.height) > abs(value.translation.width) else { return }
                drag = reduceMotion ? 0 : value.translation.height
            }
            .onEnded { value in
                if value.translation.height > 140 || value.predictedEndTranslation.height > 320 {
                    onClose()
                } else {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { drag = 0 }
                }
            }
    }
}

extension Color {
    /// A page colour (PageTint) as a SwiftUI colour.
    init(page color: PageColor) {
        self.init(.sRGB, red: color.red, green: color.green, blue: color.blue, opacity: color.alpha)
    }
}

/// The page's first load: blocks shaped like the type, pulsing.
struct ViewerSkeleton: View {
    var type: ArtifactType

    var body: some View {
        BuildSkeleton(type: type)
            .padding(.horizontal, Metrics.threadInset)
            .padding(.top, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .accessibilityElement()
            .accessibilityLabel(Text("Loading"))
    }
}
