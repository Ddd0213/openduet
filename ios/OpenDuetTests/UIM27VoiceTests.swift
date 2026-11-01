// M27 W5: the Voice page's rows per key state and kind (grey without a key, StepFun's region),
// the Model list (added realtime first, then remote realtime not added), the voices per provider,
// an old server's VoiceSettings -> M13's page; the recognizer rule and its notes, the multipart
// body with `language`, the WAV settings; Models without realtime rows anywhere; the provider
// forms' rows (no Base URL for Gemini / StepFun, Region for StepFun, a proxy read-only).
import AVFoundation
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

private enum M27 {
    static func provider(
        _ id: String, kind: String = "stepfun", region: String? = "cn", key: Bool = true, last4: String? = "k3Y9",
        status: String = "active", error: String? = nil, models: [String] = [], voices: [String] = ["v1", "v2"]
    ) -> [String: Any] {
        var secret: [String: Any] = ["set": key, "last4": NSNull()]
        if key, let last4 { secret["last4"] = last4 }
        return [
            "id": id, "kind": kind, "name": "Name \(id)", "region": region ?? NSNull(),
            "key": secret,
            "status": status, "error": error ?? NSNull(), "voices": voices,
            "realtimeModels": models.map { ["id": $0, "modelId": "rt-\($0)", "label": "RT \($0)"] },
        ]
    }

    static var presets: [[String: Any]] {
        [
            ["kind": "gemini", "regions": [], "defaultRegion": NSNull()],
            ["kind": "stepfun", "regions": [["region": "cn", "host": "api.stepfun.com"], ["region": "intl", "host": "api.stepfun.ai"]], "defaultRegion": "cn"],
        ]
    }

    static func dictation(_ engine: String = "device", onDevice: Bool = false, provider: String? = nil, model: String? = nil, ready: Bool = false) -> [String: Any] {
        ["engine": engine, "onDeviceOnly": onDevice, "providerId": provider ?? NSNull(), "modelId": model ?? NSNull(), "cloudReady": ready]
    }

    static func settings(
        modelId: String? = nil, voice: String? = nil, providers: [[String: Any]] = [], presets: [[String: Any]]? = M27.presets,
        dictation: [String: Any]? = nil
    ) -> VoiceSettings {
        var json: [String: Any] = [
            "modelId": modelId ?? NSNull(), "voice": voice ?? NSNull(),
            "voices": ["gemini": ["Puck"], "stepfun": ["qingchunshaonv"]], "configured": modelId != nil,
        ]
        if !providers.isEmpty || presets != nil { json["providers"] = providers }
        if let presets { json["presets"] = presets }
        if let dictation { json["dictation"] = dictation }
        let data = try! JSONSerialization.data(withJSONObject: json)
        return try! JSONCoding.decoder().decode(VoiceSettings.self, from: data)
    }

    static func remote(_ id: String, realtime: Bool = false, transcription: Bool = false, added: String? = nil) -> RemoteModel {
        var model = RemoteModel(modelId: id, label: id.uppercased(), contextWindow: 128_000, maxOutputTokens: 8192,
                                thinkingLevels: [], thinkingFormat: .noThinking, tools: true, vision: false, realtime: realtime,
                                source: .defaults, addedAs: added)
        model.transcription = transcription
        return model
    }

    static func modelProvider(_ kind: ProviderKind, baseUrl: String, region: ProviderRegion? = nil) -> ModelProvider {
        var provider = ModelProvider(
            id: "p", kind: kind, wireProtocol: .openai, name: "P", baseUrl: baseUrl, auth: nil,
            key: SecretInfo(set: true, last4: "9xQa"), headers: [], status: .active, error: nil, imported: false,
            modelCount: 2, createdAt: Date(timeIntervalSince1970: 1_760_000_000)
        )
        provider.region = region
        return provider
    }
}

