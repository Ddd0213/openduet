// The settings' Voice page's data through `\.apiClient`: GET /api/voice-settings, and PUT for the
// model, the voice and (M27) the recognizer: shown at once, rolled back with the server's reason
// when refused. A change that turns `configured` on or off calls `onChange` (the session refreshes
// Me: features.voice). M27: a provider's key and region (POST / PATCH /api/providers, /test), its
// remote models, adding a realtime model, and "Try it" (POST /api/transcriptions); a provider
// write calls `onProvidersChanged` (the Models list reloads: one provider row for both pages).
// Every answer's dictation goes to DictationSettingsStore (the composer microphone).
import Foundation
import Observation

@MainActor @Observable
final class VoiceSettingsModel {
    private(set) var api: APIClient?
    private(set) var settings = Loadable<VoiceSettings>()
    /// A PUT in flight, and the reason of the last refusal.
    private(set) var busy = false
    private(set) var failure: String?
    /// M27: the Speech recognition section's PUT and its refusal
    private(set) var dictationBusy = false
    private(set) var dictationFailure: String?
    /// M27: GET /api/providers/:id/remote-models, per provider (the Model rows' options)
    private(set) var remote: [ID: Loadable<[RemoteModel]>] = [:]
    @ObservationIgnored var onChange: () -> Void = {}
    @ObservationIgnored var onProvidersChanged: @MainActor () async -> Void = {}

    init() {}

    func attach(_ api: APIClient?) {
        guard self.api == nil, let api else { return }
        self.api = api
    }

    private func client() throws -> APIClient {
        guard let api else { throw APIError.unreachable }
        return api
    }

    func load() async {
        guard let api else {
            if settings.value == nil { settings.fail(String(localized: "Can't reach your server.")) }
            return
        }
        settings.begin()
        do {
            take(try await api.voiceSettings())
        } catch {
            if let reason = SettingsReason.line(for: error) { settings.fail(reason) } else { settings.loading = false }
        }
    }

    /// A realtime model (its engine's voices come with it; the voice goes back to the default).
    func setModel(_ id: String) async {
        await update(UpdateVoiceSettingsRequest(modelId: .set(id), voice: .clear)) { value in
            value.modelId = id
            value.voice = nil
        }
    }

    /// A voice name, or nil for the engine's default.
    func setVoice(_ voice: String?) async {
        let patch: Patch<String> = voice.map { .set($0) } ?? .clear
        await update(UpdateVoiceSettingsRequest(voice: patch)) { $0.voice = voice }
    }

    private func update(_ body: UpdateVoiceSettingsRequest, optimistic: (inout VoiceSettings) -> Void) async {
        guard let api, var value = settings.value, !busy else { return }
        let before = value
        optimistic(&value)
        settings.finish(value)
        failure = nil
        busy = true
        defer { busy = false }
        do {
            take(try await api.updateVoiceSettings(body))
        } catch {
            settings.finish(before)
            failure = SettingsReason.line(for: error)
        }
    }

    private func take(_ next: VoiceSettings) {
        let was = settings.value?.configured
        settings.finish(next)
        if was != nil, was != next.configured { onChange() }
        if let api { DictationSettingsStore.shared.take(next.dictation, for: api) }
    }

    /// After a write only the server can fold into the answer (a key, a region, a new model).
    private func reload() async {
        guard let api, let next = try? await api.voiceSettings() else { return }
        take(next)
    }

    // MARK: - M27: providers (one row with Models: the key works for both pages)

    /// Add a Gemini / StepFun provider with its key (checked by the server first; 400 = its reason).
    func addProvider(_ kind: VoiceEngineKind, key: String, region: ProviderRegion?) async throws {
        let body = CreateModelProviderRequest(kind: kind.providerKind, key: key, region: region)
        _ = try await client().createProvider(body)
        await reload()
        await onProvidersChanged()
    }

    /// Replace the key and / or change the region (the key is checked again against the host).
    func updateProvider(_ id: ID, key: String? = nil, region: ProviderRegion? = nil) async throws {
        _ = try await client().updateProvider(id: id, UpdateModelProviderRequest(key: key, region: region))
        await reload()
        await onProvidersChanged()
    }

