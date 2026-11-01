// M11 pages (EverythingSheet, ChannelAssistantSheet) without SwiftUI, so the Mac host tests cover
// them: a page's load state, the inline reason of a failure (the server's own words for a 400),
// the source badges and scope labels, the soul draft, fact lists, skill rules, the import
// selection and the access toggles' optimistic state. Connector forms: ConnectorFormRules.swift.
import Foundation

// MARK: - Loading

/// What a page loads for itself: the last value stays up while it reloads; a failure only
/// replaces the page when there's nothing to show yet.
struct Loadable<Value: Hashable & Sendable>: Hashable, Sendable {
    var value: Value?
    var failure: String?
    var loading = false

    enum Display: Hashable, Sendable {
        case loading
        case failed(String)
        case loaded(Value)
    }

    var display: Display {
        if let value { return .loaded(value) }
        if let failure, !loading { return .failed(failure) }
        return .loading
    }

    mutating func begin() {
        loading = true
    }

    mutating func finish(_ value: Value) {
        self.value = value
        failure = nil
        loading = false
    }

    mutating func fail(_ reason: String) {
        failure = reason
        loading = false
    }
}

enum SettingsReason {
    /// The inline line for a failed request: the server's message for a 400 ("url: not a valid
    /// URL", a failed connector check), APIError's own line otherwise; nil when it was cancelled.
    static func line(for error: any Error) -> String? {
        if error is CancellationError { return nil }
        if case APIError.validationFailed(_, let message)? = error as? APIError {
            let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? String(localized: "Check your answers and try again.") : trimmed
        }
        return (error as? APIError)?.localizedReason ?? String(localized: "Something went wrong.")
    }
}

// MARK: - Badges and labels

extension MemorySource {
    /// Who wrote a fact: "You", "OpenDuet", or "Tidied up" (the idle-time memory pass).
    var badge: LocalizedStringResource {
        switch self {
        case .user: "You"
        case .assistant: "OpenDuet"
        case .dreaming: "Tidied up"
        }
    }
}

extension SkillSource {
    /// Where a skill came from.
    var label: LocalizedStringResource {
        switch self {
        case .manual: "Written by you"
        case .github: "GitHub"
        case .zip: "Zip"
        case .assistant: "OpenDuet"
        // M25: a .zip, a .skill or a SKILL.md from Settings › Skills › Upload a skill
        case .upload: "Uploaded"
        }
    }

    /// Its scripts ask before the first run of each version: everything but what you wrote here
    /// (GitHub, a zip, an upload, the assistant's save card; docs/API.md M11 / M25).
    var scriptsAskFirst: Bool { self != .manual }
}

enum ScopeLabel {
    /// "All channels", "1 channel", "3 channels"; a channels-only item turned on nowhere is
    /// only in Everything (the main thread always has everything).
    static func text(scope: AccessScope, channelCount: Int) -> LocalizedStringResource {
        switch (scope, channelCount) {
        case (.all, _): "All channels"
        case (.channels, ...0): "Only in Everything"
        case (.channels, 1): "1 channel"
        case (.channels, let count): "\(count) channels"
        }
    }
}

enum SkillMeta {
    /// The grey line under a skill: source · scope (· Has scripts).
    static func parts(_ skill: Skill) -> [LocalizedStringResource] {
        var parts = [skill.source.label, ScopeLabel.text(scope: skill.scope, channelCount: skill.channelIds.count)]
        if skill.hasScripts { parts.append("Has scripts") }
        return parts
    }

    static func line(_ skill: Skill) -> String {
        parts(skill).map { String(localized: $0) }.joined(separator: " · ")
    }
}

// MARK: - Soul

/// The "Who OpenDuet is" editor: the fields as typed, compared with the saved soul.
struct SoulDraft: Hashable, Sendable {
    enum Field: String, CaseIterable, Hashable, Sendable {
        case name, addressAs, identity, persona, tone

        /// backend/src/contract/m11.ts Soul
        var limit: Int {
            switch self {
            case .name: 40
            case .addressAs: 80
            case .identity: 2000
            case .persona: 4000
            case .tone: 1000
            }
        }

        /// One line (name, how to address you) or a few (the rest).
        var multiline: Bool { self != .name && self != .addressAs }
    }

    var name = ""
    var addressAs = ""
    var identity = ""
    var persona = ""
    var tone = ""

    init() {}

    init(_ soul: Soul) {
        name = soul.name
        addressAs = soul.addressAs
        identity = soul.identity
        persona = soul.persona
        tone = soul.tone
    }

    subscript(field: Field) -> String {
        get {
            switch field {
            case .name: name
            case .addressAs: addressAs
            case .identity: identity
            case .persona: persona
            case .tone: tone
            }
        }
        set {
            switch field {
            case .name: name = newValue
            case .addressAs: addressAs = newValue
            case .identity: identity = newValue
            case .persona: persona = newValue
            case .tone: tone = newValue
            }
        }
    }