@Suite("M27 Voice page")
struct UIM27VoicePageTests {
    @Test("an older server (no providers, no presets) gets M13's page; a current one Codync's with Add <kind>")
    func layouts() {
        let old = M27.settings(modelId: "m1", presets: nil)
        #expect(VoicePageRules.layout(old) == .legacy)
        #expect(old.dictation == .standard)
        let fresh = M27.settings()
        #expect(VoicePageRules.layout(fresh) == .current)
        #expect(VoicePageRules.providerChoices(fresh) == [.add(.gemini), .add(.stepfun)])
        #expect(VoicePageRules.defaultChoice(fresh) == .add(.gemini))
        let some = M27.settings(providers: [M27.provider("s1")])
        #expect(VoicePageRules.providerChoices(some) == [.existing("s1"), .add(.gemini)])
        // An added provider takes the place of "Add <its kind>".
        #expect(VoicePageRules.choice(.add(.stepfun), in: some) == .existing("s1"))
    }

    @Test("the key area's three states: none, saved with last4, failed with the reason")
    func keyStates() {
        func state(_ json: [String: Any]) -> VoiceKeyState {
            VoicePageRules.keyState(M27.settings(providers: [json]).providers.first)
        }
        #expect(VoicePageRules.keyState(nil) == .none)
        #expect(state(M27.provider("a", key: false)) == .none)
        #expect(state(M27.provider("a")) == .saved(last4: "k3Y9"))
        #expect(state(M27.provider("a", status: "failed", error: " StepFun refused the key. ")) == .failed(last4: "k3Y9", reason: "StepFun refused the key."))
        #expect(state(M27.provider("a", status: "failed")) == .failed(last4: "k3Y9", reason: String(localized: "Can't connect")))
    }

    @Test("rows per kind: Gemini without Region, StepFun with; Model and Voice grey without a key")
    func rows() {
        let settings = M27.settings(providers: [M27.provider("g", kind: "gemini", region: nil, key: false), M27.provider("s")])
        let gemini = VoicePageRules.layout(.existing("g"), in: settings)
        #expect(gemini.rows == [.provider, .key, .model, .voice])
        #expect(!gemini.choicesEnabled && gemini.showsKeyFootnote && !gemini.showsStepNote)
        let stepfun = VoicePageRules.layout(.existing("s"), in: settings)
        #expect(stepfun.rows == [.provider, .region, .key, .model, .voice])
        #expect(stepfun.choicesEnabled && !stepfun.showsKeyFootnote && stepfun.showsStepNote)
        let adding = VoicePageRules.layout(.add(.stepfun), in: M27.settings())
        #expect(adding.rows.contains(.region) && adding.key == .none && !adding.choicesEnabled)
        // An older server's presets carry no regions: no Region row.
        let noRegions = M27.settings(providers: [M27.provider("s")], presets: [["kind": "stepfun", "regions": [], "defaultRegion": NSNull()]])
        #expect(!VoicePageRules.layout(.existing("s"), in: noRegions).rows.contains(.region))
        #expect(VoicePageRules.keyFootnote(.stepfun) == String(localized: "Add a key to choose from \(String(localized: VoiceEngineKind.stepfun.title))'s models."))
    }

    @Test("Model: added realtime first, then the provider's remote realtime rows not added yet")
    func models() {
        let settings = M27.settings(providers: [M27.provider("s", models: ["a"])])
        let remote = [
            M27.remote("rt-a", realtime: true), M27.remote("rt-b", realtime: true),
            M27.remote("rt-c", realtime: true, added: "mdl_c"), M27.remote("chat", realtime: false),
        ]
        let choices = VoicePageRules.modelChoices(settings.providers.first, remote: remote)
        #expect(choices.map(\.id) == ["added:a", "remote:rt-b"])
        #expect(VoicePageRules.modelChoices(nil, remote: remote).isEmpty)
    }

