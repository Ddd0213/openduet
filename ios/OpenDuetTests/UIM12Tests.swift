// M12 page logic: the thinking ladder, which models are usable, the effective model's levels,
// the Add provider / edit forms, the remote picker selection, the channel picker's optimistic
// state, the model editor's PATCH, the model_error card phases and the onboarding model step.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private enum M12 {
    static let date = Date(timeIntervalSince1970: 1_760_000_000)

    static func provider(_ id: String, key: Bool = true, kind: ProviderKind = .anthropic, wire: ProviderProtocol = .anthropic) -> ModelProvider {
        ModelProvider(
            id: id, kind: kind, wireProtocol: wire, name: id, baseUrl: "https://api.example.com",
            auth: wire == .anthropic ? .xApiKey : nil, key: SecretInfo(set: key, last4: key ? "9xQa" : nil),
            headers: [], status: .active, error: nil, imported: false, modelCount: 1, createdAt: date
        )
    }

    static func model(_ id: String, provider: String = "p1", purpose: ModelPurpose = .chat, tools: Bool = true,
                      levels: [ThinkingLevel] = [.off, .low, .medium, .high], edited: [String] = []) -> ModelEntry {
        ModelEntry(
            id: id, providerId: provider, purpose: purpose, modelId: id, label: "Model \(id)",
            contextWindow: 200_000, maxOutputTokens: 64_000, thinkingLevels: levels,
            thinkingFormat: levels.isEmpty ? .noThinking : .effort, defaultThinking: nil,
            tools: tools, vision: true, serverWebTools: false, promptCaching: false,
            source: .modelsDev, edited: edited, createdAt: date
        )
    }

    static func state(default defaultId: String? = "m1") -> ModelsState {
        ModelsState(
            providers: [provider("p1"), provider("p2", key: false), provider("p3", kind: .gemini, wire: .openai)],
            models: [
                model("m1", levels: [.off, .low, .medium, .high, .max]),
                model("m2", tools: false),
                model("m3", provider: "p2"),
                model("m4", provider: "p3", levels: [.off, .medium]),
                model("live", provider: "p3", purpose: .realtime, levels: []),
            ],
            defaults: ModelDefaults(defaultModelId: defaultId, defaultThinking: .medium, utilityModelId: nil),
            configured: defaultId != nil
        )
    }

    static func remote(_ id: String, added: String? = nil) -> RemoteModel {
        RemoteModel(modelId: id, label: id.uppercased(), contextWindow: 128_000, maxOutputTokens: 8192,
                    thinkingLevels: [], thinkingFormat: .noThinking, tools: true, vision: false, realtime: false,
                    source: .defaults, addedAs: added)
    }

    static func payload(_ state: ModelErrorPayload.State, retry: Bool = true) -> ModelErrorPayload {
        ModelErrorPayload(phrase: Phrase(key: "system.model_error", params: nil, text: nil), modelId: "m1",
                          modelLabel: " Claude Opus 4.6 ", runId: "run_1", retry: retry, state: state)
    }
}

@Suite("M12 thinking ladder")
struct UIM12LadderTests {
    @Test("levels compare by their place on the ladder")
    func order() {
        #expect(ThinkingLevel.off < .minimal)
        #expect(ThinkingLevel.high < .xhigh && ThinkingLevel.xhigh < .max)
        #expect(ThinkingLevel.allCases.sorted() == ThinkingLevel.allCases)
        #expect(ThinkingLevel.ladder([.max, .off, .medium, .off]) == [.off, .medium, .max])
    }

    @Test("a channel's levels are those of the model it runs on: its own, else the default")
    func effectiveLevels() {
        let state = M12.state()
        #expect(ModelCatalog.levels(of: ModelCatalog.effectiveModel(channelModelId: nil, in: state)) == [.off, .low, .medium, .high, .max])
        #expect(ModelCatalog.levels(of: ModelCatalog.effectiveModel(channelModelId: "m4", in: state)) == [.off, .medium])
        // A model that isn't usable any more (no key) falls back to the default.
        #expect(ModelCatalog.effectiveModel(channelModelId: "m3", in: state)?.id == "m1")
        #expect(ModelCatalog.levels(of: nil).isEmpty)
    }

