// M27 the Voice page's Speech recognition section (the composer microphone): Recognizer iPhone /
// Cloud. iPhone: "Only on this iPhone" (requiresOnDeviceRecognition). Cloud: Provider (the Gemini /
// StepFun providers with a key; none: a line pointing up to the key), Model (the provider's
// transcription rows first, then the rest, and "Type a model id…" in place), "Try it" (3 s, the
// text shown here) or why it can't be used yet. Every change is PUT {dictation} at once and rolls
// back with the reason.
import SwiftUI

struct VoiceDictationSection: View {
    var voice: VoiceSettingsModel
    var settings: VoiceSettings

    /// "Type a model id…" is open, with what's typed so far
    @State private var typing = false
    @State private var typed = ""
    @State private var trial = VoiceDictationTrial()

    private var dictation: DictationSettings { settings.dictation }
    private var rows: [VoiceDictationRow] { VoiceDictationRules.rows(settings) }
    private var provider: VoiceProvider? {
        dictation.providerId.flatMap { id in settings.providers.first { $0.id == id } }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetSectionTitle(text: Text("Speech recognition"))
            VStack(alignment: .leading, spacing: 8) {
                CardSection {
                    recognizerRow
                    if rows.contains(.onDeviceOnly) { onDeviceRow }
                    if rows.contains(.provider) { providerRow }
                    if rows.contains(.model) { modelRow }
                    if rows.contains(.model), typing { typedModelField }
                    if rows.contains(.tryIt) { tryRow }
                }
                if let failure = voice.dictationFailure {
                    SettingsReasonLine(reason: failure)
                        .padding(.horizontal, 6)
                        .transition(.opacity)
                }
                if case .failed(let reason) = trial.phase, rows.contains(.tryIt) {
                    SettingsReasonLine(reason: reason)
                        .padding(.horizontal, 6)
                        .transition(.opacity)
                }
                notes
            }
        }
        .animation(.easeInOut(duration: 0.2), value: rows)
        .animation(.easeInOut(duration: 0.2), value: typing)
        .animation(.easeInOut(duration: 0.2), value: voice.dictationFailure)
        .animation(.easeInOut(duration: 0.2), value: trial.phase)
        .sensoryFeedback(.warning, trigger: voice.dictationFailure) { _, new in new != nil }
        // The cloud provider's own list (the Model row's options).
        .task(id: remoteKey) {
            guard rows.contains(.model), let provider, provider.key.set else { return }
            await voice.loadRemote(provider.id)
        }
        .onChange(of: dictation.providerId) { _, _ in
            typing = false
            trial.cancel()
        }
        .onChange(of: rows.contains(.tryIt)) { _, ready in
            if !ready { trial.cancel() }
        }
        .onDisappear { trial.cancel() }
    }

    private var remoteKey: String {
        "\(dictation.engine.rawValue):\(provider?.id ?? ""):\(provider?.key.set ?? false)"
    }

    // MARK: - Recognizer

    private var recognizerRow: some View {
        InlineChoiceRow(
            title: Text("Recognizer"),
            current: Text(dictation.engine.label),
            options: DictationEngine.allCases.map { engine in
                ChoiceOption(value: engine, title: Text(engine.label), subtitle: engineLine(engine))
            },
            selection: dictation.engine,
            busy: voice.dictationBusy,
            onSelect: { engine in Task { await voice.setDictationEngine(engine) } }
        )
    }

    private func engineLine(_ engine: DictationEngine) -> Text {
        switch engine {
        case .device: Text("Apple's speech recognition")
        case .cloud: Text("A Google Gemini or StepFun model, with your key")
        }
    }

    private var onDeviceRow: some View {
        SettingsToggleRow(
            title: Text("Only on this iPhone"),
            subtitle: Text("Audio never leaves the iPhone. Some languages need a download in iOS Settings first."),
            on: dictation.onDeviceOnly,
            busy: voice.dictationBusy,
            onChange: { on in Task { await voice.setDictation(UpdateDictationSettingsRequest(onDeviceOnly: on)) } }
        )
        .disabled(voice.dictationBusy)
    }

    // MARK: - Cloud: provider and model

    private var providerRow: some View {
        let keyed = VoiceDictationRules.providers(settings)
        return InlineChoiceRow(
            title: Text("Provider"),
            current: provider.map { Text(verbatim: $0.name) } ?? Text("Not set"),
            options: keyed.map { option in
                ChoiceOption(value: Optional(option.id), title: Text(verbatim: option.name), subtitle: option.region.map { Text($0.label) })
            },
            selection: dictation.providerId,
            busy: voice.dictationBusy,
            onSelect: { id in
                guard let picked = keyed.first(where: { $0.id == id }) else { return }
                typing = false
                Task { await voice.chooseDictationProvider(picked) }
            }
        )
    }

    private enum ModelPick: Hashable {
        case model(String)
        case type
        /// the selection while no model is set (never offered)
        case unset
    }

    private var remoteRows: Loadable<[RemoteModel]>? {
        provider.flatMap { voice.remote[$0.id] }
    }

    @ViewBuilder private var modelRow: some View {
        let enabled = provider?.key.set == true
        let choices = VoiceDictationRules.modelChoices(remoteRows?.value ?? [], saved: dictation.modelId)
        let current = dictation.modelId.flatMap { id in choices.first { $0.modelId == id } }
        InlineChoiceRow(
            title: Text("Model"),
            current: current.map { Text(verbatim: $0.label) } ?? Text("Not set"),
            options: enabled ? modelOptions(choices) : [],
            selection: dictation.modelId.map(ModelPick.model) ?? .unset,
            busy: voice.dictationBusy || remoteRows?.loading == true,
            failure: remoteRows?.failure,
            onSelect: { pick in
                switch pick {
                case .model(let id):
                    typing = false
                    Task { await voice.setDictation(UpdateDictationSettingsRequest(modelId: .set(id))) }
                case .type:
                    typed = dictation.modelId ?? ""
                    typing = true
                case .unset:
                    break
                }
            }
        )
        .opacity(enabled ? 1 : 0.45)
        .allowsHitTesting(enabled)
    }

    private func modelOptions(_ choices: [DictationModelChoice]) -> [ChoiceOption<ModelPick>] {
        let listed = choices.map { choice in
            ChoiceOption(value: ModelPick.model(choice.modelId), title: Text(verbatim: choice.label), subtitle: modelLine(choice))
        }
        return listed + [ChoiceOption(value: ModelPick.type, title: Text("Type a model id…"))]
    }

    private func modelLine(_ choice: DictationModelChoice) -> Text? {
        var parts: [String] = []
        if choice.label != choice.modelId { parts.append(choice.modelId) }
        if choice.transcription { parts.append(String(localized: "Speech to text")) }
        return parts.isEmpty ? nil : Text(verbatim: parts.joined(separator: " · "))
    }

    private var typedModelField: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsField(
                label: Text("Model id"), text: $typed, limit: 200, monospaced: true, plain: true,
                footnote: Text("Checked the first time it transcribes.")
            )
            HStack(spacing: 10) {
                Spacer(minLength: 0)
                CapsuleButton(title: Text("Cancel"), style: .outline, fullWidth: false) { typing = false }
                CapsuleButton(title: Text("Use"), busy: voice.dictationBusy, fullWidth: false, action: saveTyped)
                    .disabled(VoiceDictationRules.typedModel(typed) == nil || voice.dictationBusy)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
        .transition(.opacity)
    }

    private func saveTyped() {
        guard let id = VoiceDictationRules.typedModel(typed) else { return }
        Task {
            await voice.setDictation(UpdateDictationSettingsRequest(modelId: .set(id)))
            if voice.dictationFailure == nil { typing = false }
        }
    }

    // MARK: - Cloud: Try it

    private var tryRow: some View {
        SheetRow(
            title: Text("Try it"),
            subtitle: trialLine,
            action: trial.busy || voice.dictationBusy ? nil : { trial.run(voice) }
        ) {
            if trial.busy {
                BusySpinner(busy: true)
            } else {
                DuetIcon(glyph: .dictate, size: 18, tint: Palette.secondaryText)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .sensoryFeedback(.success, trigger: trial.phase) { _, new in
            if case .heard = new { return true }
            return false
        }
    }

    private var trialLine: Text {
        switch trial.phase {
        case .idle, .failed: Text("Records 3 seconds and shows the text")
        case .recording: Text("Listening… speak now")
        case .transcribing: Text("Transcribing…")
        case .heard(let words): Text(verbatim: "“\(words)”")
        case .nothingHeard: Text("Nothing was heard.")
        }
    }

    // MARK: - Notes

    @ViewBuilder private var notes: some View {
        if rows.contains(.needsKey) {
            SettingsNote(text: Text("Cloud recognition uses a Google Gemini or StepFun key. Add one under Realtime voice above."))
        }
        if rows.contains(.notReady), let line = VoiceDictationRules.notReadyLine(settings) {
            SettingsNote(text: Text(verbatim: line))
        }
        if dictation.engine == .cloud {
            SettingsNote(text: Text("Up to 2 minutes a recording. Your server passes it to the provider on your key and keeps neither the audio nor the text."))
        }
    }
}
