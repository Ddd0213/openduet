// M11 (agent B) page logic: source badges and scope labels, the skill import selection, the Add
// connector / Edit connection forms (https URL, domain shape, header name, secrets dropped once
// sent), the channel switches' optimistic state, the soul editor's PUT body, fact links and the
// skill name rules.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private enum M11BSamples {
    static let date = Date(timeIntervalSince1970: 1_760_000_000)

    static func skill(_ id: String, _ name: String, source: SkillSource = .manual, files: [String] = [],
                      scope: AccessScope = .all, channels: [String] = []) -> Skill {
        Skill(id: id, name: name, description: "d", instructions: "i", createdAt: date, source: source, sourceUrl: nil,
              files: files.map { SkillFileInfo(path: $0, size: 10, text: true) }, scope: scope, channelIds: channels)
    }

    static func candidate(_ name: String) -> SkillImportPreview.Candidate {
        .init(name: name, description: "", excerpt: "", files: [], hasScripts: false, exists: false)
    }

    static func preview(_ count: Int) -> SkillImportPreview {
        SkillImportPreview(importId: "imp_1", source: .zip, sourceUrl: nil,
                           skills: (0..<count).map { candidate("skill-\($0)") }, warnings: [])
    }

    static func item(_ kind: AccessKind, _ id: String, enabled: Bool, scope: AccessScope = .channels) -> ChannelAccess.Item {
        .init(kind: kind, id: id, name: id, description: "", scope: scope, enabled: enabled)
    }

    static func connector(kind: CustomConnector.Kind = .mcp, headers: [ConnectorHeader] = []) -> CustomConnector {
        CustomConnector(
            id: "cc1", kind: kind, name: "Wiki", description: "",
            url: kind == .mcp ? "https://mcp.example.com/mcp" : nil, domain: kind == .apiKey ? "api.example.com" : nil,
            headerName: kind == .apiKey ? "Authorization" : nil, valuePrefix: kind == .apiKey ? "Bearer " : nil,
            secret: kind == .apiKey ? SecretInfo(set: true, last4: "3f9a") : nil, headers: headers,
            status: .active, error: nil, tools: [], scope: .all, channelIds: [], createdAt: date
        )
    }
}

@Suite("M11b badges and labels")
struct UIM11BLabelTests {
    @Test("a fact's source badge: You, OpenDuet, Tidied up")
    func factBadges() {
        #expect(MemorySource.user.badge.key == "You")
        #expect(MemorySource.assistant.badge.key == "OpenDuet")
        #expect(MemorySource.dreaming.badge.key == "Tidied up")
    }

    @Test("a skill's source: Written by you, GitHub, Zip, OpenDuet")
    func skillSources() {
        #expect(SkillSource.manual.label.key == "Written by you")
        #expect(SkillSource.github.label.key == "GitHub")
        #expect(SkillSource.zip.label.key == "Zip")
        #expect(SkillSource.assistant.label.key == "OpenDuet")
    }

    @Test("scope: All channels, 1 channel, N channels, and only in Everything when on nowhere")
    func scopes() {
        #expect(ScopeLabel.text(scope: .all, channelCount: 0).key == "All channels")
        #expect(ScopeLabel.text(scope: .all, channelCount: 4).key == "All channels")
        #expect(ScopeLabel.text(scope: .channels, channelCount: 0).key == "Only in Everything")
        #expect(ScopeLabel.text(scope: .channels, channelCount: 1).key == "1 channel")
        #expect(ScopeLabel.text(scope: .channels, channelCount: 3).key == "%lld channels")
    }

    @Test("the skill line: source, scope, then Has scripts only with a script file")
    func skillMeta() {
        let plain = M11BSamples.skill("s1", "notes", files: ["references/style.md"])
        #expect(SkillMeta.parts(plain).map(\.key) == ["Written by you", "All channels"])
        let scripted = M11BSamples.skill("s2", "pdf-tools", source: .github, files: ["scripts/fill.py"], scope: .channels, channels: ["c1", "c2"])
        #expect(SkillMeta.parts(scripted).map(\.key) == ["GitHub", "%lld channels", "Has scripts"])
    }