    @Test("context sizes read as 200K, 1M, 1.5M")
    func tokens() {
        #expect(ModelCatalog.tokens(200_000) == "200K")
        #expect(ModelCatalog.tokens(1_048_576) == "1M")
        #expect(ModelCatalog.tokens(1_500_000) == "1.5M")
        #expect(ModelCatalog.tokens(8192) == "8K")
        #expect(ModelCatalog.tokens(512) == "512")
    }
}

@Suite("M12 usable models")
struct UIM12UsableTests {
    @Test("a usable chat model has purpose chat, tools and a provider with a key")
    func usable() {
        let state = M12.state()
        #expect(ModelCatalog.usableChatModels(state).map(\.id) == ["m1", "m4"])
        #expect(DefaultsRules.backgroundOptions(state).map(\.id) == ["m1", "m2", "m3", "m4"])
        #expect(ModelCatalog.voiceModels(state).map(\.id) == ["live"])
    }

    @Test("the default thinking offers the default model's levels; none without a default")
    func defaultsOptions() {
        #expect(DefaultsRules.thinkingOptions(M12.state()) == [.off, .low, .medium, .high, .max])
        #expect(DefaultsRules.thinkingOptions(M12.state(default: nil)).isEmpty)
        #expect(ModelChoiceCopy.defaultModel(M12.state(default: nil)) == String(localized: "Default"))
    }

    @Test("the models list groups by provider in server order, voice models apart")
    func groups() {
        let state = M12.state()
        let chat = ModelCatalog.groups(ModelCatalog.chatModels(state), in: state)
        #expect(chat.map(\.id) == ["p1", "p2", "p3"])
        #expect(chat.first?.models.map(\.id) == ["m1", "m2"])
        #expect(ModelCatalog.groups(ModelCatalog.voiceModels(state), in: state).map(\.id) == ["p3"])
    }

    @Test("badges: context, thinking count, tools, images, voice")
    func badges() {
        let state = M12.state()
        let opus = ModelBadge.badges(state.models[0])
        #expect(opus == [.context("200K"), .thinking(levels: 4), .tools, .vision])
        #expect(ModelBadge.badges(M12.model("x", levels: [.off, .medium])).contains(.thinking(levels: 1)))
        #expect(ModelBadge.badges(state.models[4]).last == .voice)
        #expect(ModelBadge.thinking(levels: 1).label.key == "Thinking")
    }

    @Test("Switch model lists the usable models, the failed one last")
    func switchOptions() {
        #expect(ModelErrorCopy.switchOptions(M12.state(), failed: "m1").map(\.id) == ["m4", "m1"])
    }
}

@Suite("M12 Add provider")
struct UIM12ProviderFormTests {
    @Test("a preset needs only the key; its request carries kind and key")
    func preset() throws {
        var draft = ProviderDraft(kind: .anthropic)
        #expect(!draft.canSave)
        draft.key = "  sk-ant-x \n"
        let body = try #require(draft.request)
        #expect(body == CreateModelProviderRequest(kind: .anthropic, key: "sk-ant-x"))
    }

    @Test("custom needs a base URL over https (http only for local addresses) and sends its protocol")
    func custom() throws {
        var draft = ProviderDraft(kind: .custom)
        draft.key = "gw"
        #expect(!draft.canSave)
        draft.baseUrl = "http://llm.example.com/v1"
        #expect(draft.problems.contains(.urlNeedsHTTPS))
        draft.baseUrl = "https://user:pw@llm.example.com"
        #expect(draft.problems.contains(.url))
        draft.baseUrl = "https://llm.example.com/v1?x=1"
        #expect(draft.problems.contains(.url))
        draft.baseUrl = "ftp://llm.example.com"
        #expect(draft.problems.contains(.url))
        draft.baseUrl = "http://192.168.1.20:8080/v1"
        #expect(draft.problems.isEmpty)
        draft.baseUrl = "https://llm.example.com/v1"
        draft.wireProtocol = .anthropic
        draft.auth = .bearer
        let body = try #require(draft.request)
        #expect(body.wireProtocol == .anthropic && body.auth == .bearer && body.baseUrl == "https://llm.example.com/v1")
    }

