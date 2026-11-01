// Previews of the M11 OpenDuet sheets with placeholder data (DEBUG only; the app never shows it):
// Everything (loaded, in English and Chinese, and still loading), a channel's OpenDuet sheet, a
// skill, New skill, Import, Add connector and a connector that failed its check.
#if DEBUG
import SwiftUI

enum SettingsSamples {
    static let now = Date()

    static let soul = Soul(name: "OpenDuet", addressAs: "Alex", identity: "A calm, careful helper for a small team.", persona: "", tone: "Warm and brief.", updatedAt: now)

    static let facts: [MemoryFact] = [
        MemoryFact(id: "f1", text: "Prefers short answers with the decision first.", source: .user, createdAt: now.addingTimeInterval(-3_600)),
        MemoryFact(id: "f2", text: "Works with the design team on Tuesdays.", source: .assistant, sourceMessageId: "m1", createdAt: now.addingTimeInterval(-86_400)),
        MemoryFact(id: "f3", text: "Q4 launch moved to November 12.", source: .dreaming, createdAt: now.addingTimeInterval(-86_400 * 3)),
    ]

    static let aboutYou = MemoryLayerState(document: "Alex leads product. Based in Lisbon.", facts: facts, updatedAt: now)

    static let overview: [ChannelOverviewRow] = AccountFixtures.channels.enumerated().map { index, channel in
        ChannelOverviewRow(
            summary: MemoryOverview.ChannelSummary(
                channelId: channel.id, name: channel.name, purpose: channel.purpose, useSharedMemory: index != 1,
                factCount: index, lastMessageAt: now, recent: index == 0 ? "Drafted the launch checklist." : nil
            ),
            channel: channel
        )
    }

    static let skills: [Skill] = [
        Skill(id: "s1", name: "brand-voice", description: "Our tone for customer replies.", instructions: "Write short, warm sentences.", createdAt: now),
        Skill(id: "s2", name: "pdf-tools", description: "Fill and split PDFs.", instructions: "Use the scripts in scripts/.", createdAt: now,
              source: .github, sourceUrl: "https://github.com/example/skills", files: [SkillFileInfo(path: "scripts/fill.py", size: 2_048, text: true)],
              scope: .channels, channelIds: ["c1"]),
    ]

    static func connector(_ id: String, _ name: String, failed: Bool) -> CustomConnector {
        CustomConnector(
            id: id, kind: failed ? .apiKey : .mcp, name: name, description: "",
            url: failed ? nil : "https://mcp.example.com/mcp", domain: failed ? "api.example.com" : nil,
            headerName: failed ? "Authorization" : nil, valuePrefix: failed ? "Bearer " : nil,
            secret: failed ? SecretInfo(set: true, last4: "3f9a") : nil,
            headers: failed ? [] : [ConnectorHeader(name: "Authorization", secret: true, value: nil, secretInfo: SecretInfo(set: true, last4: "a1b2"))],
            status: failed ? .failed : .active, error: failed ? "domain: couldn't be found" : nil,
            tools: [
                CustomConnectorTool(name: "search", description: "Search the docs.", access: .read, mode: .always),
                CustomConnectorTool(name: "create_page", description: "Add a page.", access: .write, mode: .ask),
            ],
            scope: .all, channelIds: [], createdAt: now
        )
    }

    static let connectors = [connector("cc1", "Team wiki", failed: false), connector("cc2", "Weather API", failed: true)]

    @MainActor static func everything(loaded: Bool = true) -> EverythingModel {
        let model = EverythingModel()
        guard loaded else { return model }
        model.soul.finish(soul)
        model.overview.finish(overview)
        model.skills.finish(skills)
        model.connectors.finish(connectors)
        model.aboutYou.state.finish(aboutYou)
        return model
    }

    static let access = ChannelAccess(channelId: "c1", items: [
        .init(kind: .skill, id: "s1", name: "brand-voice", description: "Our tone for customer replies.", scope: .all, enabled: true),
        .init(kind: .skill, id: "s2", name: "pdf-tools", description: "Fill and split PDFs.", scope: .channels, enabled: false),
        .init(kind: .connector, id: "cc1", name: "Team wiki", description: "", scope: .all, enabled: true),
        .init(kind: .app, id: "gmail", name: "Gmail", description: "Read, draft and send email.", scope: .all, enabled: true),
    ])

    @MainActor static func channel() -> ChannelSettingsModel {
        ChannelSettingsModel(
            channel: AccountFixtures.channels[0],
            memory: MemoryLayerState(document: "Launch review is on Fridays.", facts: Array(facts.prefix(1)), updatedAt: now),
            access: access
        )
    }
}

#Preview("Everything") {
    EverythingSheet(preview: SettingsSamples.everything())
        .background(Palette.sheetBackground)
}

#Preview("Everything, zh, dark") {
    EverythingSheet(preview: SettingsSamples.everything())
        .background(Palette.sheetBackground)
        .environment(\.locale, Locale(identifier: "zh-Hans"))
        .preferredColorScheme(.dark)
}

#Preview("Everything, loading") {
    EverythingSheet(preview: SettingsSamples.everything(loaded: false))
        .background(Palette.sheetBackground)
}

#Preview("Channel OpenDuet sheet") {
    ChannelAssistantSheet(preview: SettingsSamples.channel(), channel: AccountFixtures.channels[0], assistant: AccountFixtures.assistant)
        .background(Palette.sheetBackground)
}

#Preview("Skill") {
    SkillDetailPage(model: SettingsSamples.everything(), skillId: "s2", onBack: {})
        .background(Palette.sheetBackground)
}

#Preview("New skill") {
    NewSkillPage(model: SettingsSamples.everything(), onBack: {}, onCreated: { _ in })
        .background(Palette.sheetBackground)
}

#Preview("Import skills") {
    SkillImportPage(model: SettingsSamples.everything(), onBack: {}, onImported: { _ in })
        .background(Palette.sheetBackground)
}

#Preview("Add connector") {
    AddConnectorPage(model: SettingsSamples.everything(), onBack: {}, onAdded: { _ in })
        .background(Palette.sheetBackground)
}

#Preview("Connector, failed") {
    CustomConnectorPage(model: SettingsSamples.everything(), connectorId: "cc2", onBack: {})
        .background(Palette.sheetBackground)
}

#Preview("About you") {
    MemoryPage(model: MemoryLayerModel(layer: .aboutYou, state: SettingsSamples.aboutYou), title: Text("About you"), intro: Text(verbatim: "Preview"), onBack: {})
        .background(Palette.sheetBackground)
}
#endif