    /// Test key: a real request with the saved key; the status and its reason come back stored.
    func testProvider(_ id: ID) async throws {
        _ = try await client().testProvider(id: id)
        await reload()
        await onProvidersChanged()
    }

    /// The provider's own model list (once per page visit unless `force`).
    func loadRemote(_ providerId: ID, force: Bool = false) async {
        guard let api else { return }
        var list = remote[providerId] ?? Loadable()
        if !force, list.value != nil || list.loading { return }
        list.begin()
        remote[providerId] = list
        do {
            list.finish(try await api.remoteModels(providerId: providerId))
        } catch {
            if let reason = SettingsReason.line(for: error) { list.fail(reason) } else { list.loading = false }
        }
        remote[providerId] = list
    }

    /// The page appeared again: the lists load once more when opened.
    func forgetRemote() {
        remote = [:]
    }

    /// Model: an added one is set; a remote one is added first (POST /api/models, purpose realtime).
    func chooseModel(_ choice: VoiceModelChoice, providerId: ID) async {
        switch choice {
        case .added(let row):
            await setModel(row.id)
        case .remote(let model):
            guard !busy else { return }
            busy = true
            failure = nil
            do {
                let entry = try await client().addModel(
                    CreateModelEntryRequest(providerId: providerId, modelId: model.modelId, purpose: .realtime)
                )
                busy = false
                await reload()
                await setModel(entry.id)
                await onProvidersChanged()
                await loadRemote(providerId, force: true)
            } catch {
                busy = false
                failure = ModelsReason.addLine(error)
            }
        }
    }

    // MARK: - M27: speech recognition (the composer microphone)

    /// PUT {dictation: …}: shown at once, rolled back with the reason.
    func setDictation(_ patch: UpdateDictationSettingsRequest) async {
        guard let api, var value = settings.value, !dictationBusy else { return }
        let before = value
        value.dictation = VoiceDictationRules.optimistic(value.dictation, patch, providers: value.providers)
        settings.finish(value)
        dictationFailure = nil
        dictationBusy = true
        defer { dictationBusy = false }
        do {
            take(try await api.updateVoiceSettings(UpdateVoiceSettingsRequest(dictation: patch)))
        } catch {
            settings.finish(before)
            dictationFailure = SettingsReason.line(for: error)
        }
    }

    /// Recognizer: iPhone / Cloud. Cloud with no provider chosen takes the only one with a key.
    func setDictationEngine(_ engine: DictationEngine) async {
        guard let current = settings.value, current.dictation.engine != engine else { return }
        let provider = engine == .cloud ? VoiceDictationRules.providerOnCloud(current) : nil
        await setDictationProvider(provider, engine: engine)
    }

    /// The cloud recognizer's provider.
    func chooseDictationProvider(_ provider: VoiceProvider) async {
        await setDictationProvider(provider, engine: nil)
    }

    /// A provider (and the engine) in one PUT, shown at once; StepFun's first transcription row
    /// comes with it, in the same PUT when its list is here already, otherwise once it is.
    private func setDictationProvider(_ provider: VoiceProvider?, engine: DictationEngine?) async {
        var patch = UpdateDictationSettingsRequest(engine: engine)
        if let provider {
            patch.providerId = .set(provider.id)
            patch.modelId = suggested(for: provider).map { .set($0) }
        }
        await setDictation(patch)
        guard let provider, patch.modelId == nil, dictationFailure == nil else { return }
        await loadRemote(provider.id)
        guard let dictation = settings.value?.dictation, dictation.providerId == provider.id,
              (dictation.modelId ?? "").isEmpty, let model = suggested(for: provider) else { return }
        await setDictation(UpdateDictationSettingsRequest(modelId: .set(model)))
    }

    private func suggested(for provider: VoiceProvider) -> String? {
        VoiceDictationRules.suggestedModel(provider.kind, remote: remote[provider.id]?.value ?? [])
    }

    /// "Try it": a clip's text with the saved recognizer.
    func tryTranscription(_ wav: Data, language: String) async throws -> String {
        try await client().transcribe(wav: wav, language: language)
    }
}