    @Test("local hosts: localhost, private ranges, a Docker service name; public ones aren't")
    func localHosts() {
        for host in ["localhost", "127.0.0.1", "10.0.0.5", "172.20.1.1", "192.168.0.2", "ollama", "box.local", "::1"] {
            #expect(ProviderFormRules.isLocalHost(host), "\(host)")
        }
        for host in ["llm.example.com", "8.8.8.8", "172.32.0.1", "2001:db8::1"] {
            #expect(!ProviderFormRules.isLocalHost(host), "\(host)")
        }
    }

    @Test("header names: letters, digits, dashes, never a credential, no duplicates; empty rows are ignored")
    func headers() throws {
        var draft = ProviderDraft(kind: .openai)
        draft.key = "k"
        draft.headers = [ProviderHeaderDraft(name: "X-Team", value: "shop"), ProviderHeaderDraft()]
        #expect(draft.problems.isEmpty)
        #expect(try #require(draft.request).headers == [ProviderHeader(name: "X-Team", value: "shop")])
        draft.headers.append(ProviderHeaderDraft(name: "Authorization", value: "Bearer x"))
        #expect(draft.problems.contains(.credentialHeader))
        draft.headers[2] = ProviderHeaderDraft(name: "X Team", value: "a")
        #expect(draft.problems.contains(.headerName))
        draft.headers[2] = ProviderHeaderDraft(name: "x-team", value: "b")
        #expect(draft.problems.contains(.duplicateHeader))
        #expect(ProviderHeaderRules.problem(draft.headers[2], in: draft.headers) == .duplicateHeader)
        #expect(ProviderFormRules.isCredentialName("X-Api-Key") && ProviderFormRules.isCredentialName("session_token"))
    }

    @Test("the key goes as soon as it's sent; the rest of a refused form stays")
    func dropKey() {
        var draft = ProviderDraft(kind: .custom)
        draft.baseUrl = "https://llm.example.com"
        draft.name = "Home"
        draft.key = "secret"
        _ = draft.request
        draft.dropSecrets()
        #expect(draft.key.isEmpty && draft.name == "Home" && draft.baseUrl == "https://llm.example.com")
        #expect(!draft.canSave)
    }

    @Test("the edit form PATCHes only what changed; a blank key keeps the stored one")
    func edit() throws {
        var draft = ProviderEditDraft(M12.provider("p1"))
        #expect(draft.request == nil)
        draft.name = " Work "
        #expect(try #require(draft.request) == UpdateModelProviderRequest(name: "Work"))
        #expect(!draft.rechecks)
        draft.key = "new-key"
        draft.auth = .bearer
        let body = try #require(draft.request)
        #expect(body.key == "new-key" && body.auth == .bearer && draft.rechecks)
        draft.dropSecrets()
        #expect(draft.request?.key == nil)
        draft.baseUrl = "not a url"
        #expect(draft.request == nil)
    }

    @Test("a new address needs the key again; the old address doesn't")
    func newAddressNeedsKey() throws {
        var draft = ProviderEditDraft(M12.provider("p1"))
        draft.baseUrl = "https://proxy.example.com/v1"
        #expect(draft.problems.contains(.keyForNewURL))
        #expect(draft.request == nil)
        draft.key = "new-key"
        #expect(!draft.problems.contains(.keyForNewURL))
        let body = try #require(draft.request)
        #expect(body.baseUrl == "https://proxy.example.com/v1" && body.key == "new-key")
        draft.key = ""
        draft.baseUrl = "https://api.example.com"
        #expect(!draft.problems.contains(.keyForNewURL))
    }
}

