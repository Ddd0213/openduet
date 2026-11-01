// The settings' "Voice" row (M16: the profile sheet's OpenDuet card, after Models): the realtime
// model voice calls run on, or "No voice model yet"; it opens the Voice page (VoicePage).
import SwiftUI

struct SettingsVoiceRow: View {
    var voice: VoiceSettingsModel
    var models: ModelsModel
    var onOpen: () -> Void

    var body: some View {
        SheetRow(title: Text("Voice"), subtitle: line, action: onOpen) {
            RowSymbol(systemImage: "waveform")
        } trailing: {
            RowChevron()
        }
    }

    private var line: Text? {
        guard let settings = voice.settings.value else { return nil }
        // M27: the voice settings name the model themselves (GET /api/models isn't needed).
        if VoicePageRules.layout(settings) == .current {
            guard let current = VoiceModelRules.current(settings) else { return Text("No voice model yet") }
            return Text(verbatim: current.model.label)
        }
        guard let state = models.state.value else { return nil }
        guard let model = VoiceModelRules.current(settings, in: state) else { return Text("No voice model yet") }
        return Text(verbatim: model.label)
    }
}
