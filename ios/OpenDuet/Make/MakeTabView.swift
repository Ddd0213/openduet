// The Make tab's gallery (prompt L147, L185): the hero card (until dismissed), then (M24) one row
// of type filter chips with a menu for list / grid and the sort, then "Pinned", "Changed today",
// "Designs" and "Pages", each item in one only, each showing 4 cards (grid) or 5 rows (list)
// until "See all ›" (MakeGallery). Empty: "Templates" and "Everything OpenDuet makes shows up
// here". The first load shows shapes of the chosen layout; a failure shows the reason with Retry;
// pull to refresh reloads. The + FAB, its fan and the Describe sheet live in the shell. M9:
// long-press an item for Open, Add to / Remove from tab bar and Delete (asks in place;
// GalleryTiles). M10: Pin / Unpin; the FAB fades while the gallery scrolls (MakeFABFade) and the
// bottom padding keeps the last tiles clear of the FAB and the tab bar.
import SwiftUI

struct MakeTabView: View {
    var state: MakeState
    var actions: MakeActions

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("make.heroDismissed") private var heroDismissed = false
    /// M24: one layout and one sort for every section, remembered.
    @AppStorage("make.galleryLayout") private var layout: GalleryLayout = .grid
    @AppStorage("make.gallerySort") private var sort: GallerySort = .lastModified
    /// M24: the picked type chip (nil = All); not remembered.
    @State private var filter: ArtifactType?
    /// Sections opened with "See all ›".
    @State private var expanded: Set<MakeGallery.Section.Kind> = []
    @State private var refreshing = false
    /// Which tap's Create is showing its spinner or failure (hero or a template).
    @State private var source: String?
    /// M10: the scroll view's bottom inset (the bottom chrome), for the bottom padding.
    @State private var bottomInset: CGFloat = 0
    @ScaledMetric(relativeTo: .subheadline) private var pinnedHeaderSize: CGFloat = 15
    @ScaledMetric(relativeTo: .title3) private var sectionSize: CGFloat = 20
    @ScaledMetric(relativeTo: .subheadline) private var linkSize: CGFloat = 15

    private static let heroSource = "hero"

    private var createRequest: CardRequest? { state.requests[MakeState.RequestKey.create] }

    /// The FAB and its 16 pt above the system tab bar. M19: the FAB's slot is in the bottom chrome,
    /// so the scroll view's bottom inset already counts the tab bar and the slot; the base padding
    /// keeps the last tiles clear.
    private var bottomPadding: CGFloat {
        let chrome = Metrics.fabAboveTabBar + Metrics.fab
        return FABFadeRule.bottomPadding(inset: bottomInset, chrome: chrome)
    }

    private var motion: Animation {
        reduceMotion ? .easeInOut(duration: 0.25) : .spring(response: 0.4, dampingFraction: 0.86)
    }

