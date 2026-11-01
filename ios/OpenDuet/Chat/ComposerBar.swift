// The floating composer (prompt L92, L95, L179): "+" | text | mic | a filled waveform circle
// (black in light, white in dark). "+" opens Photos / Camera / Files; picked items sit above the
// text as thumbnails. Sending clears the draft at once, with a light haptic.
// M8 (decided by the user, changes L92): the waveform turns into ↑ as soon as the field has ANY
// text, an uncommitted pinyin candidate included (↑ commits it, then sends all of it), or an
// uploaded attachment. A swipe-right quote shows as a chip above the field (ComposerState.replyTo).
// M10: while the assistant replies here (ComposerState.replying) the empty circle is ■ in a turning
// hand-drawn ring (StopButton.swift): a tap stops the reply (ShellActions.stop); with text it
// stays ↑ and the message queues. A failed stop's reason shows above the capsule for a moment.
// M13: with nothing typed and the assistant idle the waveform starts a voice call in `callChannelId`
// (the `\.call` session; dictation stops first, they share the microphone). During a call it's
// the call's live waveform and a tap ends the call; ↑ and ■ still win. Why a call didn't start
// shows above the capsule (CallNoteLine); the mic is off while a call is on.
// M23: the newest open Up next suggestion floats above it all (ComposerSuggestionStack, Start /
// Hide, swipe right / left) while nobody is writing: focusing the field, typing, an attachment,
// a quote or the skills list puts it away.
import Accessibility
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ComposerBar: View {
    @Binding var draft: String
    @Binding var isFocused: Bool
    var placeholder: LocalizedStringResource
    var composer: ComposerState
    var actions: ShellActions
    /// "+" (Photos / Camera / Files); task detail replies hide it until they can send files.
    var allowsAttachments = true
    /// M6 (L156): "/" or "／" opens the skills list; the chosen skill rides with the message.
    var allowsSkills = false
    /// M13: the channel a voice call starts in (nil in a task's thread: calls are per channel).
    var callChannelId: String? = nil
    /// M23: the newest open Up next suggestions, floated above the composer (the chat's composer
    /// passes ComposerUpNext(state:); a task's thread none).
    var upNext = ComposerUpNext()
    /// After a send: the shell jumps the thread to the bottom.
    var onSent: () -> Void

    @Environment(\.call) private var call
    @Environment(\.chatExtras) private var extras
    @Environment(\.apiClient) private var api
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var skill: String?
    @State private var dictation = Dictation()
    @State private var dictationBase = ""
    /// M27: where the cursor was when a cloud recording started (UTF-16 offset)
    @State private var dictationCaret: Int?
    @State private var isComposing = false
    @State private var resetToken = 0
    @State private var textHandle = ComposerTextHandle()
    @State private var sends = 0
    @State private var picks = 0
    @State private var stops = 0
    /// M13: a note of this composer's own (a task's thread, or no session in previews).
    @State private var localNote: CallNote?
    @State private var callTaps = 0
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showCamera = false

    private static let actionSize: CGFloat = 36
    private static let inset: CGFloat = 6
    private static let minHeight = actionSize + inset * 2

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var uploadedIds: [UUID] {
        composer.attachments.compactMap { if case .uploaded = $0.upload { $0.id } else { nil } }
    }
    /// The ↑ shows for any text (a candidate being composed included) or an uploaded file.
    private var hasContent: Bool {
        ComposerRules.showsSend(committed: draft, hasMarkedText: isComposing, hasUploads: !uploadedIds.isEmpty)
    }
    /// Uploading or failed attachments hold the send back.
    private var canSend: Bool {
        ComposerRules.canSend(
            committed: draft, hasMarkedText: isComposing, hasUploads: !uploadedIds.isEmpty,
            attachmentsReady: composer.canSendAttachments
        )
    }
    /// What follows "/" while the skills list is open (none once a skill is chosen).
    private var skillQuery: String? {
        guard allowsSkills, skill == nil else { return nil }
        return SkillQuery.trigger(in: draft, isComposing: isComposing)
    }

    /// M23: the Up next card's place above the capsule is free (nobody is writing).
    private var showsUpNext: Bool {
        ComposerSuggestionRules.isVisible(
            hasContent: hasContent, focused: isFocused, hasAttachments: !composer.attachments.isEmpty,
            quoting: composer.replyTo != nil, pickingSkill: skillQuery != nil || skill != nil
        )
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsUpNext {
                ComposerSuggestionStack(upNext: upNext, tasks: actions.tasks)
                    .transition(riseIn)
            }
            if let skillQuery {
                SkillPicker(extras: extras, query: skillQuery, onPick: pick, onRetry: actions.chatExtras.loadSkills)
                    .transition(riseIn)
            }
            dictationLine
            if let reason = composer.stopFailure {
                stopFailureLine(reason)
                    .transition(.opacity)
            }
            if let note = shownNote {
                CallNoteLine(note: note) { call?.openVoiceSettings() }
                    .transition(.opacity)
            }
            if let quote = composer.replyTo {
                QuoteChip(quote: quote) { actions.setReplyTo(nil) }
                    .transition(riseIn)
            }
            VStack(alignment: .leading, spacing: 0) {
                if !composer.attachments.isEmpty {
                    AttachmentTray(attachments: composer.attachments, onRemove: actions.removeAttachment, onRetry: actions.retryAttachment)
                        .transition(riseIn)
                }
                if let skill {
                    SkillChip(name: skill) { self.skill = nil }
                        .padding(.leading, 8)
                        .padding(.top, 2)
                        .transition(riseIn)
                }
                HStack(alignment: .bottom, spacing: 2) {
                    if allowsAttachments {
                        attachMenu
                    } else {
                        Spacer().frame(width: 10)
                    }
                    ComposerTextView(
                        text: $draft, isFocused: $isFocused, isComposing: $isComposing,
                        placeholder: placeholder, resetToken: resetToken, handle: textHandle,
                        // M29: pasted images go where "+" puts them (only where "+" is shown).
                        onPasteImages: allowsAttachments ? pasteImages : nil
                    )
                        .frame(minHeight: Self.actionSize)
                        .overlay(alignment: .leading) {
                            if draft.isEmpty && !isComposing {
                                Text(placeholder)
                                    .font(.body)
                                    .foregroundStyle(Palette.secondaryText)
                                    .lineLimit(1)
                                    .allowsHitTesting(false)
                                    .accessibilityHidden(true)
                            }
                        }
                    micButton
                    actionButton
                }
            }
            .padding(Self.inset)
            .frame(minHeight: Self.minHeight)
            // Glass on iOS 26, the opaque floating fill on iOS 18 (Theme/Glass.swift).
            .chromeSurface(RoundedRectangle(cornerRadius: Self.minHeight / 2, style: .continuous))
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.35, dampingFraction: 0.85), value: composer.attachments.map(\.id))
        .animation(.easeInOut(duration: 0.2), value: hasContent)
        .animation(.easeInOut(duration: 0.25), value: dictation.note)
        .animation(.easeInOut(duration: 0.2), value: dictation.phase)
        .animation(.easeInOut(duration: 0.2), value: skillQuery != nil)
        .animation(.easeInOut(duration: 0.2), value: skill)
        .animation(.easeInOut(duration: 0.25), value: shownNote)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.35, dampingFraction: 0.86), value: showsUpNext)
        .animation(.easeInOut(duration: 0.25), value: composer.stopFailure)
        // M10: light for the tap on ■, a warning when the stop failed (read out by VoiceOver).
        .sensoryFeedback(.impact(weight: .light), trigger: stops)
        .sensoryFeedback(.warning, trigger: composer.stopFailure) { _, now in now != nil }
        .onChange(of: composer.stopFailure) { _, reason in
            guard let reason else { return }
            AccessibilityNotification.Announcement(String(localized: "Couldn't stop: \(reason)")).post()
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.35, dampingFraction: 0.85), value: composer.replyTo)
        // The list loads (again) each time it opens.
        .onChange(of: skillQuery != nil) { _, open in if open { actions.chatExtras.loadSkills() } }
        // A new quote (swipe right) puts the caret in the field.
        .onChange(of: composer.replyTo) { _, quote in if quote != nil { isFocused = true } }
        // Typing (or dictating) hides the call's note; one with a button stays a little longer.
        .onChange(of: hasContent) { _, has in if has { clearNote() } }
        .task(id: shownNote) {
            guard let note = shownNote else { return }
            let lasts: Double = switch note {
            case .setup, .microphone: 8
            default: 5
            }
            try? await Task.sleep(for: .seconds(lasts))
            if !Task.isCancelled { clearNote() }
        }
        .onChange(of: shownNote) { _, note in
            guard let note else { return }
            AccessibilityNotification.Announcement(note.text).post()
        }
        .sensoryFeedback(.impact(weight: .light), trigger: sends)
        .sensoryFeedback(.impact(weight: .light), trigger: picks)
        .sensoryFeedback(.impact(weight: .medium), trigger: callTaps)
        .sensoryFeedback(.warning, trigger: shownNote) { _, now in now != nil }
        .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: 10, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { add(await AttachmentLoader.photos(items)) }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            Task { add(await AttachmentLoader.files(urls)) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                showCamera = false
                guard let image else { return }
                Task { if let file = await AttachmentLoader.camera(image) { add([file]) } }
            }
            .ignoresSafeArea()
        }
    }

    var body: some View {
        dictationHooks(content)
    }

    /// The dictation's hooks, apart from `content` (one expression each for the type checker).
    private func dictationHooks(_ content: some View) -> some View {
        content
            .onChange(of: dictation.transcript) { _, heard in
                guard dictation.isRecording else { return }
                draft = dictationBase.isEmpty || heard.isEmpty ? dictationBase + heard : dictationBase + " " + heard
            }
            // M27: the cloud recognizer's text goes where the cursor was when recording started.
            .onChange(of: dictation.insertion) { _, insertion in
                guard let insertion else { return }
                insertDictated(insertion.text)
            }
            .task(id: dictation.note) {
                guard let lasts = dictation.note?.lasts else { return }
                try? await Task.sleep(for: .seconds(lasts))
                if !Task.isCancelled { dictation.note = nil }
            }
            // M27: the mic follows the settings' recognizer (the profile cache's answers, or one load).
            .task(id: apiIdentity) {
                dictation.api = api
                await DictationSettingsStore.shared.refresh(api)
            }
            // A cleared draft drops a failed recording kept for Retry; leaving the thread drops all.
            .onChange(of: draft.isEmpty) { _, empty in if empty { dictation.clearKept() } }
            .onChange(of: callChannelId) { _, _ in dictation.leave() }
            .onDisappear { dictation.leave() }
    }

    private var apiIdentity: ObjectIdentifier? {
        api.map { ObjectIdentifier($0) }
    }

    /// M27: why dictation stopped (Retry / Voice / Settings), or a cloud clip's progress.
    @ViewBuilder private var dictationLine: some View {
        if let note = dictation.note {
            DictationNoteLine(
                note: note, onRetry: { dictation.retry() }, onVoice: { actions.openVoice() }, alignment: .leading
            )
            .transition(.opacity)
        } else if DictationStatusLine.shows(dictation) {
            DictationStatusLine(dictation: dictation, alignment: .leading)
                .transition(.opacity)
        }
    }

    /// The skills list, the tray and the chip rise in from the composer; Reduce Motion fades them.
    private var riseIn: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom))
    }

    // MARK: - Controls

    private var attachMenu: some View {
        Menu {
            Button { showPhotos = true } label: { Label { Text("Photos") } icon: { Image(glyph: .photos) } }
            Button { showCamera = true } label: { Label { Text("Camera") } icon: { Image(glyph: .camera) } }
                .disabled(!CameraPicker.isAvailable)
            Button { showFiles = true } label: { Label { Text("Files") } icon: { Image(glyph: .fileList) } }
        } label: {
            glyph(.add)
        }
        .accessibilityLabel(Text("Add attachment"))
    }

    private var micButton: some View {
        Button { Task { await toggleDictation() } } label: {
            // M27 (the user's call): no orange. Recording: the mic in the text colour on the grey
            // disc the composer's chips use; a cloud clip being transcribed: a small spinner.
            ZStack {
                if dictation.isTranscribing {
                    ProgressView().controlSize(.small).tint(Palette.secondaryText)
                } else {
                    DuetIcon(glyph: .dictate, size: 24, tint: Palette.primaryText)
                }
            }
                .frame(width: Self.actionSize, height: Self.actionSize)
                .background(Circle().fill(Palette.tile.opacity(dictation.isRecording ? 1 : 0)))
                .animation(.easeInOut(duration: 0.2), value: dictation.phase)
                .contentShape(Circle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.88))
        // M13: the call has the microphone.
        .disabled(inCall || dictation.isTranscribing)
        .opacity(inCall ? 0.35 : 1)
        .animation(.easeInOut(duration: 0.2), value: inCall)
        .accessibilityLabel(micLabel)
    }

    private var micLabel: Text {
        switch dictation.phase {
        case .recording: Text("Stop dictation")
        case .transcribing: Text("Transcribing…")
        case .idle: Text("Dictate")
        }
    }

    /// M10: what the circle does: the waveform (M13: a voice call; the call's live waveform while
    /// one is on, a tap ends it), ■ while the assistant replies with nothing typed, or ↑ when there is
    /// something to send (it queues).
    private var action: ComposerAction {
        ComposerAction.make(hasContent: hasContent, replying: composer.replying, inCall: inCall)
    }

    /// M13: a call is open (connecting, live or reconnecting).
    private var inCall: Bool { call?.isLive == true }

    /// The call's note, or this composer's own.
    private var shownNote: CallNote? { localNote ?? call?.note }

    /// The filled circle; its glyph morphs (crossfade + a small scale, Reduce Motion: crossfade).
    private var actionButton: some View {
        Button {
            switch action {
            case .send: send()
            case .stop: stop()
            case .voice: startCall()
            case .endCall: endCall()
            }
        } label: {
            ZStack {
                switch action {
                case .voice:
                    // The waveform is content (the line set); ↑ stays the chrome send arrow.
                    DuetIcon(glyph: .voice, size: 22, tint: Palette.background)
                        .transition(morph)
                case .endCall:
                    if let call {
                        LiveCallWaveform(call: call, tint: Palette.background)
                            .transition(morph)
                    }
                case .stop:
                    StopGlyph(size: 30, tint: Palette.background)
                        .transition(morph)
                case .send:
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Palette.background)
                        .accessibilityHidden(true)
                        .transition(morph)
                }
            }
                .frame(width: Self.actionSize, height: Self.actionSize)
                .background(Circle().fill(Palette.composerAction))
                .opacity(action == .send && !canSend ? 0.4 : 1)
                .contentShape(Circle())
                .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.3, dampingFraction: 0.8), value: action)
        }
        .buttonStyle(PressableButtonStyle(scale: 0.9))
        .disabled(action == .send && !canSend)
        .accessibilityLabel(actionLabel)
    }

    private var morph: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.6))
    }

    private var actionLabel: Text {
        switch action {
        case .send: Text("Send")
        case .stop: Text("Stop responding")
        case .voice: Text("Start a voice call")
        case .endCall: Text("End call")
        }
    }

    /// M10: why ■ didn't stop the reply (a 409 never shows: nothing was running any more).
    private func stopFailureLine(_ reason: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            DuetIcon(glyph: .warning, size: 14, tint: Palette.failure)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            Text("Couldn't stop: \(reason)")
                .font(Typography.caption)
                .foregroundStyle(Palette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.horizontal, 12)
    }

    private func glyph(_ glyph: DuetGlyph) -> some View {
        DuetIcon(glyph: glyph, size: 24, tint: Palette.primaryText)
            .frame(width: Self.actionSize, height: Self.actionSize)
            .contentShape(Circle())
    }

    // MARK: - Actions

    private func send() {
        guard canSend else { return }
        // Apple's stops; a cloud clip still goes (its text lands after); a kept one is dropped.
        dictation.send()
        // A candidate still being composed is committed first, then everything visible goes.
        let visible = isComposing ? textHandle.commit() : nil
        isComposing = false
        if let visible { draft = visible }
        let text = ComposerRules.outgoingText(committed: draft, visible: visible)
        // Only whitespace was composed: nothing to send, the field keeps it.
        guard !text.isEmpty || !uploadedIds.isEmpty else { return }
        if let skill, !text.isEmpty {
            actions.chatExtras.sendWithSkill(text, skill, uploadedIds)
            self.skill = nil
        } else {
            actions.send(text, uploadedIds)
        }
        draft = ""
        resetToken += 1
        sends += 1
        isFocused = false
        onSent()
    }

    /// M10: ■: stop the assistant's reply in this thread (the store hides the typing at once).
    private func stop() {
        stops += 1
        clearNote()
        actions.stop()
    }

    /// M13: the waveform with nothing typed: a voice call in this channel. Dictation stops first
    /// (they share the microphone); the session checks the setup and the permission.
    private func startCall() {
        localNote = nil
        guard let call else {
            localNote = .failed(String(localized: "Voice calls aren't available here."))
            return
        }
        guard let channelId = callChannelId else {
            localNote = .channelOnly
            return
        }
        dictation.stop()
        isFocused = false
        callTaps += 1
        call.start(channelId: channelId)
    }

    /// M13: the call's waveform: hang up (nothing to confirm: it's a call).
    private func endCall() {
        callTaps += 1
        call?.end()
    }

    private func clearNote() {
        localNote = nil
        call?.clearNote()
    }

    private func toggleDictation() async {
        if !dictation.isRecording {
            dictationBase = trimmed
            dictationCaret = caretOffset
        }
        await dictation.toggle()
    }

    /// M27: the cursor's place in the committed text (the end while a candidate is composed).
    private var caretOffset: Int? {
        guard let view = textHandle.view, view.markedTextRange == nil, view.text == draft else { return nil }
        let range = view.selectedRange
        return range.location == NSNotFound ? nil : range.location + range.length
    }

    /// M27: the cloud recognizer's text where the cursor was; the cursor goes after it.
    private func insertDictated(_ heard: String) {
        let result = DictationInsertion.insert(heard, into: draft, at: dictationCaret)
        draft = result.text
        dictationCaret = result.caret
        Task { @MainActor in
            guard let view = textHandle.view, view.text == result.text else { return }
            view.selectedRange = NSRange(location: min(result.caret, (view.text as NSString).length), length: 0)
        }
    }

    /// A skill from the "/" list: its chip replaces the typed "/query".
    private func pick(_ chosen: Skill) {
        picks += 1
        skill = chosen.name
        draft = ""
        resetToken += 1
        isFocused = true
    }

    private func add(_ files: [PickedFile]) {
        guard !files.isEmpty else { return }
        picks += 1
        actions.addAttachments(files)
    }

    /// M29: Paste with images on the pasteboard (ComposerUITextView): the same tray, limits and
    /// failure lines as "+" (AttachmentLoader.pasted, then `add`).
    private func pasteImages(_ providers: [NSItemProvider]) {
        Task { add(await AttachmentLoader.pasted(providers)) }
    }
}