    @Test("Voice: the provider's own list once its model is the one calls use; Default otherwise")
    func voices() {
        let settings = M27.settings(modelId: "a", voice: "v2", providers: [
            M27.provider("s", models: ["a"], voices: ["v1", "v2"]), M27.provider("g", kind: "gemini", region: nil, models: ["b"], voices: ["Puck"]),
        ])
        let step = settings.providers[0], gemini = settings.providers[1]
        #expect(VoicePageRules.voices(step, in: settings) == ["v1", "v2"])
        #expect(VoicePageRules.voice(step, in: settings) == "v2")
        #expect(VoicePageRules.voices(gemini, in: settings).isEmpty)
        #expect(VoicePageRules.voice(gemini, in: settings) == nil)
        // Picking Gemini switches calls to its first model; picking the one in use sends nothing.
        #expect(VoicePageRules.modelOnPick(gemini, in: settings) == "b")
        #expect(VoicePageRules.modelOnPick(step, in: settings) == nil)
    }

    @Test("the model calls use: the chosen one while its provider is usable, else the first usable one")
    func current() {
        let chosen = M27.settings(modelId: "b", providers: [M27.provider("s", models: ["a"]), M27.provider("g", kind: "gemini", region: nil, models: ["b"])])
        #expect(VoiceModelRules.current(chosen)?.model.id == "b")
        let failed = M27.settings(modelId: "b", providers: [M27.provider("s", models: ["a"]), M27.provider("g", kind: "gemini", region: nil, status: "failed", models: ["b"])])
        #expect(VoiceModelRules.current(failed)?.model.id == "a")
        #expect(VoiceModelRules.current(M27.settings(providers: [M27.provider("s", key: false, models: ["a"])])) == nil)
        #expect(VoicePageRules.defaultChoice(chosen) == .existing("g"))
        #expect(VoicePageRules.billingLine(.gemini).contains(String(localized: VoiceEngineKind.gemini.title)))
    }
}

@Suite("M27 Speech recognition section")
struct UIM27DictationSectionTests {
    @Test("rows: iPhone with its switch; Cloud without a key points up; Cloud with Provider, Model and Try it or why not")
    func rows() {
        #expect(VoiceDictationRules.rows(M27.settings(dictation: M27.dictation())) == [.recognizer, .onDeviceOnly])
        #expect(VoiceDictationRules.rows(M27.settings(providers: [M27.provider("s", key: false)], dictation: M27.dictation("cloud"))) == [.recognizer, .needsKey])
        let notReady = M27.settings(providers: [M27.provider("s")], dictation: M27.dictation("cloud"))
        #expect(VoiceDictationRules.rows(notReady) == [.recognizer, .provider, .model, .notReady])
        #expect(VoiceDictationRules.notReadyLine(notReady) == String(localized: "Choose a provider to dictate with."))
        let noModel = M27.settings(providers: [M27.provider("s")], dictation: M27.dictation("cloud", provider: "s"))
        #expect(VoiceDictationRules.notReadyLine(noModel) == String(localized: "Choose the model that transcribes."))
        let ready = M27.settings(providers: [M27.provider("s")], dictation: M27.dictation("cloud", provider: "s", model: "stepaudio-2.5-asr", ready: true))
        #expect(VoiceDictationRules.rows(ready) == [.recognizer, .provider, .model, .tryIt])
        #expect(VoiceDictationRules.notReadyLine(ready) == nil)
    }

    @Test("Model: transcription rows first, then the rest, never realtime; a typed id stays listed")
    func models() {
        let remote = [M27.remote("chat-a"), M27.remote("live", realtime: true), M27.remote("asr", transcription: true), M27.remote("chat-b")]
        #expect(VoiceDictationRules.modelChoices(remote, saved: nil).map(\.modelId) == ["asr", "chat-a", "chat-b"])
        #expect(VoiceDictationRules.modelChoices(remote, saved: "typed-id").map(\.modelId) == ["typed-id", "asr", "chat-a", "chat-b"])
        #expect(VoiceDictationRules.suggestedModel(.stepfun, remote: remote) == "asr")
        #expect(VoiceDictationRules.suggestedModel(.gemini, remote: remote) == nil)
        #expect(VoiceDictationRules.typedModel("  my-asr \n") == "my-asr")
        #expect(VoiceDictationRules.typedModel("   ") == nil)
        #expect(VoiceDictationRules.typedModel(String(repeating: "a", count: 201)) == nil)
    }

