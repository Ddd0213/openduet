// The settings' Voice page (M27: Codync's order, data from GET /api/voice-settings only):
// Realtime voice (Provider, StepFun's Region, the key in three states, Model, Voice; grey without a
// key), Speech recognition (the composer microphone: iPhone / Cloud) and whose key pays. A provider
// is the same row Models shows (one key for both pages), so the page loads again each time it
// appears. An older server (no providers, no presets) gets M13's page (VoiceLegacyContent).
// Everything saves at once and rolls back with the reason, in place (no alerts).
import SwiftUI

struct VoicePage: View {
    var voice: VoiceSettingsModel
    var models: ModelsModel
    var onBack: () -> Void
    /// The older server's hint: "Open Models".
    var onOpenModels: () -> Void

    /// The Provider row's pick (nil: the page's default)
    @State private var picked: VoiceProviderChoice?

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: Text("Voice"), leading: .back, onLeading: onBack)
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    switch voice.settings.display {
                    case .failed(let reason):
                        InlineRetryLine(reason: reason) { reload() }
                            .cardSurface()
                    case .loaded(let settings):
                        switch VoicePageRules.layout(settings) {
                        case .current: current(settings)
                        case .legacy: VoiceLegacyContent(voice: voice, models: models, onOpenModels: onOpenModels)
                        }
                    case .loading:
                        SettingsRowsSkeleton(rows: 3)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await load() }
        }
        // Keys may have been added or changed in Models since: the page loads again each time.
        .task { await load() }
    }

    @ViewBuilder private func current(_ settings: VoiceSettings) -> some View {
        let choice = VoicePageRules.choice(picked, in: settings)
        VoiceRealtimeSection(voice: voice, settings: settings, choice: choice, onPick: { picked = $0 })
        VoiceDictationSection(voice: voice, settings: settings)
        if let choice, let kind = VoicePageRules.kind(choice, in: settings) {
            SettingsNote(text: Text(verbatim: VoicePageRules.billingLine(kind)))
        }
    }

    private func load() async {
        voice.forgetRemote()
        await voice.load()
        // Only M13's page reads GET /api/models.
        if let settings = voice.settings.value, VoicePageRules.layout(settings) == .legacy { await models.load() }
    }

    private func reload() {
        Task { await load() }
    }
}
