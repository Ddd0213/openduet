// The Voice page on a server before M27 (its answer has no providers and no presets): M13's page,
// the realtime model from GET /api/models (a Gemini or StepFun provider with a key) and its voice,
// or "No voice model yet" with "Open Models". Both save at once and roll back with the reason.
import SwiftUI

struct VoiceLegacyContent: View {
    var voice: VoiceSettingsModel
    var models: ModelsModel
    var onOpenModels: () -> Void

    var body: some View {
        switch models.state.display {
        case .failed(let reason):
            InlineRetryLine(reason: reason) { Task { await models.load() } }
                .cardSurface()
        case .loaded(let state):
            if let settings = voice.settings.value { content(settings, state) }
        case .loading:
            SettingsRowsSkeleton(rows: 2)
        }
    }

    @ViewBuilder private func content(_ settings: VoiceSettings, _ state: ModelsState) -> some View {
        let usable = VoiceModelRules.usableModels(state)
        if usable.isEmpty {
            noModel
        } else {
            let current = VoiceModelRules.current(settings, in: state)
            VStack(alignment: .leading, spacing: 0) {
                SheetSectionTitle(text: Text("Voice calls"))
                CardSection {
                    InlineChoiceRow(
                        title: Text("Voice model"),
                        current: current.map { Text(verbatim: $0.label) } ?? Text("Not set"),
                        options: usable.map { option($0, in: state) },
                        selection: current?.id ?? "",
                        busy: voice.busy,
                        onSelect: { id in Task { await voice.setModel(id) } }
                    )
                    InlineChoiceRow(
                        title: Text("Voice"),
                        current: VoiceModelRules.voice(settings, model: current, in: state).map { Text(verbatim: $0) } ?? Text("Default"),
                        options: [ChoiceOption(value: nil, title: Text("Default"))]
                            + VoiceModelRules.voices(settings, model: current, in: state).map { ChoiceOption(value: Optional($0), title: Text(verbatim: $0)) },
                        selection: VoiceModelRules.voice(settings, model: current, in: state),
                        busy: voice.busy,
                        onSelect: { name in Task { await voice.setVoice(name) } }
                    )
                }
                if let failure = voice.failure {
                    SettingsReasonLine(reason: failure)
                        .padding(.horizontal, 6)
                        .padding(.top, 8)
                        .transition(.opacity)
                }
                SettingsNote(text: Text("The voice listens and speaks; OpenDuet does the work. Start a call with the waveform in a chat."))
                    .padding(.top, 8)
                if VoiceModelRules.showsStepNote(state) {
                    SettingsNote(text: Text("StepFun has no short-lived keys, so during a call the phone holds this key in memory. Consider a separate key for OpenDuet."))
                        .padding(.top, 6)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: voice.failure)
            .sensoryFeedback(.warning, trigger: voice.failure) { _, new in new != nil }
        }
    }

    private var noModel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                DuetIcon(glyph: .notSetUp, size: 18, tint: Palette.needsInput)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("No voice model yet")
                        .font(.system(.body, weight: .semibold))
                        .foregroundStyle(Palette.primaryText)
                    Text("Voice calls need a realtime model from a Google Gemini or StepFun provider.")
                        .font(.subheadline)
                        .foregroundStyle(Palette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .combine)
            CapsuleButton(title: Text("Open Models"), style: .outline, fullWidth: false, action: onOpenModels)
        }
        .padding(16)
        .cardSurface()
    }

    private func option(_ model: ModelEntry, in state: ModelsState) -> ChoiceOption<String> {
        let provider = ModelCatalog.provider(model.providerId, in: state)
        return ChoiceOption(value: model.id, title: Text(verbatim: model.label), subtitle: provider.map { Text(verbatim: $0.name) })
    }
}