@Suite("M12 remote picker")
struct UIM12RemotePickerTests {
    @Test("added rows can't be picked; picks keep their order and make the batch request")
    func selection() throws {
        let models = [M12.remote("a"), M12.remote("b", added: "mdl_b"), M12.remote("c")]
        var selection = RemoteModelSelection()
        selection.toggle(models[1])
        #expect(selection.count == 0 && !selection.canPick(models[1]))
        selection.toggle(models[2])
        selection.toggle(models[0])
        #expect(try #require(selection.request(providerId: "p1")).modelIds == ["c", "a"])
        selection.toggle(models[2])
        #expect(selection.picked == ["a"])
        #expect(RemoteModelSelection().request(providerId: "p1") == nil)
    }

    @Test("a fresh list drops picks that are gone or were added meanwhile")
    func prune() {
        var selection = RemoteModelSelection()
        selection.toggle(M12.remote("a"))
        selection.toggle(M12.remote("b"))
        selection.prune(to: [M12.remote("a", added: "mdl_a")])
        #expect(selection.picked.isEmpty)
    }

    @Test("search matches the label or the id")
    func search() {
        let models = [M12.remote("claude-opus"), M12.remote("gemini-flash")]
        #expect(RemoteModelSelection.filter(models, query: "OPUS").map(\.modelId) == ["claude-opus"])
        #expect(RemoteModelSelection.filter(models, query: "  ").count == 2)
        #expect(RemoteModelSelection.filter(models, query: "zzz").isEmpty)
    }
}

@Suite("M12 channel model picker")
struct UIM12ChannelChoiceTests {
    @Test("picking a model shows at once and PATCHes it; a level the new model lacks goes back to Default")
    func pickModel() throws {
        let state = M12.state()
        var choice = ChannelModelChoice(modelId: nil, thinking: .max)
        let picked = choice.pickModel("m4", in: state)
        let body = try #require(picked)
        #expect(body.modelId == .set("m4") && body.thinkingLevel == .clear)
        #expect(choice.modelId == "m4" && choice.thinking == nil && choice.busy)
        // While it runs, another pick waits.
        let waiting = choice.pickThinking(.medium)
        #expect(waiting == nil)
        choice.succeed(modelId: "m4", thinking: nil)
        #expect(!choice.busy && choice.thinkingOptions(in: state) == [.off, .medium])
    }

    @Test("a failure puts the rows back with the reason; Default sends null")
    func rollback() throws {
        let state = M12.state()
        var choice = ChannelModelChoice(modelId: "m4", thinking: .medium)
        let picked = choice.pickModel(nil, in: state)
        let body = try #require(picked)
        #expect(body.modelId == .clear && body.thinkingLevel == nil)
        choice.fail(reason: "modelId: needs tools")
        #expect(choice.modelId == "m4" && choice.thinking == .medium && choice.failure == "modelId: needs tools")
        let levelBody = choice.pickThinking(nil)
        let level = try #require(levelBody)
        #expect(level.thinkingLevel == .clear && choice.failure == nil)
    }

    @Test("a channel event is taken unless a change is running; a lost model reads as missing")
    func sync() throws {
        let state = M12.state()
        var choice = ChannelModelChoice(modelId: nil, thinking: nil)
        let first = choice.pickThinking(.high)
        #expect(first != nil)
        choice.sync(modelId: "m4", thinking: nil)
        #expect(choice.thinking == .high && choice.modelId == nil)
        choice.fail(reason: nil)
        #expect(choice.modelId == "m4" && choice.thinking == nil)
        #expect(ChannelModelChoice(modelId: "m3", thinking: nil).ownModelMissing(in: state))
        #expect(ChannelModelChoice(modelId: "gone", thinking: nil).ownModelMissing(in: state))
        #expect(!ChannelModelChoice(modelId: "m1", thinking: nil).ownModelMissing(in: state))
    }
}