    @Test("a connector's quiet copy: kind, tool count, a saved secret's last 4")
    func connectorCopy() {
        #expect(ConnectorCopy.kindLabel(.mcp).key == "MCP server")
        #expect(ConnectorCopy.kindLabel(.apiKey).key == "API key")
        #expect(ConnectorCopy.toolCount(0).key == "No tools")
        #expect(ConnectorCopy.toolCount(1).key == "1 tool")
        #expect(ConnectorCopy.toolCount(7).key == "%lld tools")
        #expect(ConnectorCopy.secretLine(nil).key == "Not set")
        #expect(ConnectorCopy.secretLine(SecretInfo(set: false, last4: nil)).key == "Not set")
        #expect(ConnectorCopy.secretLine(SecretInfo(set: true, last4: "3f9a")).key == "Saved · ends in %@")
        #expect(ConnectorCopy.secretLine(SecretInfo(set: true, last4: nil)).key == "Saved")
        #expect(ConnectorCopy.address(M11BSamples.connector()) == "mcp.example.com/mcp")
        #expect(ConnectorCopy.address(M11BSamples.connector(kind: .apiKey)) == "api.example.com")
    }
}

@Suite("M11b skill import selection")
struct UIM11BImportSelectionTests {
    @Test("everything is picked to start with, at most 50")
    func startsPicked() {
        let small = SkillImportSelection(M11BSamples.preview(3))
        #expect(small.count == 3)
        let big = SkillImportSelection(M11BSamples.preview(60))
        #expect(big.count == SkillImportSelection.maxPerImport)
        #expect(big.isPicked("skill-49"))
        #expect(!big.isPicked("skill-50"))
        #expect(!big.canPick("skill-50"))
    }

    @Test("toggling unpicks and picks again; names not in the preview never get in")
    func toggles() {
        var selection = SkillImportSelection(M11BSamples.preview(3))
        selection.toggle("skill-1")
        #expect(!selection.isPicked("skill-1"))
        #expect(selection.count == 2)
        selection.toggle("skill-1")
        #expect(selection.isPicked("skill-1"))
        selection.toggle("not-there")
        #expect(!selection.isPicked("not-there"))
        #expect(selection.count == 3)
    }

    @Test("at the limit, unpicking one frees a place")
    func limit() {
        var selection = SkillImportSelection(M11BSamples.preview(52))
        selection.toggle("skill-51")
        #expect(!selection.isPicked("skill-51"))
        selection.toggle("skill-0")
        #expect(selection.canPick("skill-51"))
        selection.toggle("skill-51")
        #expect(selection.isPicked("skill-51"))
        #expect(selection.count == 50)
    }

    @Test("the import body keeps the preview's order and is nil with nothing picked")
    func request() {
        var selection = SkillImportSelection(M11BSamples.preview(3))
        selection.toggle("skill-0")
        selection.toggle("skill-0")
        let body = selection.request(importId: "imp_1", channelId: nil)
        #expect(body == SkillImportRequest(importId: "imp_1", names: ["skill-0", "skill-1", "skill-2"], channelId: nil))
        for name in ["skill-0", "skill-1", "skill-2"] { selection.toggle(name) }
        #expect(selection.request(importId: "imp_1", channelId: nil) == nil)
    }
}

@Suite("M11b Add connector form")
struct UIM11BConnectorFormTests {
    @Test("an MCP address is https with a host and no spaces")
    func httpsURL() {
        #expect(ConnectorFormRules.isHTTPSURL("https://mcp.example.com/mcp"))
        #expect(ConnectorFormRules.isHTTPSURL("  https://mcp.example.com  "))
        #expect(!ConnectorFormRules.isHTTPSURL("http://mcp.example.com"))
        #expect(!ConnectorFormRules.isHTTPSURL("mcp.example.com"))
        #expect(!ConnectorFormRules.isHTTPSURL("https://"))
        #expect(!ConnectorFormRules.isHTTPSURL("https://mcp example.com"))
    }

    @Test("a domain is a public host name; a scheme or path typed with it is dropped")
    func domains() {
        #expect(ConnectorFormRules.isDomain("api.example.com"))
        #expect(ConnectorFormRules.isDomain("https://API.Example.com/v1/"))
        #expect(ConnectorFormRules.normalizedDomain("https://API.Example.com/v1/") == "api.example.com")
        #expect(ConnectorFormRules.normalizedDomain("api.example.com.") == "api.example.com")
        #expect(ConnectorFormRules.isDomain("xn--fiqs8s.xn--55qx5d"))
        #expect(!ConnectorFormRules.isDomain("localhost"))
        #expect(!ConnectorFormRules.isDomain("10.0.0.1"))
        #expect(!ConnectorFormRules.isDomain("api.example.com:8443"))
        #expect(!ConnectorFormRules.isDomain("-api.example.com"))
        #expect(!ConnectorFormRules.isDomain(""))
    }