    @Test("a write shows at once: a new provider clears the model; cloudReady as the server computes it")
    func optimistic() {
        let settings = M27.settings(providers: [M27.provider("s"), M27.provider("f", status: "failed")],
                                    dictation: M27.dictation("cloud", provider: "s", model: "asr", ready: true))
        let moved = VoiceDictationRules.optimistic(settings.dictation, UpdateDictationSettingsRequest(providerId: .set("f")), providers: settings.providers)
        #expect(moved.providerId == "f" && moved.modelId == nil && !moved.cloudReady)
        let both = VoiceDictationRules.optimistic(settings.dictation, UpdateDictationSettingsRequest(providerId: .set("s"), modelId: .set("x")), providers: settings.providers)
        #expect(both.modelId == "x" && both.cloudReady)
        let engine = VoiceDictationRules.optimistic(settings.dictation, UpdateDictationSettingsRequest(engine: .device), providers: settings.providers)
        #expect(engine.engine == .device && engine.cloudReady)
        // Switching to Cloud takes the only keyed provider (two: the user picks).
        #expect(VoiceDictationRules.providerOnCloud(M27.settings(providers: [M27.provider("s")]))?.id == "s")
        #expect(VoiceDictationRules.providerOnCloud(M27.settings(providers: [M27.provider("s"), M27.provider("t")])) == nil)
    }
}

@Suite("M27 composer microphone")
struct UIM27MicTests {
    @Test("the recognizer: iPhone (on-device switch), cloud ready, cloud not ready never falls back")
    func mode() {
        #expect(DictationRules.mode(.standard) == .device(onDeviceOnly: false))
        #expect(DictationRules.mode(DictationSettings(engine: .device, onDeviceOnly: true, providerId: nil, modelId: nil, cloudReady: true)) == .device(onDeviceOnly: true))
        #expect(DictationRules.mode(DictationSettings(engine: .cloud, onDeviceOnly: false, providerId: "s", modelId: "a", cloudReady: true)) == .cloud)
        #expect(DictationRules.mode(DictationSettings(engine: .cloud, onDeviceOnly: true, providerId: nil, modelId: nil, cloudReady: false)) == .cloudNotReady)
        #expect(DictationNote.notSetUp.offersVoice && DictationNote.notOnDevice.offersVoice)
    }

    @Test("the refusal text per code, and which notes offer Retry")
    func notes() {
        let failed = DictationNote.from(TranscriptionFailure(message: "StepFun refused the key (api.stepfun.ai)."))
        #expect(failed?.message == String(localized: "Couldn't transcribe. \("StepFun refused the key (api.stepfun.ai).")"))
        #expect(failed?.offersRetry == true && failed?.lasts == nil)
        #expect(DictationNote.from(APIError.notConfigured) == .notSetUp)
        #expect(DictationNote.from(APIError.tooLarge)?.message == String(localized: "Too long to transcribe (2 min max)"))
        #expect(DictationNote.from(APIError.validationFailed(field: "language", message: "")) == .language)
        #expect(DictationNote.from(APIError.validationFailed(field: "file", message: "")) == .badRecording)
        #expect(DictationNote.from(APIError.unsupportedType) == .badRecording)
        #expect(DictationNote.from(APIError.unreachable)?.offersRetry == true)
        #expect(DictationNote.from(APIError.server(status: 502, code: "transcription_failed")) == .failed(nil))
        #expect(DictationNote.from(CancellationError()) == nil)
        #expect(DictationNote.notSetUp.lasts == 8 && DictationNote.nothingHeard.lasts == 4)
        #expect(DictationNote.micNotAllowed.offersSettings && !DictationNote.tooLong.offersRetry)
    }

