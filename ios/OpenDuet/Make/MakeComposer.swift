// The Make composer (prompt L147, L149): the type chip, the prompt field ("Describe what to
// build", or the hero's auto-typed idea), an optional mic (dictation, as in chat) and the round
// ↑, which turns orange once there is text. While Create runs the ↑ shows a spinner; a failure
// shows its reason above the capsule.
import SwiftUI

struct MakeComposer: View {
    var type: ArtifactType
    @Binding var text: String
    var placeholder: Text
    /// The hero's idea as typed so far into the placeholder; nil shows `placeholder`.
    var typedIdea: String? = nil
    /// With nothing typed, ↑ sends this whole idea (the hero card); nil needs text.
    var fullIdea: String? = nil
    var allowsDictation = false
    var request: CardRequest?
    var focused: FocusState<Bool>.Binding
    var onSend: (_ prompt: String) -> Void

    @State private var dictation = Dictation()
    @State private var dictationBase = ""
    @Environment(\.apiClient) private var api
    @State private var sends = 0
    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 17
    @ScaledMetric(relativeTo: .subheadline) private var noteSize: CGFloat = 14

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var busy: Bool { request == .inFlight }
    private var canSend: Bool { !busy && (!trimmed.isEmpty || !(fullIdea ?? "").isEmpty) }
    /// The ↑ turns orange with typed text (an idea on show leaves it grey but tappable).
    private var lit: Bool { busy || !trimmed.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let reason = request?.failureReason {
                HStack(alignment: .center, spacing: 6) {
                    DuetIcon(glyph: .warning, size: noteSize + 3, tint: Palette.failure)
                    Text(verbatim: reason).foregroundStyle(Palette.secondaryText)
                }
                .font(.system(size: noteSize))
                .padding(.horizontal, 6)
                .transition(.opacity)
            } else if let note = dictation.note {
                // M27: the chat's recognizer and notes (Retry; no Voice link from Make's sheet).
                DictationNoteLine(note: note, onRetry: { dictation.retry() }, onVoice: nil, alignment: .leading)
                    .padding(.horizontal, -6)
                    .transition(.opacity)
            } else if DictationStatusLine.shows(dictation) {
                DictationStatusLine(dictation: dictation, alignment: .leading)
                    .padding(.horizontal, -6)
                    .transition(.opacity)
            }
            VStack(alignment: .leading, spacing: 10) {
                ArtifactTypeChip(type: type)
                    .id(type)
                    .transition(.opacity)
                HStack(alignment: .bottom, spacing: 8) {
                    field
                    if allowsDictation { micButton }
                    sendButton
                }
            }
            .padding(12)
            .chromeSurface(RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
        .animation(.easeInOut(duration: 0.25), value: type)
        .animation(.easeInOut(duration: 0.2), value: canSend)
        .animation(.easeInOut(duration: 0.25), value: request)
        .sensoryFeedback(.impact(weight: .light), trigger: sends)
        .sensoryFeedback(.warning, trigger: request) { _, new in new?.failureReason != nil }
        .onChange(of: dictation.transcript) { _, heard in
            guard dictation.isRecording else { return }
            text = dictationBase.isEmpty || heard.isEmpty ? dictationBase + heard : dictationBase + " " + heard
        }
        // M27: the cloud recognizer's text goes at the end (the field has no cursor to read).
        .onChange(of: dictation.insertion) { _, insertion in
            guard let insertion else { return }
            text = DictationInsertion.insert(insertion.text, into: text, at: nil).text
        }
        .task(id: dictation.note) {
            guard let lasts = dictation.note?.lasts else { return }
            try? await Task.sleep(for: .seconds(lasts))
            if !Task.isCancelled { dictation.note = nil }
        }
        .task(id: api.map(ObjectIdentifier.init)) {
            guard allowsDictation else { return }
            dictation.api = api
            await DictationSettingsStore.shared.refresh(api)
        }
        .onChange(of: text.isEmpty) { _, empty in if empty { dictation.clearKept() } }
        .animation(.easeInOut(duration: 0.25), value: dictation.note)
        .animation(.easeInOut(duration: 0.2), value: dictation.phase)
        .onDisappear { dictation.leave() }
    }

    private var field: some View {
        TextField(text: $text, axis: .vertical) {
            if let typedIdea { Text(verbatim: typedIdea) } else { placeholder }
        }
        .font(.system(size: fontSize))
        .foregroundStyle(Palette.primaryText)
        .lineLimit(1...5)
        .focused(focused)
        .frame(minHeight: 36)
        .accessibilityLabel(placeholder)
    }

    private var micButton: some View {
        Button {
            Task {
                if !dictation.isRecording { dictationBase = trimmed }
                await dictation.toggle()
            }
        } label: {
            // M27: as the chat composer's mic: no orange; the grey disc while recording.
            ZStack {
                if dictation.isTranscribing {
                    ProgressView().controlSize(.small).tint(Palette.secondaryText)
                } else {
                    DuetIcon(glyph: .dictate, size: 23, tint: Palette.primaryText)
                }
            }
                .frame(width: 36, height: 36)
                .background(Circle().fill(Palette.tile.opacity(dictation.isRecording ? 1 : 0)))
                .animation(.easeInOut(duration: 0.2), value: dictation.phase)
                .contentShape(Circle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.88))
        .disabled(dictation.isTranscribing)
        .accessibilityLabel(micLabel)
    }

    private var micLabel: Text {
        switch dictation.phase {
        case .recording: Text("Stop dictation")
        case .transcribing: Text("Transcribing…")
        case .idle: Text("Dictate")
        }
    }

    private var sendButton: some View {
        Button(action: send) {
            ZStack {
                Circle().fill(lit ? Palette.fab : Palette.composerAction)
                    .opacity(canSend || busy ? 1 : 0.25)
                if busy {
                    ProgressView().tint(.white).controlSize(.small)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(lit ? Color.white : Palette.background)
                }
            }
            .frame(width: 36, height: 36)
            .contentShape(Circle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.9))
        .disabled(!canSend)
        .accessibilityLabel(Text("Make it"))
        .accessibilityValue(busy ? Text("In progress") : Text(verbatim: ""))
    }

    private func send() {
        guard canSend else { return }
        // A cloud clip still being recorded isn't wanted once Make it starts: nothing is sent.
        dictation.leave()
        let prompt = trimmed.isEmpty ? (fullIdea ?? "") : trimmed
        sends += 1
        focused.wrappedValue = false
        onSend(prompt)
    }
}
