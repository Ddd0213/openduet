// M27 contract B: a provider's region (unknown or missing reads nil), the Voice page's answer
// (providers with key state and voices, presets with regions, dictation; an M13 server's answer
// decodes with the defaults; a row of a kind this build doesn't know is skipped), the dictation
// patch on PUT /api/voice-settings, region on the provider requests, RemoteModel.transcription and
// POST /api/transcriptions' answer and refusal code.
import Foundation
import Testing
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

@Suite("M27 voice contract")
struct DataM27VoiceContractTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.decoder().decode(T.self, from: Data(json.utf8))
    }

    private func object<T: Encodable>(_ value: T) throws -> NSDictionary {
        let data = try JSONCoding.encoder().encode(value)
        return try #require(try JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    private let provider = #"{"id":"prv_step","kind":"stepfun","protocol":"openai","name":"StepFun","baseUrl":"https://api.stepfun.com/v1","auth":null,"key":{"set":true,"last4":"k3Y9"},"headers":[],"status":"active","error":null,"imported":false,"modelCount":2,"createdAt":"2026-11-02T08:00:00.000Z","region":"cn"}"#

    private let voices = #""voices":{"gemini":["Puck","Kore"],"stepfun":["qingchunshaonv","wenrounansheng","linjiajiejie"]}"#

    @Test("A provider's region: cn and intl decode; null, missing or unknown read nil and the row still decodes")
    func region() throws {
        #expect(try decode(ModelProvider.self, provider).region == .cn)
        let intl = provider.replacingOccurrences(of: #""region":"cn""#, with: #""region":"intl""#)
        #expect(try decode(ModelProvider.self, intl).region == .intl)
        for other in [#""region":null"#, #""region":"eu""#, #""region":7"#] {
            let row = try decode(ModelProvider.self, provider.replacingOccurrences(of: #""region":"cn""#, with: other))
            #expect(row.region == nil && row.name == "StepFun" && row.kind == .stepfun)
        }
        let older = provider.replacingOccurrences(of: #","region":"cn""#, with: "")
        let row = try decode(ModelProvider.self, older)
        #expect(row.region == nil && row.modelCount == 2)
        #expect(try decode(ModelProviderResponse.self, #"{"provider":\#(provider)}"#).provider.region == .cn)
    }

    @Test("An M13 server's VoiceSettings decodes with no providers, no presets and Apple's recognizer")
    func olderVoiceSettings() throws {
        let settings = try decode(VoiceSettings.self, #"{"modelId":"mdl_step_rt","voice":"linjiajiejie",\#(voices),"configured":true}"#)
        #expect(settings.modelId == "mdl_step_rt" && settings.voice == "linjiajiejie" && settings.configured)
        #expect(settings.providers.isEmpty && settings.presets.isEmpty)
        #expect(settings.dictation == .standard && settings.dictation.engine == .device && !settings.dictation.cloudReady)
    }

    @Test("The Voice page's answer: providers with key, region, voices and models; presets; dictation")
    func voicePage() throws {
        let json = #"""
        {"modelId":"mdl_step_rt","voice":null,\#(voices),"configured":true,
         "providers":[
          {"id":"prv_step_intl","kind":"stepfun","name":"Step 国际","region":"intl","key":{"set":true,"last4":"k3Y9"},"status":"active","error":null,
           "voices":["soft-spoken-gentleman","lively-girl"],"realtimeModels":[{"id":"mdl_rt","modelId":"stepaudio-2.5-realtime","label":"StepAudio 2.5 Realtime"},{"id":"bad"}]},
          {"id":"prv_gemini","kind":"gemini","name":"Google Gemini","region":null,"key":{"set":false,"last4":null},"status":"failed","error":"the key was refused","voices":["Puck"],"realtimeModels":[]},
          {"id":"prv_openai","kind":"openai","name":"OpenAI","region":null,"key":{"set":true,"last4":"abcd"},"status":"active","error":null,"voices":[],"realtimeModels":[]}
         ],
         "presets":[{"kind":"gemini","regions":[],"defaultRegion":null},
                    {"kind":"stepfun","regions":[{"region":"cn","host":"api.stepfun.com"},{"region":"intl","host":"api.stepfun.ai"},{"region":"eu","host":"x"}],"defaultRegion":"intl"},
                    {"kind":"openai","regions":[],"defaultRegion":null}],
         "dictation":{"engine":"cloud","onDeviceOnly":false,"providerId":"prv_step_intl","modelId":"stepaudio-2.5-asr","cloudReady":true}}
        """#
        let settings = try decode(VoiceSettings.self, json)
        // a kind this build doesn't know (openai) is skipped, so is a model row that doesn't decode
        #expect(settings.providers.map(\.id) == ["prv_step_intl", "prv_gemini"])
        let step = try #require(settings.providers.first)
        #expect(step.kind == .stepfun && step.region == .intl && step.key.set && step.status == .active)
        #expect(step.voices.first == "soft-spoken-gentleman" && step.realtimeModels.map(\.modelId) == ["stepaudio-2.5-realtime"])
        let gemini = settings.providers[1]
        #expect(gemini.region == nil && !gemini.key.set && gemini.status == .failed && gemini.error == "the key was refused")
        #expect(settings.presets.map(\.kind) == [.gemini, .stepfun])
        #expect(settings.presets[1].regions.map(\.region) == [.cn, .intl] && settings.presets[1].defaultRegion == .intl)
        #expect(settings.presets[1].regions.first?.host == "api.stepfun.com")
        #expect(settings.dictation == DictationSettings(engine: .cloud, onDeviceOnly: false, providerId: "prv_step_intl", modelId: "stepaudio-2.5-asr", cloudReady: true))
    }

    @Test("Dictation settings: an unknown engine reads device; missing fields read the defaults")
    func dictationTolerant() throws {
        let newer = try decode(DictationSettings.self, #"{"engine":"server","onDeviceOnly":true,"providerId":null,"modelId":null,"cloudReady":false}"#)
        #expect(newer.engine == .device && newer.onDeviceOnly)
        #expect(try decode(DictationSettings.self, "{}") == .standard)
        #expect(DictationEngine.allCases.map(\.rawValue) == ["device", "cloud"])
        #expect(ProviderRegion.allCases.map(\.rawValue) == ["cn", "intl"])
    }

    @Test("PUT /api/voice-settings dictation: only the fields that change; null clears; M13 bodies unchanged")
    func dictationPatch() throws {
        let cloud = UpdateVoiceSettingsRequest(dictation: UpdateDictationSettingsRequest(engine: .cloud, providerId: .set("prv_step"), modelId: .set("stepaudio-2.5-asr")))
        #expect(try object(cloud) == ["dictation": ["engine": "cloud", "providerId": "prv_step", "modelId": "stepaudio-2.5-asr"]] as NSDictionary)
        let device = UpdateVoiceSettingsRequest(dictation: UpdateDictationSettingsRequest(engine: .device, onDeviceOnly: true))
        #expect(try object(device) == ["dictation": ["engine": "device", "onDeviceOnly": true]] as NSDictionary)
        let cleared = UpdateVoiceSettingsRequest(dictation: UpdateDictationSettingsRequest(providerId: .clear, modelId: .clear))
        #expect(try object(cleared) == ["dictation": ["providerId": NSNull(), "modelId": NSNull()]] as NSDictionary)
        // M13's requests encode as before (no dictation key)
        #expect(try object(UpdateVoiceSettingsRequest(voice: .clear)) == ["voice": NSNull()] as NSDictionary)
        let decoded = try decode(UpdateVoiceSettingsRequest.self, #"{"dictation":{"providerId":null,"engine":"cloud"}}"#)
        #expect(decoded.dictation == UpdateDictationSettingsRequest(engine: .cloud, providerId: .clear))
    }

    @Test("Provider requests carry region only when set")
    func providerRequests() throws {
        #expect(try object(CreateModelProviderRequest(kind: .stepfun, key: "k", region: .intl)) == ["kind": "stepfun", "key": "k", "region": "intl"] as NSDictionary)
        #expect(try object(CreateModelProviderRequest(kind: .gemini, key: "k")) == ["kind": "gemini", "key": "k"] as NSDictionary)
        #expect(try object(UpdateModelProviderRequest(region: .cn)) == ["region": "cn"] as NSDictionary)
        #expect(try object(UpdateModelProviderRequest(name: "Work")) == ["name": "Work"] as NSDictionary)
    }

    @Test("RemoteModel.transcription: read when sent, false from an older server")
    func remoteTranscription() throws {
        let row = #"{"modelId":"stepaudio-2.5-asr","label":"stepaudio-2.5-asr","contextWindow":128000,"maxOutputTokens":8192,"thinkingLevels":[],"thinkingFormat":"none","tools":true,"vision":false,"realtime":false,"source":"default","addedAs":null,"transcription":true}"#
        #expect(try decode(RemoteModel.self, row).transcription)
        let older = row.replacingOccurrences(of: #","transcription":true"#, with: "")
        let model = try decode(RemoteModel.self, older)
        #expect(!model.transcription && model.modelId == "stepaudio-2.5-asr")
        #expect(try decode(RemoteModelList.self, #"{"models":[\#(older)]}"#).models.count == 1)
    }

    @Test("Transcription: the text (also empty) and the 502 refusal code")
    func transcription() throws {
        #expect(try decode(TranscriptionResponse.self, #"{"text":"明天早上九点提醒我"}"#).text == "明天早上九点提醒我")
        #expect(try decode(TranscriptionResponse.self, #"{"text":""}"#).text.isEmpty)
        #expect(TranscriptionRefusal.allCases.map(\.rawValue) == ["transcription_failed"])
        let error = APIError(status: 502, body: Data(#"{"error":{"code":"transcription_failed","message":"StepFun refused the key (api.stepfun.ai)."}}"#.utf8))
        #expect(error == .server(status: 502, code: TranscriptionRefusal.transcriptionFailed.rawValue))
        #expect(TranscriptionLimits.maxBytes == 8 * 1024 * 1024 && TranscriptionLimits.maxSeconds == 120)
        // 120 s of the app's format fits the byte limit
        let bytes = TranscriptionLimits.maxSeconds * TranscriptionLimits.sampleRate * Double(TranscriptionLimits.channels * TranscriptionLimits.bitDepth / 8)
        #expect(bytes + 44 < Double(TranscriptionLimits.maxBytes))
    }

    @Test("Code that builds these models without the M27 fields still compiles and gets the defaults")
    func memberwise() {
        let provider = ModelProvider(
            id: "p1", kind: .openai, wireProtocol: .openai, name: "OpenAI", baseUrl: "https://api.openai.com/v1", auth: nil,
            key: SecretInfo(set: true, last4: "abcd"), headers: [], status: .active, error: nil, imported: false, modelCount: 0, createdAt: .now
        )
        #expect(provider.region == nil)
        let settings = VoiceSettings(modelId: nil, voice: nil, voices: .init(gemini: [], stepfun: []), configured: false)
        #expect(settings.providers.isEmpty && settings.dictation == .standard)
        let remote = RemoteModel(
            modelId: "m", label: "m", contextWindow: 1, maxOutputTokens: 1, thinkingLevels: [], thinkingFormat: .noThinking,
            tools: true, vision: false, realtime: false, source: .defaults, addedAs: nil
        )
        #expect(!remote.transcription)
        #expect(UpdateVoiceSettingsRequest(voice: .clear).dictation == nil)
    }
}