    @Test("a header name is letters, digits and dashes, up to 64")
    func headerNames() {
        #expect(ConnectorFormRules.isHeaderName("Authorization"))
        #expect(ConnectorFormRules.isHeaderName("X-Api-Key"))
        #expect(!ConnectorFormRules.isHeaderName(""))
        #expect(!ConnectorFormRules.isHeaderName("X Api"))
        #expect(!ConnectorFormRules.isHeaderName("X_Api"))
        #expect(!ConnectorFormRules.isHeaderName(String(repeating: "a", count: 65)))
    }

    @Test("Save stays off until it's complete; format problems show only for typed fields")
    func completeness() {
        var draft = ConnectorDraft()
        #expect(!draft.canSave)
        #expect(draft.problems.isEmpty)
        draft.name = "Wiki"
        draft.url = "http://mcp.example.com"
        #expect(draft.problems == [.url])
        draft.url = "https://mcp.example.com/mcp"
        #expect(draft.canSave)
        draft.headers = [HeaderDraft(name: "Authorization", value: "")]
        #expect(!draft.canSave)
        draft.headers.append(HeaderDraft(name: "authorization", value: "x"))
        draft.headers[0].value = "Bearer t"
        #expect(draft.problems.contains(.duplicateHeader))
        draft.headers[1].name = "X Team"
        #expect(draft.problems == [.headerName])
    }

    @Test("the MCP body is trimmed; secrets leave the draft once it's sent, the rest stays")
    func mcpBodyAndSecrets() {
        var draft = ConnectorDraft()
        draft.name = " Wiki "
        draft.url = " https://mcp.example.com/mcp "
        draft.headers = [HeaderDraft(name: "Authorization", value: " Bearer t ", secret: true),
                         HeaderDraft(name: "X-Team", value: "docs", secret: false)]
        #expect(draft.request == .mcp(name: "Wiki", description: "", url: "https://mcp.example.com/mcp", headers: [
            .init(name: "Authorization", value: "Bearer t", secret: true), .init(name: "X-Team", value: "docs", secret: false),
        ]))
        #expect(draft.hasSecrets)
        draft.dropSecrets()
        #expect(!draft.hasSecrets)
        #expect(draft.headers.map(\.value) == ["", "docs"])
        #expect(draft.name == " Wiki ")
        #expect(draft.url == " https://mcp.example.com/mcp ")
        #expect(!draft.canSave)
    }

    @Test("the API key body: the domain as the server keeps it, the prefix as typed")
    func apiKeyBody() {
        var draft = ConnectorDraft()
        draft.kind = .apiKey
        draft.name = "Weather"
        draft.domain = "https://API.weather.example.com/"
        #expect(!draft.canSave)
        draft.key = " sk-123 "
        #expect(draft.request == .apiKey(name: "Weather", description: "", domain: "api.weather.example.com",
                                         headerName: "Authorization", valuePrefix: "Bearer ", key: "sk-123"))
        draft.valuePrefix = String(repeating: "x", count: 21)
        #expect(draft.problems == [.prefix])
        draft.valuePrefix = ""
        draft.dropSecrets()
        #expect(draft.key.isEmpty)
        #expect(draft.domain == "https://API.weather.example.com/")
    }
}

@Suite("M11b Edit connection")
struct UIM11BEditConnectionTests {
    private let stored = ConnectorHeader(name: "Authorization", secret: true, value: nil, secretInfo: SecretInfo(set: true, last4: "a1b2"))

    @Test("nothing changed: no PATCH; a new name alone sends only the name")
    func onlyChanges() {
        var draft = ConnectorEditDraft(M11BSamples.connector(headers: [stored]))
        #expect(draft.isComplete)
        #expect(draft.request == nil)
        draft.name = "Team wiki"
        #expect(draft.request == UpdateCustomConnectorRequest(name: "Team wiki"))
    }

    @Test("a stored secret left blank keeps its vault value (value null); a new header is sent whole")
    func storedSecret() {
        var draft = ConnectorEditDraft(M11BSamples.connector(headers: [stored]))
        #expect(draft.headers.first?.value == "")
        draft.headers.append(HeaderDraft(name: "X-Team", value: "docs", secret: false))
        #expect(draft.request?.headers == [
            .init(name: "Authorization", value: nil, secret: true), .init(name: "X-Team", value: "docs", secret: false),
        ])
        draft.headers[0].secret = false
        #expect(!draft.isComplete)
    }

    @Test("an API key: a new key is sent, blank keeps the saved one; the key leaves after sending")
    func apiKey() {
        var draft = ConnectorEditDraft(M11BSamples.connector(kind: .apiKey))
        #expect(draft.request == nil)
        draft.key = " sk-new "
        #expect(draft.request == UpdateCustomConnectorRequest(key: "sk-new"))
        draft.dropSecrets()
        #expect(draft.key.isEmpty)
        #expect(draft.request == nil)
        draft.domain = "localhost"
        #expect(draft.problems == [.domain])
        #expect(draft.request == nil)
    }
}