    private static func clean(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Characters left (negative = over), counted like the server (UTF-16, trimmed).
    func remaining(_ field: Field) -> Int {
        field.limit - Self.clean(self[field]).utf16.count
    }

    var isValid: Bool { Field.allCases.allSatisfy { remaining($0) >= 0 } }

    /// PUT /api/soul with only the fields that changed (trimmed; "" goes back to the default).
    func request(from saved: Soul) -> UpdateSoulRequest? {
        let base = SoulDraft(saved)
        var body = UpdateSoulRequest()
        var changed = false
        for field in Field.allCases where Self.clean(self[field]) != Self.clean(base[field]) {
            changed = true
            let value = Self.clean(self[field])
            switch field {
            case .name: body.name = value
            case .addressAs: body.addressAs = value
            case .identity: body.identity = value
            case .persona: body.persona = value
            case .tone: body.tone = value
            }
        }
        return changed ? body : nil
    }

    /// The Everything row's subtitle: the name the assistant uses (when set) and the start of who it is.
    static func summary(_ soul: Soul) -> String? {
        let parts = [soul.name, soul.identity, soul.persona, soul.tone]
            .map(clean)
            .filter { !$0.isEmpty }
        guard !parts.isEmpty else { return nil }
        return parts.prefix(2).joined(separator: " · ")
    }
}

// MARK: - Facts

enum FactList {
    /// Adds or replaces a fact; new ones go first (the server lists newest first).
    static func upsert(_ fact: MemoryFact, into facts: [MemoryFact]) -> [MemoryFact] {
        var facts = facts
        if let index = facts.firstIndex(where: { $0.id == fact.id }) {
            facts[index] = fact
        } else {
            facts.insert(fact, at: 0)
        }
        return facts
    }

    static func remove(_ id: String, from facts: [MemoryFact]) -> [MemoryFact] {
        facts.filter { $0.id != id }
    }

    /// A fact's "from this chat" link: a channel's facts come from that channel's thread
    /// (duet://channels/<id>); an "About you" fact can come from any thread, and there's no
    /// route to a single message, so it gets no link. Also none for facts typed by the user.
    static func sourceRoute(_ fact: MemoryFact, channelId: String?) -> URL? {
        guard fact.sourceMessageId != nil else { return nil }
        return channelRoute(channelId)
    }

    /// duet://channels/<id> (DuetRoute opens the channel's thread on Chat).
    static func channelRoute(_ channelId: String?) -> URL? {
        guard let channelId, !channelId.isEmpty else { return nil }
        var parts = URLComponents()
        parts.scheme = "duet"
        parts.host = "channels"
        parts.path = "/" + channelId
        return parts.url
    }

    /// backend/src/contract/m11.ts CreateMemoryFactRequest / UpdateMemoryFactRequest
    static let maxLength = 2000

    static func cleaned(_ text: String) -> String? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= maxLength else { return nil }
        return text
    }
}

// MARK: - Skills

enum SkillRules {
    static let descriptionLimit = 1024
    static let instructionsLimit = 100_000

    /// backend Skill.name: lowercase letters, digits and dashes, starting with a letter or digit.
    static func isValidName(_ name: String) -> Bool {
        name.wholeMatch(of: /[a-z0-9][a-z0-9-]{0,63}/) != nil
    }

    /// What a typed name would be as a skill name ("My Writing Style" -> "my-writing-style").
    static func suggestedName(_ text: String) -> String? {
        let folded = text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX")).lowercased()
        var out = ""
        for scalar in folded.unicodeScalars {
            if ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) {
                out.unicodeScalars.append(scalar)
            } else if !out.isEmpty, !out.hasSuffix("-") {
                out.append("-")
            }
        }
        while out.hasSuffix("-") { out.removeLast() }
        let name = String(out.prefix(64))
        let trimmed = name.hasSuffix("-") ? String(name.dropLast()) : name
        return isValidName(trimmed) ? trimmed : nil
    }

    /// PATCH /api/skills/:id with what changed (description and instructions trimmed, like the server).
    static func update(description: String, instructions: String, saved: Skill) -> UpdateSkillRequest? {
        var body = UpdateSkillRequest()
        let description = description.trimmingCharacters(in: .whitespacesAndNewlines)
        let instructions = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        if description != saved.description.trimmingCharacters(in: .whitespacesAndNewlines) { body.description = description }
        if instructions != saved.instructions.trimmingCharacters(in: .whitespacesAndNewlines) { body.instructions = instructions }
        return body.description == nil && body.instructions == nil ? nil : body
    }

    static func isValidEdit(description: String, instructions: String) -> Bool {
        let instructions = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        return description.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count <= descriptionLimit
            && !instructions.isEmpty && instructions.utf16.count <= instructionsLimit
    }

    /// The library after an import or a save: a skill with the same id or name is replaced
    /// (the server replaces by name), the rest stay; sorted by name like GET /api/skills.
    static func merge(_ incoming: [Skill], into skills: [Skill]) -> [Skill] {
        let ids = Set(incoming.map(\.id))
        let names = Set(incoming.map(\.name))
        let kept = skills.filter { !ids.contains($0.id) && !names.contains($0.name) }
        return (kept + incoming).sorted { $0.name < $1.name }
    }

    /// A GitHub link as typed: "github.com/o/r" gets https://; anything that isn't github.com is nil.
    static func githubURL(_ text: String) -> String? {
        var text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.lowercased().hasPrefix("http://") && !text.lowercased().hasPrefix("https://") {
            text = "https://" + text
        }
        guard let url = URLComponents(string: text), url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(), host == "github.com" || host == "www.github.com",
              url.path.split(separator: "/").count >= 2 else { return nil }
        return text
    }
}