    @Test("clip length and language: under 0.5 s isn't sent; zh-CN for Chinese, else the English variant")
    func clipAndLanguage() {
        #expect(!DictationRules.shouldSend(seconds: 0.4) && DictationRules.shouldSend(seconds: 0.5))
        #expect(DictationRules.maxRecordingSeconds < TranscriptionLimits.maxSeconds)
        #expect(DictationRules.language(preferred: "zh-Hans", current: Locale(identifier: "zh_CN")) == "zh-CN")
        #expect(DictationRules.language(preferred: "en", current: Locale(identifier: "en_GB")) == "en-GB")
        #expect(DictationRules.language(preferred: "en", current: Locale(identifier: "fr_FR")) == "en-US")
    }

    @Test("the text goes where the cursor was, with a space against a word (none for CJK)")
    func insertion() {
        let middle = DictationInsertion.insert("brown", into: "the fox", at: 3)
        #expect(middle.text == "the brown fox" && middle.caret == 9)
        #expect(DictationInsertion.insert("world", into: "hello", at: nil).text == "hello world")
        #expect(DictationInsertion.insert("世界", into: "你好", at: nil).text == "你好世界")
        #expect(DictationInsertion.insert("", into: "draft", at: 2) == DictationInsertion(text: "draft", caret: 2))
        #expect(DictationInsertion.insert("ok", into: "a😀b", at: 2).text.contains("😀"))
    }

    @Test("the multipart body: `language` before the WAV file part")
    func multipart() throws {
        let form = MultipartForm()
        let body = form.body(fields: [("language", "zh-CN")], field: "file", fileName: "dictation.wav", mime: "audio/wav", data: Data("RIFF".utf8))
        let text = try #require(String(data: body, encoding: .utf8))
        let language = try #require(text.range(of: "name=\"language\"\r\n\r\nzh-CN\r\n"))
        let file = try #require(text.range(of: "name=\"file\"; filename=\"dictation.wav\""))
        #expect(language.upperBound <= file.lowerBound)
        #expect(text.contains("Content-Type: audio/wav"))
        #expect(text.hasSuffix("--\(form.boundary)--\r\n"))
    }

    @Test("the recorder writes 16 kHz mono 16-bit little-endian linear PCM")
    func recorder() {
        let settings = CloudRecorderSettings.settings
        #expect(settings[AVFormatIDKey] as? Int == Int(kAudioFormatLinearPCM))
        #expect(settings[AVSampleRateKey] as? Double == 16_000)
        #expect(settings[AVNumberOfChannelsKey] as? Int == 1)
        #expect(settings[AVLinearPCMBitDepthKey] as? Int == 16)
        #expect(settings[AVLinearPCMIsFloatKey] as? Bool == false)
        #expect(settings[AVLinearPCMIsBigEndianKey] as? Bool == false)
    }
}

@Suite("M27 Models without voice")
struct UIM27ModelsTests {
    private func entry(_ id: String, provider: String, purpose: ModelPurpose) -> ModelEntry {
        ModelEntry(
            id: id, providerId: provider, purpose: purpose, modelId: id, label: id, contextWindow: 128_000,
            maxOutputTokens: 8192, thinkingLevels: [], thinkingFormat: .noThinking, defaultThinking: nil, tools: true,
            vision: false, serverWebTools: false, promptCaching: false, source: .modelsDev, edited: [],
            createdAt: Date(timeIntervalSince1970: 1_760_000_000)
        )
    }