@Suite("M11b channel switches")
struct UIM11BAccessToggleTests {
    private let skill = M11BSamples.item(.skill, "s1", enabled: false)
    private let app = M11BSamples.item(.app, "gmail", enabled: true, scope: .all)

    private func access(_ items: [ChannelAccess.Item]) -> ChannelAccess { ChannelAccess(channelId: "c1", items: items) }

    @Test("a tap shows at once and sends one change; a second tap while it runs sends nothing")
    func optimistic() {
        var toggles = AccessToggles(access([skill, app]))
        let body = toggles.begin(skill, on: true)
        #expect(body == UpdateChannelAccessRequest(changes: [.init(kind: .skill, id: "s1", enabled: true)]))
        #expect(toggles.isOn(skill))
        #expect(toggles.isBusy(skill))
        #expect(toggles.begin(skill, on: false) == nil)
        #expect(toggles.begin(app, on: true) == nil)
    }

    @Test("a failure puts it back with the reason; cancelled leaves no line")
    func rollback() {
        var toggles = AccessToggles(access([skill]))
        _ = toggles.begin(skill, on: true)
        toggles.fail(skill.ref, reason: "Can't reach your server.")
        #expect(!toggles.isOn(skill))
        #expect(!toggles.isBusy(skill))
        #expect(toggles.failure(skill) == "Can't reach your server.")
        _ = toggles.begin(skill, on: true)
        #expect(toggles.failure(skill) == nil)
        toggles.fail(skill.ref, reason: nil)
        #expect(toggles.failure(skill) == nil)
    }

    @Test("the answer is the truth; another row still in flight keeps its tapped value")
    func answer() {
        var toggles = AccessToggles(access([skill, app]))
        _ = toggles.begin(skill, on: true)
        _ = toggles.begin(app, on: false)
        var onSkill = skill
        onSkill.enabled = true
        toggles.succeed(skill.ref, with: access([onSkill, app]))
        #expect(toggles.isOn(onSkill))
        #expect(!toggles.isBusy(onSkill))
        #expect(!toggles.isOn(app))
        #expect(toggles.isBusy(app))
    }

    @Test("sections go skills, connectors, apps; empty kinds are left out")
    func sections() {
        let connector = M11BSamples.item(.connector, "cc1", enabled: true)
        let toggles = AccessToggles(access([app, connector, skill]))
        #expect(toggles.sections.map(\.kind) == [.skill, .connector, .app])
        #expect(AccessToggles(access([app])).sections.map(\.kind) == [.app])
        #expect(AccessKind.connector.sectionTitle.key == "Custom connectors")
    }
}

@Suite("M11b soul, facts and skill rules")
struct UIM11BRulesTests {
    private let soul = Soul(name: "Claude", addressAs: "", identity: "A careful helper.", persona: "", tone: "", updatedAt: nil)

    @Test("Who OpenDuet is: PUT only what changed, trimmed; nothing changed is no request")
    func soulBody() {
        var draft = SoulDraft(soul)
        #expect(draft.request(from: soul) == nil)
        draft.addressAs = "  Alex "
        draft.identity = "A careful helper.  "
        #expect(draft.request(from: soul) == UpdateSoulRequest(addressAs: "Alex"))
        draft.name = String(repeating: "n", count: 41)
        #expect(!draft.isValid)
        #expect(draft.remaining(.name) == -1)
        #expect(SoulDraft.summary(soul) == "Claude · A careful helper.")
        #expect(SoulDraft.summary(Soul(name: " ", addressAs: "x", identity: "", persona: "", tone: "", updatedAt: nil)) == nil)
    }

    @Test("a channel fact links to the channel's thread; About you and typed facts don't")
    func factLinks() {
        let fromChat = MemoryFact(id: "f1", text: "t", source: .assistant, sourceMessageId: "m1", createdAt: M11BSamples.date)
        let typed = MemoryFact(id: "f2", text: "t", source: .user, createdAt: M11BSamples.date)
        let url = FactList.sourceRoute(fromChat, channelId: "c1")
        #expect(url?.absoluteString == "duet://channels/c1")
        #expect(url.flatMap(DuetRoute.init) == .channel(id: "c1"))
        #expect(FactList.sourceRoute(fromChat, channelId: nil) == nil)
        #expect(FactList.sourceRoute(typed, channelId: "c1") == nil)
    }