    var body: some View {
        ScrollView {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                content(now: context.date)
            }
            .padding(.horizontal, Metrics.threadInset)
            .padding(.top, 4)
            // M10: room for the FAB and the tab bar, so the last tiles always scroll clear of them.
            .padding(.bottom, bottomPadding)
        }
        .scrollDismissesKeyboard(.immediately)
        .refreshable { await pullToRefresh() }
        // M10: the FAB fades while the gallery scrolls and comes back ~0.4 s after it stops.
        .onScrollPhaseChange { _, phase in MakeFABFade.shared.phaseChanged(FABFadeRule.Phase(phase)) }
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentInsets.bottom } action: { _, inset in bottomInset = inset }
        .onDisappear { MakeFABFade.shared.reset() }
        .onChange(of: state.viewer != nil) { _, covered in if covered { MakeFABFade.shared.reset() } }
        .onAppear { actions.refresh() }
        .onChange(of: state.refreshing, initial: true) { _, now in refreshing = now }
        .onChange(of: filter) { _, _ in expanded = [] }
        .animation(motion, value: state.artifacts.map(\.id))
        .animation(motion, value: layout)
        .animation(motion, value: sort)
        .animation(motion, value: filter)
        .animation(.easeInOut(duration: 0.25), value: state.phase)
        .animation(.easeInOut(duration: 0.3), value: heroDismissed)
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        let gallery = MakeGallery(artifacts: state.artifacts, filter: filter, sort: sort, now: now)
        VStack(alignment: .leading, spacing: 26) {
            if !heroDismissed {
                HeroCard(
                    request: source == Self.heroSource ? createRequest : nil,
                    onCreate: { type, prompt in
                        source = Self.heroSource
                        actions.create(type, prompt)
                    },
                    onDismiss: { heroDismissed = true }
                )
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.96, anchor: .top)))
            }
            if let reason = state.refreshFailure {
                InlineFailure(reason: reason, onRetry: actions.refresh, onEdit: nil).transition(.opacity)
            }
            switch state.phase {
            case .loading where state.artifacts.isEmpty:
                GallerySkeleton(layout: layout).transition(.opacity)
            case .failed(let reason) where state.artifacts.isEmpty:
                InlineFailure(reason: reason, onRetry: actions.refresh, onEdit: nil).transition(.opacity)
            default:
                if gallery.isEmpty {
                    templates
                    MakeEmptyLine()
                } else {
                    VStack(alignment: .leading, spacing: 20) {
                        GalleryControls(types: gallery.types, filter: picked(gallery), layout: $layout, sort: $sort)
                        VStack(alignment: .leading, spacing: 26) {
                            ForEach(gallery.sections) { group in
                                section(group, now: now)
                            }
                        }
                    }
                }
            }
        }
    }

    /// The chips' selection: what the gallery applied (a pick with nothing left reads All).
    private func picked(_ gallery: MakeGallery) -> Binding<ArtifactType?> {
        Binding(get: { gallery.filter }, set: { filter = $0 })
    }

    // MARK: - Sections

    private var gridColumns: [GridItem] {
        [GridItem(.flexible(), spacing: 12, alignment: .top), GridItem(.flexible(), spacing: 12, alignment: .top)]
    }

    private func section(_ group: MakeGallery.Section, now: Date) -> some View {
        let open = expanded.contains(group.kind)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                header(group.kind)
                Spacer()
                if group.hasMore(layout) && !open { seeAll(group.kind) }
            }
            items(group.visible(layout, expanded: open), now: now)
        }
        .transition(.opacity)
    }

    @ViewBuilder
    private func header(_ kind: MakeGallery.Section.Kind) -> some View {
        if kind == .pinned {
            // M10: long-press Pin puts an item here, first, under a small "Pinned" header.
            HStack(spacing: 5) {
                DuetIcon(glyph: .pin, size: pinnedHeaderSize, tint: Palette.secondaryText)
                Text("Pinned")
                    .font(.system(size: pinnedHeaderSize, weight: .semibold))
                    .foregroundStyle(Palette.secondaryText)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
        } else {
            title(kind)
                .font(.system(size: sectionSize, weight: .semibold))
                .foregroundStyle(Palette.primaryText)
                .accessibilityAddTraits(.isHeader)
        }
    }

    private func title(_ kind: MakeGallery.Section.Kind) -> Text {
        switch kind {
        case .pinned: Text("Pinned")
        case .changedToday: Text("Changed today")
        case .designs: Text("Designs")
        case .pages: Text("Pages")
        case .type(let type): Text(type.title)
        }
    }

    private func seeAll(_ kind: MakeGallery.Section.Kind) -> some View {
        Button {
            withAnimation(motion) { _ = expanded.insert(kind) }
        } label: {
            HStack(spacing: 3) {
                Text("See all")
                Image(systemName: "chevron.right").font(.system(size: linkSize - 3, weight: .semibold)).accessibilityHidden(true)
            }
            .font(.system(size: linkSize, weight: .medium))
            .foregroundStyle(Palette.secondaryText)
        }
        .buttonStyle(PressableButtonStyle(scale: 0.95))
    }

    @ViewBuilder
    private func items(_ list: [ArtifactSummary], now: Date) -> some View {
        switch layout {
        case .grid:
            LazyVGrid(columns: gridColumns, spacing: 12) {
                ForEach(list) { item in tile(item, now: now) }
            }
        case .list:
            VStack(spacing: 10) {
                ForEach(list) { item in row(item, now: now) }
            }
        }
    }

    private func tile(_ item: ArtifactSummary, now: Date) -> some View {
        GalleryTile(
            artifact: item, justMade: item.isJustMade, now: now,
            onOpen: { actions.open(item.id) }, onPin: { actions.setPinned(item.id, $0) },
            deleteRequest: state.requests[MakeState.RequestKey.delete(item.id)],
            onDelete: { actions.delete(item.id) },
            pinRequest: state.requests[MakeState.RequestKey.pinInMake(item.id)],
            onPinInMake: { actions.pinInMake(item.id, $0) }
        )
    }

    private func row(_ item: ArtifactSummary, now: Date) -> some View {
        GalleryRow(
            artifact: item, justMade: item.isJustMade, now: now,
            onOpen: { actions.open(item.id) }, onPin: { actions.setPinned(item.id, $0) },
            deleteRequest: state.requests[MakeState.RequestKey.delete(item.id)],
            onDelete: { actions.delete(item.id) },
            pinRequest: state.requests[MakeState.RequestKey.pinInMake(item.id)],
            onPinInMake: { actions.pinInMake(item.id, $0) }
        )
    }

    // MARK: - Empty

    private var templates: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Templates")
                .font(.system(size: sectionSize, weight: .semibold))
                .foregroundStyle(Palette.primaryText)
                .accessibilityAddTraits(.isHeader)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(MakeTemplate.all) { template in
                        TemplateCard(template: template, busy: source == template.id && createRequest == .inFlight) {
                            source = template.id
                            actions.create(template.type, template.prompt)
                        }
                    }
                }
                .padding(.horizontal, Metrics.threadInset)
                .padding(.vertical, 2)
            }
            .padding(.horizontal, -Metrics.threadInset)
            if let source, source != Self.heroSource, let reason = createRequest?.failureReason {
                InlineFailure(reason: reason, onRetry: {
                    if let template = MakeTemplate.all.first(where: { $0.id == source }) { actions.create(template.type, template.prompt) }
                }, onEdit: nil)
                .transition(.opacity)
            }
        }
        // A template's Create that failed (the hero's composer has its own).
        .sensoryFeedback(.warning, trigger: createRequest) { _, new in
            source != nil && source != Self.heroSource && new?.failureReason != nil
        }
    }

    private func pullToRefresh() async {
        actions.refresh()
        let start = Date()
        while !refreshing, Date().timeIntervalSince(start) < 0.6 {
            try? await Task.sleep(for: .milliseconds(50))
        }
        while refreshing, Date().timeIntervalSince(start) < 15 {
            try? await Task.sleep(for: .milliseconds(100))
        }
    }
}

extension FABFadeRule.Phase {
    init(_ phase: ScrollPhase) {
        if phase == .idle {
            self = .idle
        } else if phase == .tracking {
            self = .tracking
        } else if phase == .decelerating {
            self = .decelerating
        } else if phase == .animating {
            self = .animating
        } else {
            self = .interacting
        }
    }
}
