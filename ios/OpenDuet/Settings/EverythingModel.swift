// M11: what the Everything sheet loads for itself through `\.apiClient` (the soul, About you,
// the channels' overview) and, since M16, what the settings (the profile sheet) load through the
// same model (models, skills and custom connectors), with their writes. Pages read it and call
// these; a write throws and the page shows the reason inline (SettingsReason.line). Custom
// connectors: EverythingModel+Connectors.swift. M25: the built-in connectors and Upload a skill.
import Foundation
import Observation

/// A channel of the overview with its icon and colour (from GET /api/channels when it answered).
struct ChannelOverviewRow: Hashable, Sendable, Identifiable {
    var summary: MemoryOverview.ChannelSummary
    var channel: Channel?
    var id: String { summary.channelId }
}

@MainActor @Observable
final class EverythingModel {
    private(set) var api: APIClient?
    var soul = Loadable<Soul>()
    var overview = Loadable<[ChannelOverviewRow]>()
    var skills = Loadable<[Skill]>()
    var connectors = Loadable<[CustomConnector]>()
    /// M25: Apps and connectors › "Built in" (an older server without the route: none).
    var builtins = Loadable<[BuiltinConnector]>()
    /// "About you": the same editor as a channel's own memory.
    let aboutYou = MemoryLayerModel(layer: .aboutYou)
    /// M12 Everything → Models (providers, models, defaults).
    let models = ModelsModel()

    init() {}

    func attach(_ api: APIClient?) {
        guard self.api == nil, let api else { return }
        self.api = api
        aboutYou.attach(api)
        models.attach(api)
    }

    /// The OpenDuet sheet appeared: what it shows (the soul, About you, the channels), at once (what
    /// was loaded stays up meanwhile).
    func refreshAssistant() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.loadSoul() }
            group.addTask { await self.aboutYou.load() }
            group.addTask { await self.loadOverview() }
        }
    }

    /// M16: the settings (the profile sheet) appeared: models, skills and custom connectors.
    func refreshSettings() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.loadSkills() }
            group.addTask { await self.loadConnectors() }
            group.addTask { await self.models.load() }
        }
    }

    func loadSoul() async {
        await load(\.soul) { try await $0.soul() }
    }

    func loadOverview() async {
        await load(\.overview) { api in
            async let overview = api.memoryOverview()
            let channels = (try? await api.channels()) ?? []
            let byId = Dictionary(channels.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            let summary = try await overview
            return summary.channels.map { ChannelOverviewRow(summary: $0, channel: byId[$0.channelId]) }
        }
    }

    func loadSkills() async {
        await load(\.skills) { try await $0.skills() }
    }

    func loadConnectors() async {
        await load(\.connectors) { try await $0.customConnectors() }
    }

    /// M25: the built-in connectors; a server from before M25 (404) has none, so no section.
    func loadBuiltins() async {
        await load(\.builtins) { api in
            do {
                return try await api.builtinConnectors()
            } catch APIError.notFound {
                return []
            }
        }
    }

    private func load<Value: Hashable & Sendable>(
        _ path: ReferenceWritableKeyPath<EverythingModel, Loadable<Value>>,
        _ fetch: @Sendable (APIClient) async throws -> Value
    ) async {
        guard let api else {
            if self[keyPath: path].value == nil { self[keyPath: path].fail(String(localized: "Can't reach your server.")) }
            return
        }
        self[keyPath: path].begin()
        do {
            let value = try await fetch(api)
            self[keyPath: path].finish(value)
        } catch {
            if let reason = SettingsReason.line(for: error) {
                self[keyPath: path].fail(reason)
            } else {
                self[keyPath: path].loading = false
            }
        }
    }

    func client() throws -> APIClient {
        guard let api else { throw APIError.unreachable }
        return api
    }

    // MARK: - Soul

    func saveSoul(_ body: UpdateSoulRequest) async throws {
        soul.finish(try await client().updateSoul(body))
    }

    // MARK: - Skills

    private func setSkills(_ change: ([Skill]) -> [Skill]) {
        skills.finish(change(skills.value ?? []))
    }

    func createSkill(_ body: CreateSkillRequest) async throws -> Skill {
        let skill = try await client().createSkill(body)
        setSkills { SkillRules.merge([skill], into: $0) }
        return skill
    }

    func updateSkill(_ id: String, _ body: UpdateSkillRequest) async throws {
        let skill = try await client().updateSkill(id: id, body)
        setSkills { SkillRules.merge([skill], into: $0) }
    }

    func deleteSkill(_ id: String) async throws {
        try await client().deleteSkill(id: id)
        setSkills { list in list.filter { $0.id != id } }
    }

    /// "Share with all channels": the skill's default becomes all.
    func shareSkillWithAll(_ id: String) async throws {
        try await client().updateAccessScope(UpdateAccessScopeRequest(ref: AccessRef(kind: .skill, id: id), scope: .all))
        setSkills { list in
            list.map { skill in
                var skill = skill
                if skill.id == id { skill.scope = .all }
                return skill
            }
        }
    }

    /// The folder as a zip in a temporary file for the share sheet.
    func exportSkill(_ skill: Skill) async throws -> ShareFile? {
        let data = try await client().exportSkill(id: skill.id)
        return ShareFile.write(data, title: skill.name, ext: "zip")
    }

    func skillFile(_ skillId: String, path: String) async throws -> SkillFileContent {
        try await client().skillFile(skillId: skillId, path: path)
    }

    func previewGitHub(_ url: String) async throws -> SkillImportPreview {
        try await client().previewGitHubSkills(url: url)
    }

    func previewZip(name: String, data: Data) async throws -> SkillImportPreview {
        try await client().previewZipSkills(fileName: name, data: data)
    }

    /// M25 Upload a skill: a .zip, a .skill or a SKILL.md, under its own name.
    func previewUpload(name: String, mime: String, data: Data) async throws -> SkillImportPreview {
        try await client().previewUploadedSkills(fileName: name, mime: mime, data: data)
    }

    func importSkills(_ body: SkillImportRequest) async throws -> [Skill] {
        let imported = try await client().importSkills(body)
        setSkills { SkillRules.merge(imported, into: $0) }
        return imported
    }
}