    @Test("facts: an edit replaces in place, a new one goes first; text is trimmed and limited")
    func facts() {
        let a = MemoryFact(id: "a", text: "one", createdAt: M11BSamples.date)
        let b = MemoryFact(id: "b", text: "two", createdAt: M11BSamples.date)
        var edited = a
        edited.text = "one, edited"
        #expect(FactList.upsert(edited, into: [a, b]).map(\.text) == ["one, edited", "two"])
        #expect(FactList.upsert(MemoryFact(id: "c", text: "new", createdAt: M11BSamples.date), into: [a, b]).map(\.id) == ["c", "a", "b"])
        #expect(FactList.remove("a", from: [a, b]).map(\.id) == ["b"])
        #expect(FactList.cleaned("  hi  ") == "hi")
        #expect(FactList.cleaned("   ") == nil)
        #expect(FactList.cleaned(String(repeating: "x", count: FactList.maxLength + 1)) == nil)
    }

    @Test("skill names: lowercase, digits and dashes; a typed title gets a suggestion")
    func skillNames() {
        #expect(SkillRules.isValidName("my-writing-style"))
        #expect(SkillRules.isValidName("a1"))
        #expect(!SkillRules.isValidName("-style"))
        #expect(!SkillRules.isValidName("My Style"))
        #expect(!SkillRules.isValidName(String(repeating: "a", count: 65)))
        #expect(SkillRules.suggestedName("My Writing Style") == "my-writing-style")
        #expect(SkillRules.suggestedName("Café notes!") == "cafe-notes")
        #expect(SkillRules.suggestedName("你好") == nil)
    }

    @Test("an import or save replaces a skill by name; the library stays sorted by name")
    func merge() {
        let old = M11BSamples.skill("s1", "pdf-tools")
        let other = M11BSamples.skill("s2", "brand-voice")
        let incoming = M11BSamples.skill("s1", "pdf-tools", source: .zip)
        let merged = SkillRules.merge([incoming, M11BSamples.skill("s3", "alpha")], into: [old, other])
        #expect(merged.map(\.name) == ["alpha", "brand-voice", "pdf-tools"])
        #expect(merged.last?.source == .zip)
    }

    @Test("a GitHub link: https is added; other hosts and a bare owner are refused")
    func githubLinks() {
        #expect(SkillRules.githubURL("github.com/acme/skills") == "https://github.com/acme/skills")
        #expect(SkillRules.githubURL("https://github.com/acme/skills/tree/main/pdf") == "https://github.com/acme/skills/tree/main/pdf")
        #expect(SkillRules.githubURL("https://gitlab.com/acme/skills") == nil)
        #expect(SkillRules.githubURL("https://github.com/acme") == nil)
        #expect(SkillRules.githubURL("http://github.com/acme/skills") == nil)
        #expect(SkillRules.githubURL("  ") == nil)
    }

    @Test("an edit needs instructions and fits the limits; only what changed is sent")
    func skillEdit() {
        let saved = M11BSamples.skill("s1", "notes")
        #expect(SkillRules.update(description: "d", instructions: " i ", saved: saved) == nil)
        #expect(SkillRules.update(description: "new", instructions: "i", saved: saved) == UpdateSkillRequest(description: "new"))
        #expect(!SkillRules.isValidEdit(description: "d", instructions: "  "))
        #expect(!SkillRules.isValidEdit(description: String(repeating: "d", count: 1025), instructions: "i"))
    }

    @Test("a failure's inline line: the server's message for a 400, nothing when cancelled")
    func reasons() {
        #expect(SettingsReason.line(for: CancellationError()) == nil)
        #expect(SettingsReason.line(for: APIError.validationFailed(field: "url", message: " url: not a valid URL ")) == "url: not a valid URL")
        #expect(SettingsReason.line(for: APIError.unreachable) == APIError.unreachable.localizedReason)
    }

    @Test("a load keeps what was shown while it reloads; a failure shows only with nothing loaded")
    func loadable() {
        var state = Loadable<Int>()
        #expect(state.display == .loading)
        state.fail("down")
        #expect(state.display == .failed("down"))
        state.finish(3)
        #expect(state.display == .loaded(3))
        state.begin()
        state.fail("down")
        #expect(state.display == .loaded(3))
    }
}