    @Test("no realtime models anywhere on Models: the groups, a provider's list, its count, the remote picker")
    func noRealtime() {
        let state = ModelsState(
            providers: [M27.modelProvider(.gemini, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai")],
            models: [entry("chat", provider: "p", purpose: .chat), entry("live", provider: "p", purpose: .realtime)],
            defaults: ModelDefaults(defaultModelId: "chat", defaultThinking: nil, utilityModelId: nil), configured: true
        )
        #expect(ModelCatalog.chatModels(of: "p", in: state).map(\.id) == ["chat"])
        #expect(ModelCatalog.groups(ModelCatalog.chatModels(state), in: state).flatMap { $0.models.map(\.id) } == ["chat"])
        let remote = [M27.remote("gemini-2.5-flash"), M27.remote("gemini-live", realtime: true)]
        #expect(RemoteModelSelection.chatRows(remote).map(\.modelId) == ["gemini-2.5-flash"])
    }
}

@Suite("M27 provider forms")
struct UIM27ProviderFormTests {
    private let regions = [ProviderRegionOption(region: .cn, host: "api.stepfun.com"), ProviderRegionOption(region: .intl, host: "api.stepfun.ai")]

    @Test("Add: no Base URL for Gemini / StepFun, Region for StepFun when the server lists regions")
    func addRows() {
        #expect(ProviderFormLayout.addRows(.custom, regions: []) == [.baseURL, .name, .key])
        #expect(ProviderFormLayout.addRows(.gemini, regions: []) == [.name, .key])
        #expect(ProviderFormLayout.addRows(.stepfun, regions: regions) == [.region, .name, .key])
        #expect(ProviderFormLayout.addRows(.stepfun, regions: []) == [.name, .key])
        let presets = M27.settings().presets
        #expect(ProviderRegionRules.options(for: .stepfun, presets: presets) == regions)
        #expect(ProviderRegionRules.options(for: .gemini, presets: presets).isEmpty)
        #expect(ProviderRegionRules.presetDefault(for: .stepfun, presets: presets) == .cn)
    }

    @Test("Edit: Base URL only where the address isn't fixed; a proxy set before M27 is read-only")
    func editRows() {
        let step = M27.modelProvider(.stepfun, baseUrl: "https://api.stepfun.ai/v1", region: .intl)
        #expect(ProviderFormLayout.editRows(step, regions: regions) == [.region, .name, .key])
        let proxy = M27.modelProvider(.stepfun, baseUrl: "https://llm-proxy.example.com/v1", region: .cn)
        #expect(ProviderFormLayout.isProxy(proxy, regions: regions))
        #expect(ProviderFormLayout.editRows(proxy, regions: regions) == [.region, .name, .key, .address])
        let openai = M27.modelProvider(.openai, baseUrl: "https://api.openai.com/v1")
        #expect(ProviderFormLayout.editRows(openai, regions: []) == [.name, .key, .baseURL])
        #expect(!ProviderEditDraft(step).showsBaseURL && ProviderEditDraft(openai).showsBaseURL)
        // The hidden address is never sent, even when the stored one is a proxy.
        var draft = ProviderEditDraft(proxy)
        draft.name = "Step"
        #expect(draft.request == UpdateModelProviderRequest(name: "Step"))
    }

    @Test("region: sent only when the server offers regions; the phone's region picks the default")
    func region() {
        var draft = ProviderDraft(kind: .stepfun)
        draft.key = "sk-step"
        draft.region = .intl
        #expect(draft.request?.region == nil)
        draft.offersRegion = true
        #expect(draft.request?.region == .intl)
        #expect(ProviderRegionRules.defaultRegion(localeRegion: "CN") == .cn)
        #expect(ProviderRegionRules.defaultRegion(localeRegion: "us") == .intl)
        #expect(ProviderRegionRules.defaultRegion(localeRegion: nil) == nil)
        #expect(ProviderRegionRules.defaultRegion(localeRegion: "419") == nil)
        #expect(ProviderRegionRules.shownRegion(nil, preset: nil) == .cn)
    }

    @Test("a 400 field region: the key is for the other site; Switch unless the provider is there already")
    func wrongSite() {
        let refused = APIError.validationFailed(field: "region", message: "this key belongs to StepFun's international site (api.stepfun.ai)")
        let adding = ProviderRegionRules.wrongSite(refused, tried: .cn, saved: nil)
        #expect(adding == WrongSite(belongsTo: .intl, switchTo: .intl))
        #expect(ProviderRegionRules.wrongSiteText(try! #require(adding)) == String(localized: "This key is for StepFun's international site."))
        let staying = ProviderRegionRules.wrongSite(refused, tried: .intl, saved: .cn)
        #expect(staying == WrongSite(belongsTo: .cn, switchTo: nil))
        #expect(ProviderRegionRules.wrongSite(APIError.validationFailed(field: "key", message: ""), tried: .cn, saved: nil) == nil)
    }
}
