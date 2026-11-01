// The Make gallery's rules (prompt L147, M24): type filter chips (only the types that have items;
// one picked leaves just its items), one layout (list / grid) and one sort (Last opened / Last
// modified / Title) for every section, and the sections, each item in exactly one: "Pinned",
// "Changed today" (changed today or building, any type, building first), "Designs" (the other
// designs and design systems), "Pages" (the other web pages, docs, slides and dashboards). Each
// shows the first 4 (grid) or 5 (list) until "See all ›". "Just made" = ready and never opened
// (`lastOpenedAt == nil`, kept by the server across restarts and devices). Pure Foundation
// (host-tested).
import Foundation

/// Show as list / Show as grid (`@AppStorage`, one setting for every section; grid by default).
enum GalleryLayout: String, CaseIterable, Sendable {
    case grid, list
}

/// The gallery's sort (`@AppStorage`, one setting for every section; Last modified by default).
enum GallerySort: String, CaseIterable, Sendable {
    /// newest `lastOpenedAt` first; never-opened ones by `createdAt` among them
    case lastOpened
    /// newest `updatedAt` first
    case lastModified
    /// A to Z in the app's language
    case title
}

struct MakeGallery: Hashable, Sendable {
    struct Section: Hashable, Sendable, Identifiable {
        enum Kind: Hashable, Sendable {
            case pinned, changedToday, designs, pages
            /// a type chip is picked: just its items, one section
            case type(ArtifactType)
        }
        var kind: Kind
        var items: [ArtifactSummary]
        var id: Kind { kind }

        /// What shows before "See all ›": two rows of the grid, or five list rows.
        static func previewCount(_ layout: GalleryLayout) -> Int { layout == .grid ? 4 : 5 }

        func hasMore(_ layout: GalleryLayout) -> Bool { items.count > Self.previewCount(layout) }

        func visible(_ layout: GalleryLayout, expanded: Bool) -> [ArtifactSummary] {
            expanded ? items : Array(items.prefix(Self.previewCount(layout)))
        }
    }

    /// The filter chips' order (after "All"), as in the + menu's names.
    static let chipOrder: [ArtifactType] = [.webPage, .docs, .slides, .dashboard, .design, .designSystem]
    static let designTypes: Set<ArtifactType> = [.design, .designSystem]

    /// The type chips to offer: only the types that have items.
    let types: [ArtifactType]
    /// The picked chip, or nil (All). A pick whose type has no items left counts as All.
    let filter: ArtifactType?
    /// Non-empty sections in order.
    let sections: [Section]

    init(artifacts: [ArtifactSummary], filter: ArtifactType? = nil, sort: GallerySort = .lastModified,
         now: Date = .now, calendar: Calendar = .autoupdatingCurrent) {
        let present = Set(artifacts.map(\.type))
        types = Self.chipOrder.filter { present.contains($0) }
        let picked = filter.flatMap { present.contains($0) ? $0 : nil }
        self.filter = picked
        if let picked {
            let items = Self.sorted(artifacts.filter { $0.type == picked }, by: sort, buildingFirst: true)
            sections = [Section(kind: .type(picked), items: items)]
            return
        }
        var pinned: [ArtifactSummary] = [], today: [ArtifactSummary] = []
        var designs: [ArtifactSummary] = [], pages: [ArtifactSummary] = []
        for item in artifacts {
            if item.pinned {
                pinned.append(item)
            } else if Self.isChangedToday(item, now: now, calendar: calendar) {
                today.append(item)
            } else if Self.designTypes.contains(item.type) {
                designs.append(item)
            } else {
                pages.append(item)
            }
        }
        sections = [
            Section(kind: .pinned, items: Self.sorted(pinned, by: sort, buildingFirst: false)),
            Section(kind: .changedToday, items: Self.sorted(today, by: sort, buildingFirst: true)),
            Section(kind: .designs, items: Self.sorted(designs, by: sort, buildingFirst: false)),
            Section(kind: .pages, items: Self.sorted(pages, by: sort, buildingFirst: false)),
        ].filter { !$0.items.isEmpty }
    }