@Suite("M12 model editor")
struct UIM12ModelEditTests {
    @Test("only changed fields go out; Automatic sends null")
    func patch() throws {
        var draft = ModelEditDraft(M12.model("m1", levels: [.off, .medium]))
        #expect(draft.request == nil)
        draft.label = "Fast"
        draft.contextWindow = "1,000,000"
        draft.vision = false
        let body = try #require(draft.request)
        #expect(body == UpdateModelEntryRequest(label: "Fast", contextWindow: 1_000_000, vision: false))
        #expect(draft.changedFields == ["label", "contextWindow", "vision"])
    }

    @Test("level chips stay in ladder order; the last one off makes the format None")
    func chips() throws {
        var draft = ModelEditDraft(M12.model("m1", levels: [.off, .medium]))
        draft.toggle(.max)
        draft.toggle(.low)
        #expect(draft.levels == [.off, .low, .medium, .max])
        draft.setDefault(.max)
        draft.toggle(.max)
        #expect(draft.defaultThinking == nil)
        for level in draft.levels { draft.toggle(level) }
        #expect(draft.thinkingFormat == .noThinking)
        let body = try #require(draft.request)
        #expect(body.thinkingLevels == [] && body.thinkingFormat == .noThinking)
        draft.setFormat(.budget)
        #expect(draft.levels == [.off, .medium])
    }

    @Test("a level not offered can't be the default; numbers must be positive")
    func validation() {
        var draft = ModelEditDraft(M12.model("m1", levels: [.off, .medium]))
        draft.setDefault(.high)
        #expect(draft.defaultThinking == nil)
        draft.maxOutputTokens = "0"
        #expect(draft.problems == [.maxOutput])
        draft.maxOutputTokens = "8192"
        draft.label = "  "
        #expect(draft.problems == [.label] && draft.request == nil)
        #expect(ModelEditDraft(M12.model("m1", edited: ["label"])).wasEdited("label"))
    }
}

@Suite("M12 model_error card")
struct UIM12ModelErrorTests {
    @Test("phases: open, retrying while in flight, the reason on failure, folded once taken")
    func phases() {
        #expect(ModelErrorPhase(M12.payload(.open), request: nil) == .open)
        #expect(ModelErrorPhase(M12.payload(.open), request: .inFlight) == .retrying)
        #expect(ModelErrorPhase(M12.payload(.open), request: .failed(reason: "busy")) == .failed(reason: "busy"))
        #expect(ModelErrorPhase(M12.payload(.retrying), request: nil) == .retried)
        #expect(ModelErrorPhase(M12.payload(.dismissed), request: .inFlight) == .dismissed)
        #expect(ModelErrorPhase.retrying.isCollapsed && ModelErrorPhase.retried.isCollapsed && ModelErrorPhase.dismissed.isCollapsed)
        #expect(!ModelErrorPhase.failed(reason: "x").isCollapsed && ModelErrorPhase.failed(reason: "x").canAct)
        #expect(!ModelErrorPhase.retrying.canAct)
    }

    @Test("no retry: Set up models; the caption is the trimmed label")
    func copy() {
        #expect(ModelErrorCopy.needsSetup(M12.payload(.open, retry: false)))
        #expect(!ModelErrorCopy.needsSetup(M12.payload(.open)))
        #expect(ModelErrorCopy.caption(M12.payload(.open)) == "Claude Opus 4.6")
    }

    @Test("the onboarding model step: first run without a model only")
    func onboardingStep() {
        let first = OnboardingGate(onboardedAt: nil, finishedLocally: false)
        #expect(first.showsModelStep(modelsConfigured: false))
        #expect(!first.showsModelStep(modelsConfigured: true))
        var replay = OnboardingGate(onboardedAt: date, finishedLocally: false)
        replay.replay()
        #expect(!replay.showsModelStep(modelsConfigured: false))
        #expect(!OnboardingGate(onboardedAt: date, finishedLocally: false).showsModelStep(modelsConfigured: false))
    }

    private var date: Date { M12.date }
}