/// Which candidates of an import preview are picked (at most 50 per import, the server's limit).
struct SkillImportSelection: Hashable, Sendable {
    static let maxPerImport = 50

    private(set) var picked: Set<String>
    let order: [String]

    /// Everything is picked to start with (the first 50 when there are more).
    init(_ preview: SkillImportPreview) {
        order = preview.skills.map(\.name)
        picked = Set(order.prefix(Self.maxPerImport))
    }

    func isPicked(_ name: String) -> Bool { picked.contains(name) }

    /// Whether `name` can be picked now (it's in the preview and the limit isn't reached).
    func canPick(_ name: String) -> Bool {
        picked.contains(name) || (order.contains(name) && picked.count < Self.maxPerImport)
    }

    mutating func toggle(_ name: String) {
        if picked.contains(name) {
            picked.remove(name)
        } else if canPick(name) {
            picked.insert(name)
        }
    }

    var count: Int { picked.count }

    /// POST /api/skills/import (names in the preview's order); nil when nothing is picked.
    func request(importId: String, channelId: String?) -> SkillImportRequest? {
        let names = order.filter { picked.contains($0) }
        guard !names.isEmpty else { return nil }
        return SkillImportRequest(importId: importId, names: names, channelId: channelId)
    }
}

// MARK: - What a channel can use

/// A channel's skills, connectors and apps with on / off switches: a switch shows the tapped
/// value while its PUT runs (optimistic), the server's answer replaces the list, and a failure
/// puts the old value back with the reason under the row.
struct AccessToggles: Hashable, Sendable {
    private(set) var items: [ChannelAccess.Item]
    private(set) var pending: [AccessRef: Bool] = [:]
    private(set) var failures: [AccessRef: String] = [:]

    init(_ access: ChannelAccess) {
        items = access.items
    }

    func isOn(_ item: ChannelAccess.Item) -> Bool {
        pending[item.ref] ?? item.enabled
    }

    func isBusy(_ item: ChannelAccess.Item) -> Bool { pending[item.ref] != nil }

    func failure(_ item: ChannelAccess.Item) -> String? { failures[item.ref] }

    /// Starts a change; nil when it would change nothing or that row's request is running.
    mutating func begin(_ item: ChannelAccess.Item, on: Bool) -> UpdateChannelAccessRequest? {
        guard pending[item.ref] == nil, isOn(item) != on else { return nil }
        pending[item.ref] = on
        failures[item.ref] = nil
        return UpdateChannelAccessRequest(changes: [.init(kind: item.kind, id: item.id, enabled: on)])
    }

    /// The PUT answered: its list is the truth, other rows still in flight keep their values.
    mutating func succeed(_ ref: AccessRef, with access: ChannelAccess) {
        pending[ref] = nil
        items = access.items
    }

    /// The PUT failed: the row goes back to what it was (nil reason = cancelled, no line).
    mutating func fail(_ ref: AccessRef, reason: String?) {
        pending[ref] = nil
        failures[ref] = reason
    }

    /// Skills, then connectors, then apps; empty groups left out; the server's order inside.
    var sections: [(kind: AccessKind, items: [ChannelAccess.Item])] {
        [AccessKind.skill, .connector, .app].compactMap { kind in
            let group = items.filter { $0.kind == kind }
            return group.isEmpty ? nil : (kind, group)
        }
    }
}

extension AccessKind {
    var sectionTitle: LocalizedStringResource {
        switch self {
        case .skill: "Skills"
        case .connector: "Custom connectors"
        case .app: "Apps"
        }
    }
}

// MARK: - A memory layer

/// What a memory page shows: "About you" (GET /api/memory) or a channel's own memory
/// (GET /api/channels/:id/memory), as one shape.
struct MemoryLayerState: Hashable, Sendable {
    var document: String
    var facts: [MemoryFact]
    var updatedAt: Date?

    init(document: String, facts: [MemoryFact], updatedAt: Date?) {
        self.document = document
        self.facts = facts
        self.updatedAt = updatedAt
    }

    init(_ memory: MemoryState) {
        self.init(document: memory.document, facts: memory.facts, updatedAt: memory.updatedAt)
    }

    init(_ memory: ChannelMemoryState) {
        self.init(document: memory.document, facts: memory.facts, updatedAt: memory.updatedAt)
    }
}