    var isEmpty: Bool { sections.isEmpty }

    func section(_ kind: Section.Kind) -> Section? { sections.first { $0.kind == kind } }

    /// "Changed today": changed on the calendar day of `now`, or building (a first build or an
    /// edit / refresh that reports building).
    static func isChangedToday(_ item: ArtifactSummary, now: Date, calendar: Calendar) -> Bool {
        item.status == .building || calendar.isDate(item.updatedAt, inSameDayAs: now)
    }

    /// The chosen order; ties go to the newest change, then the id (stable).
    static func sorted(_ items: [ArtifactSummary], by sort: GallerySort, buildingFirst: Bool) -> [ArtifactSummary] {
        items.sorted { a, b in
            if buildingFirst, (a.status == .building) != (b.status == .building) { return a.status == .building }
            return precedes(a, b, by: sort)
        }
    }

    static func precedes(_ a: ArtifactSummary, _ b: ArtifactSummary, by sort: GallerySort) -> Bool {
        switch sort {
        case .lastModified:
            break
        case .lastOpened:
            let oa = a.lastOpenedAt ?? a.createdAt, ob = b.lastOpenedAt ?? b.createdAt
            if oa != ob { return oa > ob }
        case .title:
            let order = a.title.localizedStandardCompare(b.title)
            if order != .orderedSame { return order == .orderedAscending }
        }
        return a.updatedAt != b.updatedAt ? a.updatedAt > b.updatedAt : a.id > b.id
    }
}

extension ArtifactSummary {
    /// "Just made": made and not opened yet (orange border and badge until the first open).
    var isJustMade: Bool { status == .ready && lastOpenedAt == nil }
}

/// "/" in the composer (L156, L91): the skills list opens when the draft starts with "/" or the
/// full-width "／" and has no space yet (not while the Chinese keyboard is still composing); the
/// text after it filters the list.
enum SkillQuery {
    /// The filter text after the slash, or nil when the list shouldn't show.
    static func trigger(in draft: String, isComposing: Bool) -> String? {
        guard !isComposing, let first = draft.first, first == "/" || first == "／" else { return nil }
        let rest = draft.dropFirst()
        guard !rest.contains(where: \.isWhitespace) else { return nil }
        return String(rest)
    }

    /// Name prefix matches first, then names containing it, then descriptions; case and accent
    /// insensitive; alphabetical within each group (and for an empty query).
    static func filter(_ skills: [Skill], query: String) -> [Skill] {
        let sorted = skills.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        let q = normalized(query)
        guard !q.isEmpty else { return sorted }
        let prefix = sorted.filter { normalized($0.name).hasPrefix(q) }
        let inName = sorted.filter { !normalized($0.name).hasPrefix(q) && normalized($0.name).contains(q) }
        let inDescription = sorted.filter { !normalized($0.name).contains(q) && normalized($0.description).contains(q) }
        return prefix + inName + inDescription
    }

    /// The name as typed after "/": without a leading slash, lowercased for matching.
    private static func normalized(_ text: String) -> String {
        var t = text.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
        while t.hasPrefix("/") { t.removeFirst() }
        return t
    }
}

/// Reactions (L157): the user's own toggle, applied optimistically before PUT / DELETE answers.
enum ReactionToggle {
    static let quick = ["👍", "❤️", "⭐"]

    static func isOn(_ reactions: [Reaction], emoji: String) -> Bool {
        reactions.contains { $0.emoji == emoji && $0.by == .user }
    }

    static func toggled(_ reactions: [Reaction], emoji: String, on: Bool) -> [Reaction] {
        var result = reactions.filter { !($0.emoji == emoji && $0.by == .user) }
        if on { result.append(Reaction(emoji: emoji, by: .user)) }
        return result
    }

    /// The badges under a bubble: one per emoji, in first-reaction order.
    static func badges(_ reactions: [Reaction]) -> [String] {
        var seen = Set<String>()
        return reactions.compactMap { seen.insert($0.emoji).inserted ? $0.emoji : nil }
    }
}
